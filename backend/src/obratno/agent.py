"""ReAct-агент над доменом: рассуждает шагами, считает домен.

RU: Модель выбирает инструменты и порядок действий, но ни одно время, расстояние и цена
    не приходят от неё: числа возвращают функции домена по данным Tutu. Поэтому агент
    может ошибиться в выборе города, но не может выдумать расписание.
EN: The model picks tools and their order, yet no time, distance or price comes from it:
    every number is returned by domain functions over Tutu data. The agent may pick a poor
    city, but it cannot invent a timetable.
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

import httpx

MAX_STEPS = 6
TIMEOUT_S = 45.0

SYSTEM = """Ты помощник в продукте «Обратно». Продукт отвечает на один вопрос: куда съездить,
чтобы успеть вернуться домой к заданному времени, и сколько часов там получится провести.

Правила, нарушать которые нельзя:
1. Никогда не называй время, цену, номер поезда или город по памяти. Всё это возвращают
   инструменты. Если инструмент не дал числа, так и скажи.
2. Если пользователь меняет условия (во сколько дома, сколько побыть, бюджет, дата,
   ночёвки), сначала вызови set_params, затем пересчитай.
3. Чтобы выбрать город, вызови list_options и опирайся на его ответ.
4. Выбрав город, обязательно вызови plan_station по нему: без этого маршрута нет.
   Для ночёвки вызывай stay_plan, если вернуться нельзя, вызови escape.
5. Ответ пользователю — одна или две короткие фразы на русском, без списков и без markdown.
   Подробности он видит в карточке маршрута, дублировать их не нужно."""

TOOL_SCHEMAS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "set_params",
            "description": "Меняет условия поиска. Время в минутах от полуночи даты отъезда.",
            "parameters": {
                "type": "object",
                "properties": {
                    "deadline": {"type": "integer", "description": "во сколько быть дома"},
                    "not_before": {"type": "integer", "description": "не выезжать раньше"},
                    "min_ground": {"type": "integer", "description": "минимум минут на земле"},
                    "max_ground": {"type": "integer", "description": "максимум минут на земле"},
                    "budget": {"type": "integer", "description": "потолок за оба билета, рубли"},
                    "budget_min": {"type": "integer", "description": "нижняя граница, рубли"},
                    "date": {"type": "string", "description": "дата отъезда YYYY-MM-DD"},
                    "nights": {"type": "integer", "description": "сколько ночей остаться"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_options",
            "description": "Куда успеваем вернуться при текущих условиях, по убыванию часов на земле.",
            "parameters": {
                "type": "object",
                "properties": {"limit": {"type": "integer", "description": "сколько вернуть, до 10"}},
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "plan_station",
            "description": "Полный маршрут в город: рейсы туда и обратно, транспорт, цены, запас.",
            "parameters": {
                "type": "object",
                "properties": {"city": {"type": "string"}},
                "required": ["city"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "stay_plan",
            "description": "План с ночёвкой: обратный рейс в день отъезда и отели на весь период.",
            "parameters": {
                "type": "object",
                "properties": {"city": {"type": "string"}, "nights": {"type": "integer"}},
                "required": ["city", "nights"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "escape",
            "description": "Лестница спасения: отели у станции, автобусы, оценка такси.",
            "parameters": {
                "type": "object",
                "properties": {"city": {"type": "string"}},
                "required": ["city"],
            },
        },
    },
]


@dataclass
class AgentRun:
    """Результат прогона. / One agent run."""

    reply: str = ""
    trace: list[dict[str, Any]] = field(default_factory=list)
    steps: int = 0


class Agent:
    def __init__(self, api_key: str, base_url: str, model: str) -> None:
        self._key = api_key
        self._url = base_url.rstrip("/") + "/chat/completions"
        self._model = model

    async def run(
        self,
        text: str,
        summary: str,
        tools: dict[str, Callable[..., Awaitable[dict[str, Any]]]],
    ) -> AgentRun:
        """Крутит цикл рассуждение-действие. / Spins the reason-act loop."""
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": SYSTEM},
            {"role": "system", "content": f"Текущие условия поиска: {summary}"},
            {"role": "user", "content": text},
        ]
        run = AgentRun()

        async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
            for step in range(MAX_STEPS):
                run.steps = step + 1
                message = await self._ask(client, messages)
                calls = message.get("tool_calls") or []
                if not calls:
                    run.reply = (message.get("content") or "").strip()
                    return run

                messages.append(message)
                for call in calls:
                    name = call["function"]["name"]
                    try:
                        args = json.loads(call["function"].get("arguments") or "{}")
                    except json.JSONDecodeError:
                        args = {}
                    handler = tools.get(name)
                    result = (
                        await handler(**args)
                        if handler
                        else {"error": f"инструмент {name} не существует"}
                    )
                    run.trace.append({"tool": name, "args": args, "result": result})
                    messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": call["id"],
                            "content": json.dumps(result, ensure_ascii=False)[:4000],
                        }
                    )

        run.reply = "Не уложился в отведённые шаги. Условия применены, план в карточке."
        return run

    async def _ask(self, client: httpx.AsyncClient, messages: list[dict[str, Any]]) -> dict[str, Any]:
        body = json.dumps(
            {"model": self._model, "messages": messages, "tools": TOOL_SCHEMAS},
            ensure_ascii=False,
        ).encode("utf-8")
        response = await client.post(
            self._url,
            content=body,
            headers={
                "Authorization": f"Bearer {self._key}",
                "Content-Type": "application/json",
            },
        )
        response.raise_for_status()
        return response.json()["choices"][0]["message"]

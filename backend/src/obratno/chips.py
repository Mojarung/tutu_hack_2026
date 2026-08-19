"""Свободный текст в видимые редактируемые чипы.

RU: Модель предлагает, применяет человек. Без ключа работает детерминированный разбор —
    продукт никогда не блокируется на LLM.
EN: The model proposes, the human applies. Without a key a deterministic parser runs,
    so the product never blocks on the LLM.
"""

from __future__ import annotations

import os
import re
from typing import Any

from .stations import STATIONS

_WORD_TIME = {
    "полуночи": 24 * 60,
    "полночи": 24 * 60,
    "полудню": 12 * 60,
    "обеду": 14 * 60,
    "ужину": 20 * 60,
    "вечеру": 21 * 60,
    "ночи": 23 * 60,
}
_WORD_GROUND = {
    "полдня": 6 * 60,
    "весь день": 8 * 60,
    "целый день": 8 * 60,
    "пару часов": 120,
    "часок": 60,
    "погулять": 180,
}


def parse_rules(text: str) -> list[dict[str, Any]]:
    """Детерминированный разбор. / Deterministic parse."""
    low = text.lower().replace("ё", "е")
    chips: list[dict[str, Any]] = []

    match = re.search(r"(?:до|к|дома к|вернут\w*\s+(?:до|к))\s*(\d{1,2})[:.](\d{2})", low)
    if match:
        chips.append({"type": "deadline", "value": int(match[1]) * 60 + int(match[2])})
    elif (hour := re.search(r"(?:до|к)\s*(\d{1,2})\s*(?:час\w*|ч\b)", low)) :
        chips.append({"type": "deadline", "value": int(hour[1]) * 60})
    else:
        for word, minutes in _WORD_TIME.items():
            if word in low:
                chips.append({"type": "deadline", "value": minutes})
                break

    for word, minutes in _WORD_GROUND.items():
        if word in low:
            chips.append({"type": "min_ground", "value": minutes})
            break
    else:
        hours = re.search(r"(?:хотя бы|минимум|побыть|на)\s*(\d{1,2})\s*(?:час\w*|ч\b)", low)
        if hours:
            chips.append({"type": "min_ground", "value": int(hours[1]) * 60})

    if "завтра" in low:
        chips.append({"type": "date", "value": "tomorrow"})
    if "без пересадок" in low or "прямы" in low:
        chips.append({"type": "direct", "value": True})
    for station in STATIONS:
        if station.name.lower() in low:
            chips.append({"type": "station", "value": station.code, "label": station.name})
            break
    return chips


async def parse(text: str) -> dict[str, Any]:
    """Разбор моделью с детерминированным фолбэком. / Model parse with deterministic fallback."""
    key = os.getenv("LLM_API_KEY") or os.getenv("OLLAMA_API_KEY")
    if key:
        try:
            return {"chips": await _parse_llm(text, key), "source": "llm"}
        except Exception:
            pass
    return {"chips": parse_rules(text), "source": "rules"}


async def _parse_llm(text: str, key: str) -> list[dict[str, Any]]:
    import json

    import httpx

    base = os.getenv("LLM_BASE_URL", "https://ollama.com/v1")
    model = os.getenv("LLM_MODEL", "gpt-oss:120b")
    prompt = (
        "Извлеки из фразы параметры поездки и верни СТРОГО JSON-массив чипов. "
        'Типы: {"type":"deadline","value":минуты_от_полуночи} '
        '{"type":"min_ground","value":минуты} {"type":"date","value":"today"|"tomorrow"} '
        '{"type":"direct","value":true}. Никакого текста вокруг. Фраза: ' + text
    )
    async with httpx.AsyncClient(timeout=12) as client:
        response = await client.post(
            f"{base}/chat/completions",
            headers={"Authorization": f"Bearer {key}"},
            json={"model": model, "messages": [{"role": "user", "content": prompt}]},
        )
        response.raise_for_status()
        content = response.json()["choices"][0]["message"]["content"]
    raw = json.loads(re.search(r"\[.*\]", content, re.S)[0])
    allowed = {"deadline", "min_ground", "date", "direct", "station"}
    return [c for c in raw if isinstance(c, dict) and c.get("type") in allowed]

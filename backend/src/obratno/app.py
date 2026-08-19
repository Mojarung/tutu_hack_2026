"""HTTP-слой продукта «Обратно».

RU: Бэкенд отдаёт расписание, клиент считает ответ. Единственное исключение — карточка обрыва
    и навык Алисы, где та же математика нужна на сервере.
EN: The backend serves timetables, the client computes answers. The cliff card and the Alice
    skill are the two places where the same math also runs server side.
"""

from __future__ import annotations

import asyncio
import json
import math
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import chips as chips_module
from . import cities as cities_module
from .ground import MSK, Solution, fmt, fmt_duration, next_day, solve
from .mcp_client import TutuMcp
from .schedule import fetch_leg, fetch_station_field
from .stations import BY_CODE, HOME_DEFAULT, HOME_LAT, HOME_LON, STATIONS

WEB_DIR = Path(__file__).resolve().parents[3] / "web"
TAXI_RUB_PER_KM = 35
TAXI_BASE_RUB = 400

_fields: dict[str, list[dict[str, Any]]] = {}
_mcp: TutuMcp | None = None


def today() -> str:
    return datetime.now(MSK).date().isoformat()


def mcp() -> TutuMcp:
    assert _mcp is not None
    return _mcp


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _mcp
    _mcp = TutuMcp()
    warm = asyncio.create_task(_warm(today()))
    yield
    warm.cancel()
    await _mcp.aclose()


async def _warm(date: str) -> None:
    """Прогрев веера в фоне. / Background fan warm-up."""
    try:
        await build_field(HOME_DEFAULT, date)
    except Exception:
        pass


async def build_field(home: str, date: str) -> list[dict[str, Any]]:
    key = f"{home}|{date}"
    if key in _fields:
        return _fields[key]
    results = await asyncio.gather(
        *[
            fetch_station_field(mcp(), home, station, date)
            for station in cities_module.destinations(home)
        ]
    )
    _fields[key] = list(results)
    return _fields[key]


app = FastAPI(title="Обратно", lifespan=lifespan)


@app.middleware("http")
async def no_store(request: Request, call_next):
    """Страница и скрипты не кэшируются: демо всегда показывает свежую сборку.

    RU: Иначе браузер отдаёт старый app.js и правка выглядит как невыполненная.
    EN: Otherwise the browser serves a stale app.js and a fix looks like it never landed.
    """
    response = await call_next(request)
    if not request.url.path.startswith("/api/") and "/vendor/" not in request.url.path:
        response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/api/stations")
async def api_stations(home: str = HOME_DEFAULT) -> dict[str, Any]:
    """Точка отправления и кандидаты для неё. / The origin and its candidates."""
    origin = cities_module.find(home)
    return {
        "home": {
            "name": home,
            "lat": origin["lat"] if origin else HOME_LAT,
            "lon": origin["lon"] if origin else HOME_LON,
        },
        "stations": [
            {"code": s.code, "name": s.name, "lat": s.lat, "lon": s.lon, "line": s.line}
            for s in cities_module.destinations(home)
        ],
        "today": today(),
    }


@app.get("/api/cities")
async def api_cities(q: str = "", limit: int = 60) -> dict[str, Any]:
    """Города России по алфавиту с поиском по названию. / Russian cities, searchable."""
    found = cities_module.search(q, limit)
    if not q.strip():
        found = sorted(found, key=lambda c: c["name"])
    return {
        "cities": [
            {"name": c["name"], "region": c["region"], "lat": c["lat"], "lon": c["lon"]}
            for c in found
        ],
        "total": len(cities_module.all_cities()),
    }


@app.get("/api/field")
async def api_field(home: str = HOME_DEFAULT, date: str = "") -> dict[str, Any]:
    date = date or today()
    return {"home": home, "date": date, "stations": await build_field(home, date)}


@app.get("/api/field/stream")
async def api_field_stream(home: str = HOME_DEFAULT, date: str = "") -> StreamingResponse:
    """Веер по мере ответов. / The fan, streamed as answers land."""
    target = date or today()

    async def gen():
        key = f"{home}|{target}"
        if key in _fields:
            for item in _fields[key]:
                yield f"event: station\ndata: {json.dumps(item, ensure_ascii=False)}\n\n"
            yield "event: done\ndata: {}\n\n"
            return
        collected: list[dict[str, Any]] = []
        tasks = [
            asyncio.create_task(fetch_station_field(mcp(), home, station, target))
            for station in cities_module.destinations(home)
        ]
        for task in asyncio.as_completed(tasks):
            item = await task
            collected.append(item)
            yield f"event: station\ndata: {json.dumps(item, ensure_ascii=False)}\n\n"
        _fields[key] = collected
        yield "event: done\ndata: {}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")


def _station_by_code(code: str, home: str):
    found = BY_CODE.get(code)
    if found:
        return found
    return next(s for s in cities_module.destinations(home) if s.code == code)


def _find(field: list[dict[str, Any]], code: str) -> dict[str, Any] | None:
    return next((s for s in field if s["code"] == code), None)


def _leg(ride: list, from_name: str | None, to_name: str | None) -> dict[str, Any]:
    """Полный рейс: время, транспорт, номер, цена, станции. / A full leg as Tutu returned it."""
    return {
        "dep": fmt(ride[0]),
        "arr": fmt(ride[1]),
        "duration": fmt_duration(ride[1] - ride[0]),
        "price": ride[2] if len(ride) > 2 else None,
        "voyage": ride[3] if len(ride) > 3 else "",
        "vehicle": ride[4] if len(ride) > 4 else "Электричка",
        "from": from_name,
        "to": to_name,
    }


def _ride_card(station: dict[str, Any], answer: Solution) -> dict[str, Any]:
    previous = sorted(
        [r for r in station["back"] if r[0] < answer.back_dep], key=lambda r: r[0], reverse=True
    )[:2]
    out_ride = next(
        (r for r in station["out"] if r[0] == answer.out_dep and r[1] == answer.out_arr), []
    )
    back_ride = next(
        (r for r in station["back"] if r[0] == answer.back_dep and r[1] == answer.back_arr), []
    )
    return {
        "ground": answer.ground,
        "ground_label": fmt_duration(answer.ground),
        "out": _leg(out_ride, station.get("from_name"), station.get("to_name")),
        "back": _leg(back_ride, station.get("back_from_name"), station.get("back_to_name")),
        "buffer": [_leg(r, station.get("back_from_name"), station.get("back_to_name")) for r in previous],
        "price_total": (out_ride[2] if len(out_ride) > 2 else 0)
        + (back_ride[2] if len(back_ride) > 2 else 0),
        "checkout_url": station.get("checkout_url"),
        "back_checkout_url": station.get("back_checkout_url"),
        "from_name": station.get("from_name"),
        "to_name": station.get("to_name"),
    }


def _km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(
        math.radians(lat2)
    ) * math.sin(dlon / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(a))


async def _escape(code: str, date: str) -> dict[str, Any]:
    """Лестница спасения: одно честное состояние. / Escape ladder: one honest state."""
    station = _station_by_code(code, HOME_DEFAULT)
    hotels: list[dict[str, Any]] = []
    buses = 0
    try:
        payload = await mcp().call(
            "search_hotels",
            {
                "city_name": station.name,
                "check_in": date,
                "check_out": next_day(date),
                "page_size": 4,
            },
        )
        for hotel in payload.get("hotels") or []:
            location = hotel.get("location") or {}
            offer = hotel.get("best_offer") or {}
            distance = None
            if location.get("lat") and location.get("lng"):
                distance = _km(station.lat, station.lon, location["lat"], location["lng"])
            hotels.append(
                {
                    "name": hotel.get("name"),
                    "stars": hotel.get("stars"),
                    "rating": hotel.get("rating"),
                    "price": (offer.get("price") or {}).get("amount"),
                    "room": offer.get("room_name"),
                    "free_cancellation": offer.get("free_cancellation"),
                    "checkout_url": hotel.get("checkout_url"),
                    "walk_min": round(distance / 5 * 60) if distance is not None else None,
                }
            )
        hotels.sort(key=lambda h: (h["walk_min"] is None, h["walk_min"] or 0))
    except Exception:
        pass
    try:
        payload = await mcp().call(
            "search_bus",
            {"origin": station.name, "destination": HOME_DEFAULT, "departure_date": date},
        )
        buses = int((payload.get("meta") or {}).get("total_matched") or 0)
    except Exception:
        buses = 0
    distance_home = _km(HOME_LAT, HOME_LON, station.lat, station.lon)
    return {
        "hotels": hotels[:3],
        "buses": buses,
        "taxi": {
            "rub": round((distance_home * TAXI_RUB_PER_KM + TAXI_BASE_RUB) / 100) * 100,
            "km": round(distance_home),
            "note": "оценка по прямой, Tutu такси не отдаёт",
        },
    }


async def _stay_plan(
    code: str, date: str, nights: int, deadline: int, out_ride: list[int] | None
) -> dict[str, Any]:
    """План с ночёвкой: обратный рейс в день отъезда плюс проживание.

    RU: Обратное расписание берётся на дату отъезда, отель — на весь период одним запросом,
        цена приходит уже за весь период (price_basis stay_total) и не умножается на ночи.
    EN: The return leg is fetched for the departure date and the hotel for the whole stay,
        whose price is already a stay total and is never multiplied by the nights.
    """
    station = BY_CODE[code]
    back_date = date
    for _ in range(nights):
        back_date = next_day(back_date)

    leg = await fetch_leg(mcp(), station.name, HOME_DEFAULT, back_date)
    rides = [r for r in leg["rides"] if r[1] <= deadline]
    back = max(rides, key=lambda r: r[0]) if rides else None

    hotels: list[dict[str, Any]] = []
    try:
        payload = await mcp().call(
            "search_hotels",
            {"city_name": station.name, "check_in": date, "check_out": back_date, "page_size": 4},
        )
        for hotel in payload.get("hotels") or []:
            location = hotel.get("location") or {}
            offer = hotel.get("best_offer") or {}
            distance = (
                _km(station.lat, station.lon, location["lat"], location["lng"])
                if location.get("lat") and location.get("lng")
                else None
            )
            hotels.append(
                {
                    "name": hotel.get("name"),
                    "price": (offer.get("price") or {}).get("amount"),
                    "room": offer.get("room_name"),
                    "free_cancellation": offer.get("free_cancellation"),
                    "checkout_url": hotel.get("checkout_url"),
                    "walk_min": round(distance / 5 * 60) if distance is not None else None,
                }
            )
        hotels.sort(key=lambda h: (h["price"] is None, h["price"] or 0))
    except Exception:
        hotels = []

    ground = None
    if back and out_ride:
        ground = back[0] + nights * 24 * 60 - out_ride[1]
    return {
        "nights": nights,
        "back_date": back_date,
        "back": {"dep": fmt(back[0]), "arr": fmt(back[1])} if back else None,
        "back_window": leg["window"],
        "ground_label": fmt_duration(ground) if ground else None,
        "hotels": hotels[:3],
        "price_note": "цена отеля уже за весь период, Tutu отдаёт stay_total",
    }


@app.get("/api/plan")
async def api_plan(
    code: str,
    date: str = "",
    deadline: int = 22 * 60,
    min_ground: int = 0,
    not_before: int = 0,
    budget: int = 0,
    max_ground: int = 0,
    budget_min: int = 0,
    nights: int = 0,
    home: str = HOME_DEFAULT,
) -> dict[str, Any]:
    """Карточка обрыва. / The cliff card."""
    date = date or today()
    field = await build_field(home, date)
    station = _find(field, code)
    if station is None:
        return {"error": "unknown station"}
    answer = solve(
        station["out"], station["back"], deadline, min_ground, not_before, budget, max_ground, budget_min
    )
    body: dict[str, Any] = {
        "code": code,
        "name": station["name"],
        "window": station["window"],
        "back_total": station.get("back_total"),
        "last_known_back": fmt(station["back"][-1][0]) if station["back"] else None,
    }
    if answer:
        body["ride"] = _ride_card(station, answer)
    if nights > 0:
        out_ride = None
        candidates = [r for r in station["out"] if r[0] >= not_before]
        if candidates:
            out_ride = min(candidates, key=lambda r: r[1])
        body["stay"] = await _stay_plan(code, date, nights, deadline, out_ride)
        if out_ride:
            body["stay"]["out"] = {"dep": fmt(out_ride[0]), "arr": fmt(out_ride[1])}
    elif not answer:
        body["escape"] = await _escape(code, date)
    return body


@app.post("/api/chips")
async def api_chips(request: Request) -> dict[str, Any]:
    payload = await request.json()
    return await chips_module.parse(str(payload.get("text", ""))[:400])


@app.post("/api/chat")
async def api_chat(request: Request) -> dict[str, Any]:
    """Диалог поверх той же математики: модель разбирает фразу, план считает домен.

    RU: Модель меняет только параметры, видимые пользователю. Числа плана она не сочиняет.
    EN: The model only edits user-visible parameters; it never invents the plan numbers.
    """
    payload = await request.json()
    context = dict(payload.get("context") or {})
    parsed = await chips_module.parse(str(payload.get("text", ""))[:400])

    for chip in parsed["chips"]:
        if chip["type"] == "deadline":
            context["deadline"] = int(chip["value"])
        elif chip["type"] == "min_ground":
            context["min_ground"] = int(chip["value"])
        elif chip["type"] == "station":
            context["code"] = chip["value"]
        elif chip["type"] == "date" and chip["value"] == "tomorrow":
            context["date"] = next_day(context.get("date") or today())

    date = context.get("date") or today()
    home = context.get("home") or HOME_DEFAULT
    deadline = int(context.get("deadline") or 22 * 60)
    min_ground = int(context.get("min_ground") or 0)
    not_before = int(context.get("not_before") or 0)
    budget = int(context.get("budget") or 0)
    max_ground = int(context.get("max_ground") or 0)
    budget_min = int(context.get("budget_min") or 0)

    field = await build_field(home, date)
    ranked: list[tuple[int, dict[str, Any], Solution]] = []
    for station in field:
        if not station.get("out") or not station.get("back"):
            continue
        answer = solve(
        station["out"], station["back"], deadline, min_ground, not_before, budget, max_ground, budget_min
    )
        if answer:
            ranked.append((answer.ground, station, answer))
    ranked.sort(key=lambda item: item[0], reverse=True)

    chosen = None
    if context.get("code"):
        chosen = next((item for item in ranked if item[1]["code"] == context["code"]), None)
    if chosen is None and ranked:
        chosen = ranked[0]

    if chosen is None:
        return {
            "context": context,
            "chips": parsed["chips"],
            "source": parsed["source"],
            "reply": f"До {fmt(deadline)} вернуться неоткуда. Отодвиньте время или снимите бюджет.",
            "plan": None,
            "options": [],
        }

    ground, station, answer = chosen
    context["code"] = station["code"]
    return {
        "context": context,
        "chips": parsed["chips"],
        "source": parsed["source"],
        "reply": f"{station['name']}: {fmt_duration(ground)} на земле, последняя обратно {fmt(answer.back_dep)}.",
        "plan": {"name": station["name"], "code": station["code"], **_ride_card(station, answer)},
        "options": [
            {"code": item[1]["code"], "name": item[1]["name"], "ground": fmt_duration(item[0])}
            for item in ranked[1:5]
        ],
    }


@app.post("/api/alice")
async def api_alice(request: Request) -> dict[str, Any]:
    """Один факт — один ответ. / One fact, one answer."""
    payload = await request.json()
    utterance = (
        ((payload.get("request") or {}).get("original_utterance") or "").lower().replace("ё", "е")
    )
    station = next((s for s in STATIONS if s.name.lower() in utterance), None)
    if station is None:
        text = "Скажите, до какой станции. Например: когда последняя электричка до Пушкино."
    else:
        field = await build_field(HOME_DEFAULT, today())
        item = _find(field, station.code)
        if not item or not item["back"]:
            text = f"Tutu не отдаёт расписание обратно из {station.name}."
        else:
            dep, arr = max(item["back"], key=lambda r: r[0])
            text = (
                f"Последняя из {station.name} сегодня в {fmt(dep)}, "
                f"дома в {fmt(arr)}."
            )
    return {
        "version": payload.get("version", "1.0"),
        "session": payload.get("session", {}),
        "response": {"text": text, "tts": text, "end_session": True},
    }


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(WEB_DIR / "index.html")


app.mount("/", StaticFiles(directory=WEB_DIR), name="web")

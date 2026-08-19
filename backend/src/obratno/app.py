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
from .ground import MSK, Solution, fmt, fmt_duration, next_day, solve
from .mcp_client import TutuMcp
from .schedule import fetch_station_field
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
        *[fetch_station_field(mcp(), home, station, date) for station in STATIONS]
    )
    _fields[key] = list(results)
    return _fields[key]


app = FastAPI(title="Обратно", lifespan=lifespan)


@app.get("/api/stations")
async def api_stations() -> dict[str, Any]:
    return {
        "home": {"name": HOME_DEFAULT, "lat": HOME_LAT, "lon": HOME_LON},
        "stations": [
            {"code": s.code, "name": s.name, "lat": s.lat, "lon": s.lon, "line": s.line}
            for s in STATIONS
        ],
        "today": today(),
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
            for station in STATIONS
        ]
        for task in asyncio.as_completed(tasks):
            item = await task
            collected.append(item)
            yield f"event: station\ndata: {json.dumps(item, ensure_ascii=False)}\n\n"
        _fields[key] = collected
        yield "event: done\ndata: {}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")


def _find(field: list[dict[str, Any]], code: str) -> dict[str, Any] | None:
    return next((s for s in field if s["code"] == code), None)


def _ride_card(station: dict[str, Any], answer: Solution) -> dict[str, Any]:
    previous = sorted(
        [r for r in station["back"] if r[0] < answer.back_dep], key=lambda r: r[0], reverse=True
    )[:2]
    return {
        "ground": answer.ground,
        "ground_label": fmt_duration(answer.ground),
        "out": {"dep": fmt(answer.out_dep), "arr": fmt(answer.out_arr)},
        "back": {"dep": fmt(answer.back_dep), "arr": fmt(answer.back_arr)},
        "buffer": [{"dep": fmt(r[0]), "arr": fmt(r[1])} for r in previous],
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
    station = BY_CODE[code]
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


@app.get("/api/plan")
async def api_plan(
    code: str,
    date: str = "",
    deadline: int = 22 * 60,
    min_ground: int = 0,
    not_before: int = 0,
    home: str = HOME_DEFAULT,
) -> dict[str, Any]:
    """Карточка обрыва. / The cliff card."""
    date = date or today()
    field = await build_field(home, date)
    station = _find(field, code)
    if station is None:
        return {"error": "unknown station"}
    answer = solve(station["out"], station["back"], deadline, min_ground, not_before)
    body: dict[str, Any] = {
        "code": code,
        "name": station["name"],
        "window": station["window"],
        "back_total": station.get("back_total"),
        "last_known_back": fmt(station["back"][-1][0]) if station["back"] else None,
    }
    if answer:
        body["ride"] = _ride_card(station, answer)
    else:
        body["escape"] = await _escape(code, date)
    return body


@app.post("/api/chips")
async def api_chips(request: Request) -> dict[str, Any]:
    payload = await request.json()
    return await chips_module.parse(str(payload.get("text", ""))[:400])


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

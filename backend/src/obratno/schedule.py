"""Сбор расписаний: пагинация, кэш, состояние окна ответа.

RU: meta.total_matched точен, потолок выдачи 300 офферов (page<=10, page_size<=30).
    Отсюда состояние окна вычисляется арифметикой, а не эвристикой.
EN: meta.total_matched is exact and the hard ceiling is 300 offers, so the window state
    is arithmetic rather than guesswork.
"""

from __future__ import annotations

import asyncio
import json
import math
import time
from pathlib import Path
from typing import Any

from .ground import to_minutes
from .mcp_client import TutuMcp
from .stations import Station

PAGE_SIZE = 30
MAX_PAGES = 10
CEILING = PAGE_SIZE * MAX_PAGES
CACHE_DIR = Path(__file__).resolve().parents[3] / "var" / "cache"
CACHE_TTL = 12 * 3600


def _cache_path(origin: str, destination: str, date: str) -> Path:
    key = f"{origin}__{destination}__{date}".replace(" ", "_").replace("/", "-")
    return CACHE_DIR / f"{key}.json"


def _read_cache(path: Path) -> dict[str, Any] | None:
    if not path.exists() or time.time() - path.stat().st_mtime > CACHE_TTL:
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


async def fetch_leg(mcp: TutuMcp, origin: str, destination: str, date: str) -> dict[str, Any]:
    """Все страницы одной пары. / Every page of one pair.

    RU: Первая страница даёт total_matched, остальные тянутся параллельно.
    EN: Page one yields total_matched, the rest are fetched in parallel.
    """
    path = _cache_path(origin, destination, date)
    cached = _read_cache(path)
    if cached:
        return cached

    args = {
        "origin": origin,
        "destination": destination,
        "departure_date": date,
        "page_size": PAGE_SIZE,
        "sort": "departure_asc",
    }
    first = await mcp.call("search_etrain", {**args, "page": 1})
    meta = first.get("meta", {})
    total = int(meta.get("total_matched") or 0)
    offers = list(first.get("offers") or [])

    pages = min(math.ceil(min(total, CEILING) / PAGE_SIZE), MAX_PAGES)
    if pages > 1:
        rest = await asyncio.gather(
            *[mcp.call("search_etrain", {**args, "page": p}) for p in range(2, pages + 1)],
            return_exceptions=True,
        )
        ok = True
        for chunk in rest:
            if isinstance(chunk, BaseException):
                ok = False
                continue
            offers.extend(chunk.get("offers") or [])
    else:
        ok = True

    rides: list[list[int]] = []
    from_name = to_name = None
    for offer in offers:
        try:
            dep = to_minutes(offer["departure_at"], date)
            arr = to_minutes(offer["arrival_at"], date)
        except Exception:
            continue
        rides.append([dep, arr])
        if from_name is None:
            leg = (offer.get("legs") or [{}])[0]
            segment = (leg.get("segments") or [{}])[0]
            from_name, to_name = segment.get("from"), segment.get("to")

    rides.sort(key=lambda r: r[0])
    window = "complete" if (total <= CEILING and ok) else ("truncated" if total > CEILING else "partial")
    result = {
        "rides": rides,
        "total": total,
        "window": window,
        "from_name": from_name,
        "to_name": to_name,
        "fetched_at": int(time.time()),
    }
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    return result


async def fetch_station_field(
    mcp: TutuMcp, home: str, station: Station, date: str
) -> dict[str, Any]:
    """Поле одной станции: туда и обратно. / One station field: there and back."""
    try:
        there, back = await asyncio.gather(
            fetch_leg(mcp, home, station.name, date),
            fetch_leg(mcp, station.name, home, date),
        )
    except Exception as exc:
        return {
            "code": station.code,
            "name": station.name,
            "lat": station.lat,
            "lon": station.lon,
            "line": station.line,
            "out": [],
            "back": [],
            "window": "unavailable",
            "error": str(exc)[:120],
        }

    back_rides = sorted(back["rides"], key=lambda r: r[1])
    window = "complete"
    for state in (there["window"], back["window"]):
        if state == "truncated":
            window = "truncated"
        elif state == "partial" and window != "truncated":
            window = "partial"
    if not there["rides"] or not back_rides:
        window = "empty"

    return {
        "code": station.code,
        "name": station.name,
        "lat": station.lat,
        "lon": station.lon,
        "line": station.line,
        "out": there["rides"],
        "back": back_rides,
        "out_total": there["total"],
        "back_total": back["total"],
        "window": window,
        "from_name": there["from_name"],
        "to_name": there["to_name"],
        "fetched_at": there["fetched_at"],
    }

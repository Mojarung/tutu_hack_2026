"""Справочник городов России и подбор кандидатов от точки отправления.

RU: Источник — открытый набор hflabs/city (1103 города с координатами и населением).
    Отсюда берутся только имя и точка на карте; расписание всегда из ответа Tutu.
EN: Source is the open hflabs/city dataset. Only the name and map point come from here;
    schedules always come from the Tutu response.
"""

from __future__ import annotations

import json
import math
from functools import lru_cache
from pathlib import Path

from .stations import STATIONS, Station

DATA = Path(__file__).parent / "data" / "cities.json"
NEAR_LIMIT = 30
NEAR_MAX_KM = 320
MIN_POPULATION = 12_000


@lru_cache(maxsize=1)
def all_cities() -> list[dict]:
    """Города по алфавиту. / Cities in alphabetical order."""
    return json.loads(DATA.read_text(encoding="utf-8"))


def search(query: str, limit: int = 60) -> list[dict]:
    """Поиск по началу названия, затем по вхождению. / Prefix search first, then substring."""
    needle = query.strip().lower()
    if not needle:
        return sorted(all_cities(), key=lambda c: -c["pop"])[:limit]
    starts = [c for c in all_cities() if c["name"].lower().startswith(needle)]
    inside = [c for c in all_cities() if needle in c["name"].lower() and c not in starts]
    return (starts + inside)[:limit]


def find(name: str) -> dict | None:
    needle = name.strip().lower()
    return next((c for c in all_cities() if c["name"].lower() == needle), None)


def km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(
        math.radians(lat2)
    ) * math.sin(dlon / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(a))


def _slug(name: str) -> str:
    return "c" + str(abs(hash(name)) % 10_000_000)


def destinations(home: str) -> list[Station]:
    """Кандидаты для веера от точки отправления.

    RU: Для Москвы это выверенный список станций узла. Для любого другого города —
        ближайшие города справочника: без них веер по стране был бы неподъёмным.
    EN: For Moscow it is the curated list of узел stations. For any other city it is the
        nearest cities from the reference, since a country-wide fan is not affordable.
    """
    origin = find(home)
    if origin is None or home.strip().lower() == "москва":
        return list(STATIONS)

    near: list[tuple[float, dict]] = []
    for city in all_cities():
        if city["name"] == origin["name"] or city["pop"] < MIN_POPULATION:
            continue
        distance = km(origin["lat"], origin["lon"], city["lat"], city["lon"])
        if distance <= NEAR_MAX_KM:
            near.append((distance, city))
    near.sort(key=lambda item: item[0])
    return [
        Station(_slug(city["name"]), city["name"], city["lat"], city["lon"], city["region"])
        for _, city in near[:NEAR_LIMIT]
    ]

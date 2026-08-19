"""Математика часов на земле.

RU: Всё время — минуты от местной полуночи запрошенной даты, поэтому отправление 01:22
    следующих суток это 1522, а не 82. Сравнение по времени суток структурно невозможно.
EN: All times are minutes from local midnight of the requested date, so a 01:22 next-day
    departure is 1522, not 82. Time-of-day comparison is structurally impossible here.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

MSK = ZoneInfo("Europe/Moscow")


def to_minutes(iso: str, base_date: str) -> int:
    """Момент времени в минутах от полуночи base_date. / Instant as minutes from base midnight."""
    moment = datetime.fromisoformat(iso).astimezone(MSK)
    base = datetime.fromisoformat(base_date).replace(tzinfo=MSK)
    return round((moment - base).total_seconds() / 60)


def fmt(minutes: int) -> str:
    """1522 -> '01:22'. Следующие сутки остаются валидным временем. / Next-day safe clock."""
    return f"{(minutes // 60) % 24:02d}:{minutes % 60:02d}"


def fmt_duration(minutes: int) -> str:
    hours, mins = divmod(max(minutes, 0), 60)
    if hours and mins:
        return f"{hours} ч {mins} м"
    if hours:
        return f"{hours} ч"
    return f"{mins} м"


@dataclass(frozen=True, slots=True)
class Solution:
    out_dep: int
    out_arr: int
    back_dep: int
    back_arr: int
    ground: int


def solve(
    out: list[list[int]],
    back: list[list[int]],
    deadline: int,
    min_ground: int = 0,
    not_before: int = 0,
    budget: int = 0,
) -> Solution | None:
    """Сшивает поездку туда с самым поздним возвратом до дедлайна.

    RU: out и back — пары [отправление, прибытие]. Возвращает None, если поездка не складывается.
    EN: out and back are [departure, arrival] pairs. Returns None when no trip fits.
    """
    for ride in sorted(back, key=lambda r: r[1], reverse=True):
        back_dep, back_arr = ride[0], ride[1]
        back_price = ride[2] if len(ride) > 2 else 0
        if back_arr > deadline:
            continue
        best_arr: int | None = None
        best_dep = 0
        for out_ride in out:
            out_dep, out_arr = out_ride[0], out_ride[1]
            out_price = out_ride[2] if len(out_ride) > 2 else 0
            if out_dep < not_before or out_arr > back_dep:
                continue
            if budget and out_price + back_price > budget:
                continue
            if best_arr is None or out_arr < best_arr:
                best_arr, best_dep = out_arr, out_dep
        if best_arr is None:
            continue
        ground = back_dep - best_arr
        if ground >= min_ground:
            return Solution(best_dep, best_arr, back_dep, back_arr, ground)
    return None


def next_day(date_iso: str) -> str:
    return (datetime.fromisoformat(date_iso) + timedelta(days=1)).date().isoformat()

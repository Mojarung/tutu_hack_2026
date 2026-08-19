"""Замороженная география Московского узла.

RU: Координаты выверены вручную и лежат в репозитории осознанно: tutu://geo координат не даёт.
    Отсюда берётся только точка на карте. Расписание, время и цены — всегда из ответа Tutu.
EN: Hand curated coordinates, deliberately vendored: tutu://geo carries no coordinates.
    This file provides map points only. Schedules always come from the Tutu response.
"""

from __future__ import annotations

from dataclasses import dataclass

HOME_DEFAULT = "Москва"
HOME_LAT, HOME_LON = 55.7558, 37.6173


@dataclass(frozen=True, slots=True)
class Station:
    code: str
    name: str
    lat: float
    lon: float
    line: str


STATIONS: tuple[Station, ...] = (
    Station("mytishchi", "Мытищи", 55.9116, 37.7308, "Ярославское"),
    Station("pushkino", "Пушкино", 56.0106, 37.8474, "Ярославское"),
    Station("sofrino", "Софрино", 56.1480, 37.9470, "Ярославское"),
    Station("sergiev-posad", "Сергиев Посад", 56.3086, 38.1360, "Ярославское"),
    Station("aleksandrov", "Александров", 56.3944, 38.7136, "Ярославское"),
    Station("lyubertsy", "Люберцы", 55.6763, 37.8931, "Казанское"),
    Station("ramenskoe", "Раменское", 55.5670, 38.2296, "Казанское"),
    Station("kurovskaya", "Куровская", 55.5800, 38.9200, "Казанское"),
    Station("shatura", "Шатура", 55.5747, 39.5386, "Казанское"),
    Station("kolomna", "Коломна", 55.0940, 38.7650, "Казанское"),
    Station("ryazan", "Рязань", 54.6250, 39.7360, "Казанское"),
    Station("zheleznodorozhny", "Железнодорожный", 55.7450, 38.0100, "Горьковское"),
    Station("noginsk", "Ногинск", 55.8500, 38.4400, "Горьковское"),
    Station("pavlovsky-posad", "Павловский Посад", 55.7800, 38.6500, "Горьковское"),
    Station("orekhovo-zuevo", "Орехово-Зуево", 55.8058, 38.9744, "Горьковское"),
    Station("vladimir", "Владимир", 56.1290, 40.4070, "Горьковское"),
    Station("podolsk", "Подольск", 55.4310, 37.5450, "Курское"),
    Station("chekhov", "Чехов", 55.1500, 37.4700, "Курское"),
    Station("serpukhov", "Серпухов", 54.9200, 37.4100, "Курское"),
    Station("tula", "Тула", 54.1930, 37.6170, "Курское"),
    Station("domodedovo", "Домодедово", 55.4400, 37.7600, "Павелецкое"),
    Station("stupino", "Ступино", 54.8990, 38.0770, "Павелецкое"),
    Station("kashira", "Кашира", 54.8380, 38.1720, "Павелецкое"),
    Station("aprelevka", "Апрелевка", 55.5400, 37.0700, "Киевское"),
    Station("naro-fominsk", "Наро-Фоминск", 55.3860, 36.7330, "Киевское"),
    Station("obninsk", "Обнинск", 55.0930, 36.6100, "Киевское"),
    Station("kaluga", "Калуга", 54.5140, 36.2610, "Киевское"),
    Station("odintsovo", "Одинцово", 55.6790, 37.2630, "Белорусское"),
    Station("zvenigorod", "Звенигород", 55.7310, 36.8540, "Белорусское"),
    Station("mozhaysk", "Можайск", 55.5050, 36.0270, "Белорусское"),
    Station("gagarin", "Гагарин", 55.5520, 34.9930, "Белорусское"),
    Station("istra", "Истра", 55.9140, 36.8680, "Рижское"),
    Station("volokolamsk", "Волоколамск", 56.0350, 35.9580, "Рижское"),
    Station("dmitrov", "Дмитров", 56.3440, 37.5200, "Савёловское"),
    Station("dubna", "Дубна", 56.7330, 37.1700, "Савёловское"),
    Station("klin", "Клин", 56.3330, 36.7100, "Ленинградское"),
    Station("tver", "Тверь", 56.8590, 35.9110, "Ленинградское"),
    Station("konakovo", "Конаково", 56.7050, 36.7600, "Ленинградское"),
)

BY_CODE = {s.code: s for s in STATIONS}
BY_NAME = {s.name.lower(): s for s in STATIONS}

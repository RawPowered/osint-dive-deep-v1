from __future__ import annotations

import json
import threading
import time
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any, Iterable

import pandas as pd
import requests


TIGER_STATE_LAYER = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/0/query"
NCEI_DAILY_SUMMARIES = "https://www.ncei.noaa.gov/access/services/data/v1"
NOMINATIM_REVERSE = "https://nominatim.openstreetmap.org/reverse"
_NOMINATIM_LOCK = threading.Lock()
_LAST_NOMINATIM_REQUEST = 0.0

# USPS abbreviation -> (display name, two-digit Census/NCEI FIPS code).
US_STATES: dict[str, tuple[str, str]] = {
    "AL": ("Alabama", "01"), "AK": ("Alaska", "02"), "AZ": ("Arizona", "04"), "AR": ("Arkansas", "05"),
    "CA": ("California", "06"), "CO": ("Colorado", "08"), "CT": ("Connecticut", "09"), "DE": ("Delaware", "10"),
    "DC": ("District of Columbia", "11"), "FL": ("Florida", "12"), "GA": ("Georgia", "13"), "HI": ("Hawaii", "15"),
    "ID": ("Idaho", "16"), "IL": ("Illinois", "17"), "IN": ("Indiana", "18"), "IA": ("Iowa", "19"),
    "KS": ("Kansas", "20"), "KY": ("Kentucky", "21"), "LA": ("Louisiana", "22"), "ME": ("Maine", "23"),
    "MD": ("Maryland", "24"), "MA": ("Massachusetts", "25"), "MI": ("Michigan", "26"), "MN": ("Minnesota", "27"),
    "MS": ("Mississippi", "28"), "MO": ("Missouri", "29"), "MT": ("Montana", "30"), "NE": ("Nebraska", "31"),
    "NV": ("Nevada", "32"), "NH": ("New Hampshire", "33"), "NJ": ("New Jersey", "34"), "NM": ("New Mexico", "35"),
    "NY": ("New York", "36"), "NC": ("North Carolina", "37"), "ND": ("North Dakota", "38"), "OH": ("Ohio", "39"),
    "OK": ("Oklahoma", "40"), "OR": ("Oregon", "41"), "PA": ("Pennsylvania", "42"), "RI": ("Rhode Island", "44"),
    "SC": ("South Carolina", "45"), "SD": ("South Dakota", "46"), "TN": ("Tennessee", "47"), "TX": ("Texas", "48"),
    "UT": ("Utah", "49"), "VT": ("Vermont", "50"), "VA": ("Virginia", "51"), "WA": ("Washington", "53"),
    "WV": ("West Virginia", "54"), "WI": ("Wisconsin", "55"), "WY": ("Wyoming", "56"),
    "AS": ("American Samoa", "60"), "GU": ("Guam", "66"), "MP": ("Northern Mariana Islands", "69"),
    "PR": ("Puerto Rico", "72"), "VI": ("U.S. Virgin Islands", "78"),
}


def state_name(code: str) -> str:
    return US_STATES.get(code.strip().upper(), (code.strip().upper(), ""))[0]


def state_fips(code: str) -> str:
    return US_STATES.get(code.strip().upper(), ("", ""))[1]


def _coordinate_pairs(value: Any) -> Iterable[tuple[float, float]]:
    if isinstance(value, (list, tuple)):
        if len(value) >= 2 and all(isinstance(item, (int, float)) for item in value[:2]):
            yield float(value[0]), float(value[1])
        else:
            for item in value:
                yield from _coordinate_pairs(item)


def geometry_bounds(geojson: dict[str, Any]) -> tuple[float, float, float, float]:
    coordinates: list[tuple[float, float]] = []
    for feature in geojson.get("features", []):
        coordinates.extend(_coordinate_pairs((feature.get("geometry") or {}).get("coordinates", [])))
    if not coordinates:
        raise ValueError("The state boundary response contained no coordinates.")
    longitudes = [item[0] for item in coordinates]
    latitudes = [item[1] for item in coordinates]
    return min(latitudes), min(longitudes), max(latitudes), max(longitudes)


def geometry_bboxes(geojson: dict[str, Any]) -> list[tuple[float, float, float, float]]:
    """Return compact N/W/S/E boxes, keeping multipart island states out of world-spanning requests."""
    pairs: list[tuple[float, float]] = []
    for feature in geojson.get("features", []):
        pairs.extend(_coordinate_pairs((feature.get("geometry") or {}).get("coordinates", [])))
    if not pairs:
        south, west, north, east = geometry_bounds(geojson)
        return [(north, west, south, east)]
    span = max(point[0] for point in pairs) - min(point[0] for point in pairs)
    groups = ([point for point in pairs if point[0] < 0], [point for point in pairs if point[0] >= 0]) if span > 120 else (pairs,)
    boxes: list[tuple[float, float, float, float]] = []
    for group in groups:
        if group:
            longitudes = [point[0] for point in group]
            latitudes = [point[1] for point in group]
            boxes.append((max(latitudes), min(longitudes), min(latitudes), max(longitudes)))
    return boxes


@dataclass(frozen=True)
class StateBoundary:
    geojson: dict[str, Any]
    raw: bytes
    url: str
    headers: dict[str, str]
    south: float
    west: float
    north: float
    east: float

    @property
    def center(self) -> tuple[float, float]:
        return ((self.south + self.north) / 2, (self.west + self.east) / 2)


def collect_state_boundary(session: requests.Session, state: str) -> StateBoundary:
    code = state.strip().upper()
    if code not in US_STATES:
        raise ValueError(f"Unsupported U.S. state or territory code: {state}")
    response = session.get(
        TIGER_STATE_LAYER,
        params={
            "f": "geojson",
            "where": f"STUSAB='{code}'",
            "outFields": "GEOID,STUSAB,NAME,CENTLAT,CENTLON",
            "returnGeometry": "true",
            "outSR": 4326,
        },
        timeout=90,
    )
    raw = response.content
    response.raise_for_status()
    payload = response.json()
    if not payload.get("features"):
        raise RuntimeError(f"Census TIGERweb returned no boundary for {code}.")
    south, west, north, east = geometry_bounds(payload)
    return StateBoundary(payload, raw, response.url, {str(k): str(v) for k, v in response.headers.items()}, south, west, north, east)


def _date_chunks(start: date, end: date, days: int = 31) -> Iterable[tuple[date, date]]:
    cursor = start
    while cursor <= end:
        chunk_end = min(end, cursor + timedelta(days=days - 1))
        yield cursor, chunk_end
        cursor = chunk_end + timedelta(days=1)


def collect_daily_precipitation(
    session: requests.Session,
    boundary: StateBoundary,
    start: date,
    end: date,
    *,
    maximum_observations: int = 250_000,
) -> tuple[pd.DataFrame, list[tuple[str, bytes, dict[str, str]]]]:
    if end < start:
        raise ValueError("Rainfall end date must be on or after the start date.")
    if (end - start).days > 366:
        raise ValueError("One rainfall collection is limited to 367 days to keep the public request bounded.")
    frames: list[pd.DataFrame] = []
    raw_assets: list[tuple[str, bytes, dict[str, str]]] = []
    total = 0
    for north, west, south, east in geometry_bboxes(boundary.geojson):
        bbox = f"{north:.6f},{west:.6f},{south:.6f},{east:.6f}"
        for chunk_start, chunk_end in _date_chunks(start, end):
            response = session.get(
                NCEI_DAILY_SUMMARIES,
                params={
                    "dataset": "daily-summaries",
                    "dataTypes": "PRCP",
                    "bbox": bbox,
                    "startDate": chunk_start.isoformat(),
                    "endDate": chunk_end.isoformat(),
                    "format": "json",
                    "includeStationName": "true",
                    "includeStationLocation": "true",
                    "includeAttributes": "true",
                    "units": "metric",
                },
                timeout=180,
            )
            raw_assets.append((response.url, response.content, {str(k): str(v) for k, v in response.headers.items()}))
            response.raise_for_status()
            payload = response.json()
            if not isinstance(payload, list):
                raise RuntimeError(json.dumps(payload, ensure_ascii=False)[:1000])
            if payload:
                frame = pd.DataFrame(payload)
                frame.columns = [str(column).upper() for column in frame.columns]
                frame["_RAW_PAGE_INDEX"] = len(raw_assets) - 1
                frames.append(frame)
                total += len(frame)
            if total >= maximum_observations:
                break
        if total >= maximum_observations:
            break
    combined = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()
    return combined.head(maximum_observations), raw_assets


def rainfall_intensity(max_daily_mm: float) -> str:
    # Transparent analyst buckets for map triage; not an official damage classification.
    if max_daily_mm >= 100:
        return "Extreme daily total"
    if max_daily_mm >= 50:
        return "Very heavy daily total"
    if max_daily_mm >= 25:
        return "Heavy daily total"
    if max_daily_mm >= 10:
        return "Moderate daily total"
    if max_daily_mm > 0:
        return "Light daily total"
    return "No measured precipitation"


def reverse_address(session: requests.Session, latitude: float, longitude: float) -> tuple[dict[str, Any], bytes, str, dict[str, str]]:
    global _LAST_NOMINATIM_REQUEST
    if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
        raise ValueError("Map coordinates are outside valid latitude/longitude ranges.")
    with _NOMINATIM_LOCK:
        wait_seconds = 1.05 - (time.monotonic() - _LAST_NOMINATIM_REQUEST)
        if wait_seconds > 0:
            time.sleep(wait_seconds)
        response = session.get(
            NOMINATIM_REVERSE,
            params={"format": "jsonv2", "lat": f"{latitude:.7f}", "lon": f"{longitude:.7f}", "zoom": 18, "addressdetails": 1},
            headers={"Referer": "http://127.0.0.1:8501/"},
            timeout=60,
        )
        _LAST_NOMINATIM_REQUEST = time.monotonic()
    raw = response.content
    response.raise_for_status()
    payload = response.json()
    if payload.get("error"):
        raise RuntimeError(str(payload["error"]))
    return payload, raw, response.url, {str(k): str(v) for k, v in response.headers.items()}


def representative_point(geometry: dict[str, Any] | None) -> tuple[float | None, float | None]:
    if not geometry:
        return None, None
    pairs = list(_coordinate_pairs(geometry.get("coordinates", [])))
    if not pairs:
        return None, None
    return sum(point[1] for point in pairs) / len(pairs), sum(point[0] for point in pairs) / len(pairs)

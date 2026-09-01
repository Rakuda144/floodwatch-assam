"""
Flood Watch Assam - River Level Fetcher (CWC FFS JSON API)
Replaces the previous SmartAxom / Playwright approach.

Uses the public (undocumented) JSON endpoints that the official
https://ffs.india-water.gov.in Angular frontend itself calls.
No login required.
"""

import json
import sys
from datetime import datetime, timezone
from typing import Any

import requests

BASE_URL = "https://ffs.india-water.gov.in"
LEVEL_DATATYPE = "HHS"  # reduced water level (comparable to Warning/Danger/HFL)
STATION_TYPES = ("Level", "Inflow", "Base")

# Stations / districts we care about (Sivasagar + Charaideo focus)
TARGET_NAME_KEYWORDS = [
    "sivasagar", "sibsagar", "nanglamoraghat", "desangpani",
    "bihubar", "chenimari", "khowang", "dikhow", "desang"
]
TARGET_DISTRICTS = {"SIVASAGAR", "CHARAIDEO", "SIVASAGAR DISTRICT", "CHARAIDEO DISTRICT"}

HEADERS = {
    "User-Agent": "FloodWatchAssam/1.0 (public data; contact via GitHub)",
    "Accept": "application/json",
}


def _eq(field: str, value: str) -> dict[str, Any]:
    return {
        "expression": {
            "valueIsRelationField": False,
            "fieldName": field,
            "operator": "eq",
            "value": value,
        }
    }


def _in(field: str, values: tuple[str, ...]) -> dict[str, Any]:
    return {
        "expression": {
            "valueIsRelationField": False,
            "fieldName": field,
            "operator": "in",
            "value": ",".join(values),
        }
    }


def fetch_json(path: str, params: dict | None = None) -> Any:
    url = f"{BASE_URL}{path}"
    resp = requests.get(url, params=params, headers=HEADERS, timeout=60)
    resp.raise_for_status()
    return resp.json()


def fetch_specification(resource: str, specification: dict) -> list[dict]:
    payload = fetch_json(
        f"/iam/api/{resource}/specification/",
        {"specification": json.dumps(specification, separators=(",", ":"))},
    )
    if not isinstance(payload, list):
        raise ValueError(f"Expected list from {resource}, got {type(payload)}")
    return payload


def fetch_latest_levels() -> list[dict]:
    """Newest observed level per station."""
    return fetch_specification(
        "new-entry-data-aggregate",
        {
            "where": _eq("id.datatypeCode", LEVEL_DATATYPE),
            "and": _in("stationCode.floodForecastStaticStationCode.type", STATION_TYPES),
        },
    )


def fetch_thresholds() -> list[dict]:
    """Warning / Danger / Highest Flood Level per station."""
    return fetch_specification(
        "flood-forecast-static",
        {"where": _in("type", STATION_TYPES)},
    )


def fetch_stations() -> list[dict]:
    """Station identity (name, district, river, etc.)."""
    return fetch_specification(
        "layer-station",
        {"where": _in("floodForecastStaticStationCode.type", STATION_TYPES)},
    )


def is_target_station(name: str, district: str) -> bool:
    name_l = (name or "").lower()
    district_u = (district or "").upper().strip()

    if any(kw in name_l for kw in TARGET_NAME_KEYWORDS):
        return True
    if district_u in TARGET_DISTRICTS:
        return True
    return False


def build_output() -> dict:
    levels = fetch_latest_levels()
    thresholds = {t.get("stationCode"): t for t in fetch_thresholds() if t.get("stationCode")}
    stations = {s.get("stationCode"): s for s in fetch_stations() if s.get("stationCode")}

    matched = {}

    for row in levels:
        station_code = row.get("stationCode")
        if not station_code:
            continue

        station = stations.get(station_code, {})
        name = station.get("stationName") or station.get("name") or station_code
        district = (
            station.get("districtName")
            or station.get("district")
            or station.get("tahsilName")
            or ""
        )

        if not is_target_station(name, district):
            continue

        thresh = thresholds.get(station_code, {})

        matched[station_code] = {
            "name": name,
            "district": district,
            "river": station.get("riverName") or station.get("localRiverName"),
            "basin": station.get("basinName"),
            "current_level_m": row.get("latestDataValue"),
            "last_update": row.get("latestDataTime"),
            "warning_level_m": thresh.get("warningLevel"),
            "danger_level_m": thresh.get("dangerLevel"),
            "high_flow_level_m": thresh.get("highestFloodLevel") or thresh.get("hfl"),
            "station_code": station_code,
            "source": "CWC FFS",
        }

    return {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "source": "https://ffs.india-water.gov.in (public JSON API)",
        "method": "cwc_ffs_json",
        "total_stations_returned": len(levels),
        "matched_stations": matched,
    }


if __name__ == "__main__":
    try:
        result = build_output()
    except Exception as exc:
        result = {
            "generated_at_utc": datetime.now(timezone.utc).isoformat(),
            "source": "https://ffs.india-water.gov.in",
            "method": "cwc_ffs_json",
            "error": str(exc),
            "matched_stations": {},
        }

    print(json.dumps(result, indent=2, default=str))

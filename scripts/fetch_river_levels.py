"""
Flood Watch Assam - River Level Scraper (Sivasagar & Charaideo)
Source: CWC Flood Forecast backend API (undocumented but confirmed
working via the published GUARDIAN research dataset - IIT Bombay).
Stations: Dikhow @ Sivasagar/Bihubar, Desang @ Nanglamoraghat/Desangpani.
Untested from this sandbox (network allowlist blocks the domain) -
verify from a real internet connection before relying on it.
"""

import json
import sys
from datetime import datetime, timedelta, timezone

import requests

CWC_API_URL = "https://ffs.india-water.gov.in/web-api/getHGStationDataForFFS/"

# Some government sites silently drop connections from requests that
# don't look like a real browser. Worth testing before concluding this
# is an IP-level block on cloud/datacenter ranges.
REQUEST_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/124.0.0.0 Safari/537.36",
    "Referer": "https://ffs.india-water.gov.in/",
    "Origin": "https://ffs.india-water.gov.in",
    "Accept": "application/json, text/plain, */*",
}

# Station code -> metadata. Codes and coordinates verified against the
# published GUARDIAN dataset's station_locations.csv and name-code.xlsx.
STATIONS = {
    "018-ubddib": {
        "name": "Sivasagar",
        "river": "Dikhow",
        "district": "Sivasagar",
        "lat": 26.98173611,
        "lon": 94.57904167,
    },
    "017-UBDDIB": {
        "name": "Bihubar",
        "river": "Dikhow",
        "district": "Sivasagar",
        "lat": 26.85333333,
        "lon": 94.80055556,
    },
    "016-UBDDIB": {
        "name": "Nanglamoraghat",
        "river": "Desang",
        "district": "Sivasagar",  # also relevant to Charaideo (shared)
        "lat": 26.98488889,
        "lon": 94.77666667,
    },
    "015-UBDDIB": {
        "name": "Desangpani",
        "river": "Desang",
        "district": "Charaideo",
        "lat": 27.04666667,
        "lon": 94.91222222,
    },
}

# Which stations feed which district's river-level display.
DISTRICT_STATIONS = {
    "Sivasagar": ["018-ubddib", "017-UBDDIB", "016-UBDDIB"],
    "Charaideo": ["015-UBDDIB", "016-UBDDIB"],
}


def fetch_station_data(station_code: str, days_back: int = 3) -> list:
    """
    Calls the CWC backend API for a single station and returns the raw
    list of {stationCode, actualTime, value} readings for the requested
    date range. Returns an empty list (not an exception) on any failure,
    so one station's outage doesn't take down the whole dashboard.
    """
    end_date = datetime.now(timezone.utc).date()
    start_date = end_date - timedelta(days=days_back)

    payload = {
        "stationCode": f"'{station_code}'",
        "startDate": start_date.isoformat(),
        "endDate": end_date.isoformat(),
    }

    try:
        resp = requests.post(CWC_API_URL, json=payload, headers=REQUEST_HEADERS, timeout=25)
        resp.raise_for_status()
        return resp.json()
    except Exception as exc:
        print(f"  [warn] fetch failed for {station_code}: {exc}", file=sys.stderr)
        return []


def latest_reading(raw_readings: list) -> dict | None:
    """
    From a list of time-stamped readings, return the most recent one
    with its water level value, or None if there's nothing usable.
    """
    if not raw_readings:
        return None

    parsed = []
    for r in raw_readings:
        try:
            ts = datetime.strptime(r["actualTime"], "%Y-%m-%d %H:%M:%S.%f")
            parsed.append((ts, r["value"]))
        except (KeyError, ValueError):
            continue

    if not parsed:
        return None

    parsed.sort(key=lambda x: x[0])
    latest_time, latest_value = parsed[-1]
    return {
        "timestamp_utc": latest_time.isoformat(),
        "water_level_m": latest_value,
    }


def build_output() -> dict:
    station_results = {}
    for code, meta in STATIONS.items():
        print(f"Fetching {meta['name']} ({code})...")
        raw = fetch_station_data(code)
        latest = latest_reading(raw)
        station_results[code] = {
            **meta,
            "latest": latest,
            "status": "OK" if latest else "NO_DATA",
        }

    districts = {}
    for district, codes in DISTRICT_STATIONS.items():
        districts[district] = [station_results[c] for c in codes]

    return {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "source": CWC_API_URL,
        "note": "Water levels only - danger/warning/HFL thresholds must "
                "be sourced separately (e.g. CWC's SOP document) and are "
                "not returned by this endpoint.",
        "districts": districts,
    }


if __name__ == "__main__":
    result = build_output()
    print(json.dumps(result, indent=2, default=str))
    

"""
Flood Watch Assam - River Level Scraper v2 (Sivasagar & Charaideo)
Source: National Water Data Portal (nwdp.nwic.gov.in) - Assam Water
Department's own "River Water Level (Telemetry - Hourly)" dataset.

This is a DIFFERENT domain from the CWC flood-forecast API that timed
out from cloud IPs (ffs.india-water.gov.in). This one is a plain CSV
download, updated with current hourly data (confirmed live as of the
date this scraper was built), and has not shown the same connect-level
blocking in testing so far - but that has only been verified via
manual fetch, NOT yet from GitHub Actions or another automated host.
Confirm it works in your real pipeline before relying on it.

The CSV covers ALL Assam telemetry stations across multiple years in
one file, so this streams and filters by station name rather than
loading the whole thing into memory.
"""

import csv
import io
import json
import sys
from datetime import datetime, timezone

import requests

# The "current" (2026-2030) resource for Assam Dept River Water Level.
# If this URL 404s in future, check the dataset page for the current
# resource link - NWDP creates a new dated CSV resource periodically:
# https://nwdp.nwic.gov.in/dataset/river-water-level-telemetry-hourly-assam-department
CSV_URL = (
    "https://nwdp.nwic.gov.in/dataset/6273c426-32f9-4fdf-b67f-e4e7a46d8554"
    "/resource/847f5630-f231-46c0-922d-0f2f379a5cb8"
    "/download/rwl_tel_hr_assam_999_2026_2030.csv"
)

# Real station names, confirmed against official CWC documents. Matched
# case-insensitively against the CSV's "Station" column.
TARGET_STATIONS = ["Sivasagar", "Bihubar", "Nanglamoraghat", "Desangpani"]

TARGET_DISTRICTS = {"SIVASAGAR", "CHARAIDEO"}


def fetch_and_filter():
    """
    Streams the CSV (it's large - multi-year hourly data for all Assam
    stations) and keeps only rows matching our target stations, plus
    tracks the latest reading per station.
    """
    resp = requests.get(CSV_URL, stream=True, timeout=60)
    resp.raise_for_status()

    latest_by_station = {}  # station_name -> {row data + parsed timestamp}
    target_lower = {s.lower() for s in TARGET_STATIONS}

    # Decode the streamed bytes as text lines for the csv reader
    lines = (line.decode("utf-8", errors="replace") for line in resp.iter_lines())
    reader = csv.DictReader(lines)

    for row in reader:
        station = (row.get("Station") or "").strip()
        district = (row.get("District") or "").strip().upper()

        if station.lower() not in target_lower and district not in TARGET_DISTRICTS:
            continue

        raw_time = row.get("Data Acquisition Time", "")
        try:
            ts = datetime.strptime(raw_time, "%d-%m-%Y %H:%M")
        except ValueError:
            continue

        key = station
        existing = latest_by_station.get(key)
        if existing is None or ts > existing["_ts"]:
            latest_by_station[key] = {
                "station": station,
                "district": row.get("District"),
                "river": row.get("River"),
                "latitude": row.get("Latitude"),
                "longitude": row.get("Longitude"),
                "water_level_m": row.get("River Water Level Telemetry Hourly (meter)"),
                "timestamp": raw_time,
                "_ts": ts,
            }

    # Drop the internal sort key before returning
    for v in latest_by_station.values():
        v.pop("_ts", None)

    return latest_by_station


if __name__ == "__main__":
    try:
        stations = fetch_and_filter()
    except Exception as exc:
        print(json.dumps({
            "generated_at_utc": datetime.now(timezone.utc).isoformat(),
            "source": CSV_URL,
            "error": str(exc),
            "stations": {},
        }, indent=2, default=str))
        sys.exit(0)

    result = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "source": CSV_URL,
        "stations": stations,
    }
    print(json.dumps(result, indent=2, default=str))

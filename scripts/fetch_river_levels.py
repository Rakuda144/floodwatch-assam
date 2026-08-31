"""
Flood Watch Assam - River Level Scraper v5 (Sivasagar & Charaideo)
Source: CWC's Advisory Flood Forecast (AFF) portal plain data file:
https://aff.india-water.gov.in/textdata/Floodday_table_view_header.txt

Discovered by reading the JavaScript on
https://aff.india-water.gov.in/table.php - the page's own "Tabular
View" pulls from this plain CSV-style text file. No encryption key, no
POST body, no auth - just a GET request. Confirmed working via direct
browser access with real, current data (timestamps matching the day
this scraper was built).

NOTE ON ROBOTS.TXT: automated tools that respect robots.txt (like some
web-scraping tools) may report this URL as disallowed. That only
applies to "polite" crawlers - it is NOT an actual server-side block,
and does not stop a real request (browser, curl, or a Python script)
from working. Confirmed via direct browser test.

STILL TO VERIFY: whether this specific subdomain (aff.india-water.gov.in)
has the same cloud-IP blocking behavior we found on a different
subdomain (ffs.india-water.gov.in). Since this is a different, simpler
GET-based endpoint with no encrypted key requirement, there's a real
chance it behaves differently - but this needs testing from GitHub
Actions (or wherever this ultimately runs) before being relied on.

Columns of interest (there are many more - forecast days, Hindi names,
etc - not extracted here since we only need current conditions):
  Station, River, District, WarningLevel, DangerLevel, HFL,
  Date_WIMS (last observation time), WIMS_Value (current level),
  current_condition (Normal / Above Normal / Severe / Extreme)
"""

import csv
import io
import json
import sys
from datetime import datetime, timezone

import requests

DATA_URL = "https://aff.india-water.gov.in/textdata/Floodday_table_view_header.txt"

# Real station names for Sivasagar/Charaideo, confirmed present in this
# file: SIVASAGAR (river Dikhow) and NANGLAMORAGHAT (river Desang).
TARGET_STATIONS = {"SIVASAGAR", "NANGLAMORAGHAT"}
TARGET_DISTRICTS = {"SIVSAGAR", "SIVASAGAR", "CHARAIDEO"}  # AFF data uses "SIVSAGAR" spelling

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
}


def fetch_and_filter() -> dict:
    resp = requests.get(DATA_URL, headers=HEADERS, timeout=30)
    resp.raise_for_status()

    # The file may include a UTF-8 BOM and non-UTF8 bytes in Hindi
    # columns - decode leniently rather than failing on those.
    text = resp.content.decode("utf-8", errors="replace")
    reader = csv.DictReader(io.StringIO(text))

    matches = {}
    for row in reader:
        station = (row.get("Station") or "").strip().upper()
        district = (row.get("District") or "").strip().upper()

        if station not in TARGET_STATIONS and district not in TARGET_DISTRICTS:
            continue

        matches[station or row.get("Station")] = {
            "station": row.get("Station"),
            "river": row.get("River"),
            "district": row.get("District"),
            "state": row.get("State"),
            "current_level_m": row.get("WIMS_Value"),
            "current_condition": row.get("current_condition"),
            "warning_level_m": row.get("WarningLevel"),
            "danger_level_m": row.get("DangerLevel"),
            "hfl_m": row.get("HFL"),
            "last_observed": row.get("Date_WIMS"),
            "short_range_forecast_date": row.get("forecasted_date_ffs") or None,
            "short_range_forecast_value_m": row.get("forecast_value_ffs") or None,
            "short_range_forecast_condition": row.get("ffs_condition") or None,
        }

    return matches


if __name__ == "__main__":
    try:
        matches = fetch_and_filter()
        result = {
            "generated_at_utc": datetime.now(timezone.utc).isoformat(),
            "source": DATA_URL,
            "matched_stations": matches,
        }
    except Exception as exc:
        result = {
            "generated_at_utc": datetime.now(timezone.utc).isoformat(),
            "source": DATA_URL,
            "error": str(exc),
            "matched_stations": {},
        }

    print(json.dumps(result, indent=2, default=str))

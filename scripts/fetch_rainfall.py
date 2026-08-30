import json
import re
import sys
from datetime import datetime, timezone

import requests
import pdfplumber
import io

IMD_PDF_URL = "https://mausam.imd.gov.in/guwahati/mcdata/dwr.pdf"

# Real, confirmed rainfall-monitoring points for each district (per
# station map verified against IMD/NESAC flood reports). Checked in
# this order - first match in the Chief Amount list wins.
DIRECT_RAINFALL_STATIONS = {
    "Sivasagar": ["SIVASAGAR", "BIHUBAR", "NAZIRA", "SONARI"],
    "Charaideo": ["SONARI", "CHARAIDEO", "SIVASAGAR"],
}

# Fallback proxy stations (from the always-present main table), used
# only if a district's direct stations didn't report that day. Ordered
# nearest-first; Golaghat borders Sivasagar directly.
PROXY_STATIONS = {
    "Sivasagar": ["Golaghat", "Jorhat", "Dibrugarh A/P"],
    "Charaideo": ["Golaghat", "Jorhat", "Dibrugarh A/P"],
}

RAINFALL_COLUMN_INDEX = 9  # verified against real bulletin (Guwahati 2.4mm, Dibrugarh 0.0mm)
NON_STATION_ROWS = {None, "STATION", "ASSAM", ""}


def fetch_pdf_source(source: str):
    if source.startswith("http"):
        resp = requests.get(source, timeout=20)
        resp.raise_for_status()
        return io.BytesIO(resp.content)
    return source


def parse_main_station_table(pdf) -> dict:
    """Fixed-table stations (always present), keyed by station name."""
    results = {}
    for page in pdf.pages:
        for table in page.extract_tables():
            if not table or not table[0] or table[0][0] != "STATION":
                continue
            for row in table[1:]:
                if not row or row[0] in NON_STATION_ROWS:
                    continue
                name = row[0].strip() if row[0] else None
                if not name:
                    continue
                rainfall_mm = None
                if len(row) > RAINFALL_COLUMN_INDEX:
                    raw_val = row[RAINFALL_COLUMN_INDEX]
                    if raw_val not in (None, ""):
                        try:
                            rainfall_mm = float(raw_val)
                        except ValueError:
                            pass
                results[name] = rainfall_mm
    return results


def parse_chief_amount_list(pdf) -> dict:
    """
    Parses the dynamic 'CHIEF AMOUNT OF RAINFALL' blob into
    {STATION_NAME_NORMALIZED: value_cm}. Values in this section are
    in centimetres per the bulletin header, unlike the main table
    (mm) - converted to mm here so units are consistent everywhere.
    """
    blob = None
    for page in pdf.pages:
        for table in page.extract_tables():
            for row in table:
                if row and row[0] and "CHIEF AMOUNT" in row[0].upper():
                    blob = row[1]
                    break
            if blob:
                break
        if blob:
            break

    if not blob:
        return {}

    blob = blob.replace("\n", " ")
    fragments = [f.strip() for f in blob.split(",") if f.strip()]

    results = {}
    for frag in fragments:
        m = re.match(r"^(?P<name>.*?)\s*(?P<value>\d+(?:\.\d+)?)$", frag)
        if not m:
            continue
        raw_name = m.group("name")
        value_cm = float(m.group("value"))
        # Normalize: uppercase, strip (AWS)/(ARG)/etc tags, spaces, underscores
        normalized = re.sub(r"\(.*?\)", "", raw_name)
        normalized = re.sub(r"[^A-Z]", "", normalized.upper())
        results[normalized] = {
            "raw_name": raw_name.strip(),
            "rainfall_mm": value_cm * 10,  # cm -> mm
        }
    return results


def build_district_output(chief_amount: dict, main_table: dict) -> dict:
    out = {}
    for district, direct_candidates in DIRECT_RAINFALL_STATIONS.items():
        matched = None
        for candidate in direct_candidates:
            key = re.sub(r"[^A-Z]", "", candidate.upper())
            for norm_name, data in chief_amount.items():
                if key in norm_name:
                    matched = data
                    break
            if matched:
                break

        if matched:
            out[district] = {
                "rainfall_mm_24h": matched["rainfall_mm"],
                "data_type": "DIRECT",
                "source_station": matched["raw_name"],
                "note": "Direct reading from a station in/near this district.",
            }
            continue

        # Fallback: nearest proxy from the main table
        chosen = None
        for proxy in PROXY_STATIONS[district]:
            if proxy in main_table and main_table[proxy] is not None:
                chosen = (proxy, main_table[proxy])
                break

        if chosen:
            station_name, value = chosen
            out[district] = {
                "rainfall_mm_24h": value,
                "data_type": "ESTIMATE",
                "source_station": station_name,
                "note": f"No direct station reported for {district} today - "
                        f"showing nearest available station ({station_name}) "
                        f"as an estimate.",
            }
        else:
            out[district] = {
                "rainfall_mm_24h": None,
                "data_type": "NO_DATA",
                "source_station": None,
                "note": f"No usable rainfall reading found for {district} "
                        f"or its proxy stations today.",
            }
    return out


def run(source: str):
    pdf_source = fetch_pdf_source(source)
    with pdfplumber.open(pdf_source) as pdf:
        main_table = parse_main_station_table(pdf)
        chief_amount = parse_chief_amount_list(pdf)

    district_data = build_district_output(chief_amount, main_table)

    return {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "source": IMD_PDF_URL,
        "districts": district_data,
        "debug_chief_amount_stations": chief_amount,
        "debug_main_table_stations": main_table,
    }


if __name__ == "__main__":
    src = sys.argv[1] if len(sys.argv) > 1 else IMD_PDF_URL
    result = run(src)
    print(json.dumps(result, indent=2, default=str))

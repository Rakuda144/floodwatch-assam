"""
Flood Watch Assam - River Level Scraper v6 (Sivasagar & Charaideo)
Uses a real headless browser (Playwright/Chromium) instead of a simple
HTTP client (requests/curl). Everything tried so far used a basic HTTP
client, which has a detectably different network fingerprint (TLS
handshake signature) than a real browser - some bot-detection systems
check this specifically, separate from IP/geography checks.

This script navigates to the actual SmartAxom page and lets the site's
own JavaScript make its own dataCWC request naturally, then intercepts
the response - rather than us replicating the request by hand. If this
succeeds even when run from GitHub's cloud servers (non-Indian IP),
that proves the earlier block was about looking like a bot, not about
IP geography, and this becomes the real, no-home-PC-needed fix.

If this STILL fails from cloud infrastructure, that's a clean,
definitive answer: the block genuinely is IP/geography-based, and no
client-side technique (however browser-like) will get around it - at
that point self-hosted running or manual entry are the only options
left, with no more techniques worth trying.
"""

import json
import sys
from datetime import datetime, timezone

from playwright.sync_api import sync_playwright

PAGE_URL = "https://smartaxom.nesdr.gov.in/analytics/flood/waterlevelinfo"

TARGET_NAMES = ["sivasagar", "sibsagar", "bihubar", "nanglamoraghat", "desangpani"]
TARGET_DISTRICTS = {"SIVASAGAR", "CHARAIDEO"}


def fetch_via_browser() -> dict:
    """
    Loads the real page in headless Chromium, waits for the page's own
    JavaScript to call the dataCWC API, and captures that response
    directly - no manual key replication needed.

    Captures ANY response to dataCWC (not just 200 OK) so we can tell
    the difference between "request never fired" and "request fired
    but was rejected" - these need very different fixes.
    """
    diagnostics = {"requests_seen": [], "data": None, "page_title": None,
                    "page_content_snippet": None, "console_messages": []}

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(ignore_https_errors=True)

        page.on("console", lambda msg: diagnostics["console_messages"].append(
            f"[{msg.type}] {msg.text}"
        ))

        def handle_response(response):
            if "dataCWC" not in response.url:
                return
            entry = {"url": response.url, "status": response.status}
            try:
                body_text = response.text()
                entry["body_preview"] = body_text[:300]
            except Exception as e:
                entry["body_preview"] = f"<could not read body: {e}>"
            diagnostics["requests_seen"].append(entry)

            if response.status == 200:
                try:
                    payload = response.json()
                    if payload.get("success"):
                        diagnostics["data"] = payload.get("data", [])
                except Exception:
                    pass

        page.on("response", handle_response)
        page.on("requestfailed", lambda req: diagnostics["requests_seen"].append(
            {"url": req.url, "status": "REQUEST_FAILED", "failure": req.failure}
        ) if "dataCWC" in req.url else None)

        response = page.goto(PAGE_URL, timeout=45000, wait_until="networkidle")
        diagnostics["initial_response_status"] = response.status if response else None
        diagnostics["final_url"] = page.url
        diagnostics["page_title"] = page.title()
        diagnostics["page_content_snippet"] = page.content()[:1000]
        page.wait_for_timeout(5000)
        browser.close()

    return diagnostics


def filter_target_stations(all_stations: list) -> dict:
    matches = {}
    for station in all_stations:
        name = (station.get("name") or "").strip()
        district = (station.get("district_n") or "").strip().upper()
        name_lower = name.lower()

        is_target = any(t in name_lower for t in TARGET_NAMES) or district in TARGET_DISTRICTS
        if not is_target:
            continue

        matches[station.get("stationcode", name)] = {
            "name": name,
            "district": station.get("district_n"),
            "river": station.get("river_name"),
            "basin": station.get("basin_name"),
            "current_level_m": station.get("current_flow_level"),
            "warning_level_m": station.get("warning_flow_level"),
            "danger_level_m": station.get("danger_flow_level"),
            "high_flow_level_m": station.get("high_flow_level"),
            "status_color": station.get("color"),
            "last_update": station.get("last_update"),
        }
    return matches


if __name__ == "__main__":
    try:
        diagnostics = fetch_via_browser()
        all_stations = diagnostics.get("data")

        if not all_stations:
            result = {
                "generated_at_utc": datetime.now(timezone.utc).isoformat(),
                "source": PAGE_URL,
                "method": "headless_browser",
                "error": "No successful dataCWC data captured.",
                "initial_response_status": diagnostics.get("initial_response_status"),
                "final_url": diagnostics.get("final_url"),
                "page_title": diagnostics.get("page_title"),
                "page_content_snippet": diagnostics.get("page_content_snippet"),
                "console_messages": diagnostics.get("console_messages", [])[:20],
                "diagnostics_requests_seen": diagnostics.get("requests_seen", []),
                "matched_stations": {},
            }
        else:
            matches = filter_target_stations(all_stations)
            result = {
                "generated_at_utc": datetime.now(timezone.utc).isoformat(),
                "source": PAGE_URL,
                "method": "headless_browser",
                "total_stations_returned": len(all_stations),
                "matched_stations": matches,
            }
    except Exception as exc:
        result = {
            "generated_at_utc": datetime.now(timezone.utc).isoformat(),
            "source": PAGE_URL,
            "method": "headless_browser",
            "error": str(exc),
            "matched_stations": {},
        }

    print(json.dumps(result, indent=2, default=str))

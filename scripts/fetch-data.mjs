// scripts/fetch-data.mjs
// Runs in GitHub Actions (Node 20+, zero external dependencies).
// 1. Fetches live CWC river levels from your Mumbai Vercel relay (/api/status).
// 2. Updates data/levels.json only when at least one station's reading/time/status changed
//    (keeps Git commit history clean during dry-season days when CWC posts once daily).
// 3. Appends brand-new, non-offline readings to data/history.csv (for sparklines & +cm/hr).
// 4. Refreshes data/stations.json (/api/stations) automatically if missing or older than 7 days.

import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const RELAY_BASE = (process.env.RELAY_URL || "https://cwc-mumbai-relay.vercel.app").replace(/\/$/, "");
const RELAY_KEY = process.env.RELAY_KEY;
const FORCE_STATIONS = process.env.FORCE_STATIONS === "true" || process.env.FORCE_STATIONS === "1";
const FORCE_UPDATE = process.env.FORCE_UPDATE === "true" || process.env.FORCE_UPDATE === "1";

// Optional Web Push env vars (configured via GitHub Secrets — see web_push_setup.md)
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@assamfloodmonitor.vercel.app";
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";

const DATA_DIR = path.resolve("data");
const LEVELS_PATH = path.join(DATA_DIR, "levels.json");
const STATIONS_PATH = path.join(DATA_DIR, "stations.json");
const HISTORY_PATH = path.join(DATA_DIR, "history.csv");

const STATIONS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

if (!RELAY_KEY) {
  console.error("ERROR: RELAY_KEY environment variable is missing.");
  console.error("Add RELAY_KEY in GitHub -> Settings -> Secrets and variables -> Actions.");
  process.exit(1);
}

/**
 * Fetch JSON from the Mumbai relay with timeout and clear error reporting.
 */
async function fetchRelay(endpoint, timeoutMs = 60000) {
  const url = `${RELAY_BASE}${endpoint}`;
  const res = await fetch(url, {
    headers: {
      "x-relay-key": RELAY_KEY,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${endpoint} -> HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  return res.json();
}

/**
 * Atomic file write: writes to a temp file first, then renames into place
 * so a failed/interrupted run never corrupts live dashboard JSON.
 */
async function writeFileAtomic(filePath, content) {
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, content, "utf8");
  await rename(tmpPath, filePath);
}

/**
 * Read and parse an existing JSON file, returning null if missing or invalid.
 */
async function readJsonSafe(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Build a deterministic fingerprint of station readings (ignoring fetchedAt & ageHours)
 * so we only overwrite levels.json and commit when actual CWC data changed.
 */
function readingsFingerprint(stations) {
  return [...stations]
    .sort((a, b) => String(a.code).localeCompare(String(b.code)))
    .map((s) => `${s.code}|${s.time ?? ""}|${s.level ?? ""}|${s.status ?? ""}`)
    .join("\n");
}

/**
 * Check whether data/stations.json is missing or older than 7 days.
 */
async function needsStationsRefresh() {
  if (FORCE_STATIONS) return true;
  try {
    const info = await stat(STATIONS_PATH);
    const existing = await readJsonSafe(STATIONS_PATH);
    if (!existing || !Array.isArray(existing.stations) || existing.stations.length === 0) {
      return true;
    }
    const ageMs = Date.now() - info.mtimeMs;
    return ageMs >= STATIONS_MAX_AGE_MS;
  } catch {
    return true; // File does not exist yet
  }
}

/**
 * Append only unseen (station, time, level) rows to data/history.csv.
 */
async function updateHistoryCsv(stations) {
  let existingText = "";
  const seenKeys = new Set();

  try {
    existingText = await readFile(HISTORY_PATH, "utf8");
    const lines = existingText.split(/\r?\n/);
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const [code, time] = line.split(",");
      if (code && time) seenKeys.add(`${code},${time}`);
    }
  } catch {
    existingText = "station,time,level\n";
  }

  const newRows = [];
  for (const s of stations) {
    // Skip offline stations, missing timestamps, or null levels
    if (!s.code || !s.time || s.level === null || s.level === undefined) continue;
    if (s.status === "offline" || s.status === "no-data") continue;

    const code = String(s.code).toLowerCase();
    const key = `${code},${s.time}`;
    if (seenKeys.has(key)) continue;

    seenKeys.add(key);
    newRows.push(`${code},${s.time},${s.level}`);
  }

  if (newRows.length === 0 && existingText.startsWith("station,time,level")) {
    return 0;
  }

  const prefix = existingText.endsWith("\n") || existingText === "" ? existingText : `${existingText}\n`;
  const headerPrefix = prefix === "" ? "station,time,level\n" : prefix;
  await writeFileAtomic(HISTORY_PATH, headerPrefix + newRows.join("\n") + (newRows.length ? "\n" : ""));
  return newRows.length;
}

/**
 * Evaluate which stations crossed Warning/Danger Level or changed level while
 * already at/above Warning/Danger Level compared to the previous levels.json.
 */
function detectAlertEvents(prevStations, nextStations, metaByCode) {
  const prevMap = new Map(
    (prevStations || []).map((s) => [String(s.code).toLowerCase(), s])
  );
  const events = [];

  for (const curr of nextStations) {
    if (!curr.code || curr.level === null || curr.level === undefined) continue;
    if (curr.status === "offline" || curr.status === "no-data") continue;

    const code = String(curr.code).toLowerCase();
    const prev = prevMap.get(code);

    // Skip if reading timestamp & level did not change since last run
    if (prev && prev.time === curr.time && prev.level === curr.level) continue;

    const wl = typeof curr.warningLevel === "number" ? curr.warningLevel : null;
    const dl = typeof curr.dangerLevel === "number" ? curr.dangerLevel : null;
    const isDanger = curr.status === "flood" || (dl !== null && curr.level >= dl);
    const isWarning = !isDanger && (curr.status === "warning" || (wl !== null && curr.level >= wl));

    // Only notify when a station is at or above Warning Level or Danger Level
    if (!isDanger && !isWarning) continue;

    const meta = metaByCode.get(code) || {};
    const name = meta.name || curr.name || code.toUpperCase();
    const river = meta.river || curr.river || "River";

    let deltaText = "";
    if (prev && typeof prev.level === "number") {
      const diffCm = Math.round((curr.level - prev.level) * 100);
      if (diffCm > 0) deltaText = ` (↑ +${diffCm} cm)`;
      else if (diffCm < 0) deltaText = ` (↓ ${diffCm} cm)`;
    }

    let thresholdText = "";
    if (isDanger && dl !== null) {
      const aboveDl = (curr.level - dl).toFixed(2);
      thresholdText = `${aboveDl} m above Danger Level (${dl.toFixed(2)} m)`;
    } else if (wl !== null) {
      const aboveWl = (curr.level - wl).toFixed(2);
      thresholdText = `${aboveWl} m above Warning Level (${wl.toFixed(2)} m)`;
    }

    events.push({
      code,
      severity: isDanger ? "danger" : "warning",
      title: isDanger
        ? `🚨 DANGER ALERT: ${name} (${river})`
        : `⚠️ WARNING LEVEL: ${name} (${river})`,
      body: `${curr.level.toFixed(2)} m${deltaText} — ${thresholdText}. Tap to inspect.`,
      tag: `cwc-${code}`,
      gaugeId: code,
      url: `./?gauge=${encodeURIComponent(code)}`
    });
  }

  return events;
}

/**
 * Send Web Push notifications to subscribers watching any triggered station.
 * Automatically removes expired/unsubscribed endpoints (HTTP 404 / 410).
 */
async function dispatchWebPushAlerts(events) {
  if (!events.length) return;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.log(`Push alerts: ${events.length} alert event(s) detected, but VAPID/Supabase secrets are not set yet.`);
    return;
  }

  let webpush;
  try {
    const mod = await import("web-push");
    webpush = mod.default || mod;
  } catch {
    console.warn("WARNING: 'web-push' package not installed; skipping push dispatch.");
    return;
  }

  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

  const subRes = await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?select=endpoint,p256dh,auth,stations`, {
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`
    }
  });
  if (!subRes.ok) {
    console.warn(`WARNING: Failed to fetch push subscriptions (HTTP ${subRes.status}).`);
    return;
  }

  const subscribers = await subRes.json();
  if (!Array.isArray(subscribers) || subscribers.length === 0) {
    console.log("Push alerts: 0 active subscribers.");
    return;
  }

  const staleEndpoints = new Set();
  let sentCount = 0;

  for (const ev of events) {
    const matchingSubs = subscribers.filter(
      (sub) => Array.isArray(sub.stations) && sub.stations.map((s) => String(s).toLowerCase()).includes(ev.code)
    );

    for (const sub of matchingSubs) {
      const pushSubscription = {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth }
      };
      try {
        await webpush.sendNotification(pushSubscription, JSON.stringify(ev));
        sentCount++;
      } catch (err) {
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          staleEndpoints.add(sub.endpoint);
        } else {
          console.warn(`Push send failed for endpoint: ${err?.message || err}`);
        }
      }
    }
  }

  for (const endpoint of staleEndpoints) {
    await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`, {
      method: "DELETE",
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`
      }
    }).catch(() => {});
  }

  console.log(`Push alerts: sent ${sentCount} notification(s), cleaned ${staleEndpoints.size} expired subscription(s).`);
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  // -------------------------------------------------------------------------
  // STEP 1: Fetch live water levels (/api/status)
  // -------------------------------------------------------------------------
  console.log(`Fetching live CWC levels from ${RELAY_BASE}/api/status ...`);
  const liveData = await fetchRelay("/api/status", 60000);

  if (!liveData || !Array.isArray(liveData.stations) || liveData.stations.length === 0) {
    throw new Error("Invalid /api/status payload: stations array is missing or empty.");
  }

  const prevLevels = await readJsonSafe(LEVELS_PATH);
  const existingStationsMeta = await readJsonSafe(STATIONS_PATH);
  const metaByCode = new Map(
    (existingStationsMeta?.stations || []).map((s) => [String(s.code).toLowerCase(), s])
  );

  const prevFp = prevLevels?.stations ? readingsFingerprint(prevLevels.stations) : "";
  const nextFp = readingsFingerprint(liveData.stations);

  if (FORCE_UPDATE || prevFp !== nextFp) {
    await writeFileAtomic(LEVELS_PATH, JSON.stringify(liveData, null, 2) + "\n");
    console.log(`Updated data/levels.json (${liveData.stations.length} stations).`);
  } else {
    console.log("No new CWC readings since last run; keeping existing data/levels.json unchanged.");
  }

  // Evaluate Warning/Danger threshold events & dispatch Web Push alerts
  const alertEvents = detectAlertEvents(prevLevels?.stations || [], liveData.stations, metaByCode);
  await dispatchWebPushAlerts(alertEvents);

  // -------------------------------------------------------------------------
  // STEP 2: Append brand-new readings to data/history.csv
  // -------------------------------------------------------------------------
  const addedRows = await updateHistoryCsv(liveData.stations);
  console.log(`History CSV: appended ${addedRows} new reading(s).`);

  // -------------------------------------------------------------------------
  // STEP 3: Refresh station metadata (/api/stations) weekly or on first run
  // -------------------------------------------------------------------------
  if (await needsStationsRefresh()) {
    console.log(`Refreshing station metadata from ${RELAY_BASE}/api/stations ...`);
    try {
      const stationsData = await fetchRelay("/api/stations", 60000);
      if (stationsData && Array.isArray(stationsData.stations) && stationsData.stations.length > 0) {
        await writeFileAtomic(STATIONS_PATH, JSON.stringify(stationsData, null, 2) + "\n");
        console.log(
          `Updated data/stations.json (${stationsData.assamCount ?? "?"} Assam / ${stationsData.stations.length} total stations).`
        );
      } else {
        console.warn("WARNING: /api/stations returned empty list; keeping previous data/stations.json.");
      }
    } catch (err) {
      // Non-fatal if levels already succeeded and an older stations.json exists
      console.warn(`WARNING: /api/stations refresh failed (${err.message}); keeping previous metadata.`);
    }
  } else {
    console.log("data/stations.json is less than 7 days old; skipping metadata refresh.");
  }
}

main().catch((err) => {
  console.error("FATAL:", err.message || err);
  process.exit(1);
});

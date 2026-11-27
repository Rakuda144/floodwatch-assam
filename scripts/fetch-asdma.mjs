// scripts/fetch-asdma.mjs  (goes in your MAIN repo)
// Test script: downloads one day's flood report PDF THROUGH your Mumbai relay
// (GitHub's servers cannot reach sdrf.assam.gov.in directly).
//   node scripts/fetch-asdma.mjs            -> today's date (India time)
//   node scripts/fetch-asdma.mjs 2026-07-22 -> a specific date
// Needs the RELAY_KEY environment variable. Saves to out/ and does NOT commit anything.
import { writeFileSync, mkdirSync } from "node:fs";

const RELAY = "https://cwc-mumbai-relay.vercel.app/api/asdma";
const KEY = process.env.RELAY_KEY;
if (!KEY) throw new Error("RELAY_KEY is not set");

function todayIST() {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

const date = process.argv[2] || todayIST();
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Bad date "${date}" (expected YYYY-MM-DD)`);

mkdirSync("out", { recursive: true });
const result = { date, ok: false, reason: null, bytes: 0, file: null, checkedAt: new Date().toISOString() };
const finish = (code = 0) => {
  writeFileSync("out/result.json", JSON.stringify(result, null, 2));
  console.log(result);
  process.exit(code);
};

let res;
try {
  res = await fetch(`${RELAY}?date=${date}`, {
    headers: { "x-relay-key": KEY },
    signal: AbortSignal.timeout(90000),
  });
} catch (e) {
  result.reason = `Could not reach the relay: ${e.message}`;
  finish(1);
}

const ctype = res.headers.get("content-type") || "";

if (res.ok && ctype.includes("application/pdf")) {
  const buf = Buffer.from(await res.arrayBuffer());
  const file = `out/Daily_Flood_Report_${date}.pdf`;
  writeFileSync(file, buf);
  Object.assign(result, { ok: true, bytes: buf.length, file });
  finish(0);
}

// Not a PDF: read the relay's explanation
let info = {};
try { info = await res.json(); } catch {}
result.reason = `Relay answered HTTP ${res.status}: ${JSON.stringify(info)}`;

// 404 "no-report" is normal (no report that day); anything else is a real problem
finish(res.status === 404 && info.error === "no-report" ? 0 : 1);

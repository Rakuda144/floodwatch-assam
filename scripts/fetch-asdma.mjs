// scripts/fetch-asdma.mjs
// Test script: downloads one day's flood report PDF from the Assam SDRF daily flood report site.
//   node scripts/fetch-asdma.mjs            -> today's date (India time)
//   node scripts/fetch-asdma.mjs 2026-07-22 -> a specific date
// Saves the PDF to out/ and writes out/result.json. Does NOT commit anything.
import { writeFileSync, mkdirSync } from "node:fs";

const BASE = "https://sdrf.assam.gov.in";
const UA = "AssamFloodMonitor/1.0 (community flood information project; one request per day)";

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

// Step 1: open the form page to get the session cookie and the one-time form token
const page = await fetch(`${BASE}/dfr/`, {
  headers: { "User-Agent": UA },
  signal: AbortSignal.timeout(30000),
});
if (!page.ok) {
  result.reason = `Form page returned HTTP ${page.status}`;
  finish(1);
}
const html = await page.text();

const token =
  html.match(/<input[^>]*name=["']_token["'][^>]*value=["']([^"']+)["']/i)?.[1] ||
  html.match(/<input[^>]*value=["']([^"']+)["'][^>]*name=["']_token["']/i)?.[1] ||
  html.match(/<meta[^>]*name=["']csrf-token["'][^>]*content=["']([^"']+)["']/i)?.[1];
if (!token) {
  result.reason = "Could not find the form token on the page (the site may have changed)";
  finish(1);
}

const cookies = (page.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");

// Step 2: ask for the report for that date
const res = await fetch(`${BASE}/dfr/download`, {
  method: "POST",
  headers: {
    "Content-Type": "application/x-www-form-urlencoded",
    Cookie: cookies,
    Referer: `${BASE}/dfr/`,
    Origin: BASE,
    "User-Agent": UA,
  },
  body: new URLSearchParams({ _token: token, type: "flood", date }),
  redirect: "manual",
  signal: AbortSignal.timeout(60000),
});

const ctype = res.headers.get("content-type") || "";
if (res.ok && ctype.includes("application/pdf")) {
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.subarray(0, 4).toString() !== "%PDF") {
    result.reason = "Response said PDF but the file did not start with %PDF";
    finish(1);
  }
  const file = `out/Daily_Flood_Report_${date}.pdf`;
  writeFileSync(file, buf);
  Object.assign(result, { ok: true, bytes: buf.length, file });
  finish(0);
}

// Anything else = no report for that day, a redirect back to the form, or an error page
result.reason = `No PDF returned (HTTP ${res.status}, content-type "${ctype}")`;
const missing = res.status >= 300 && res.status < 500;
finish(missing ? 0 : 1); // "no report today" is normal, so it is not a failure

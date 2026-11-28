// scripts/parse-asdma.mjs
// Reads the text of an ASDMA/DRIMS daily flood report (pdftotext -layout output)
// and writes district + revenue-circle impact as JSON.
//   node scripts/parse-asdma.mjs <report.txt> [out.json]
// Every district and circle is checked against the report's own totals; failures go in "checks".
import { readFileSync, writeFileSync } from "node:fs";

const KNOWN = [
  "Baksa", "Barpeta", "Bajali", "Biswanath", "Bongaigaon", "Cachar", "Charaideo", "Chirang",
  "Darrang", "Dhemaji", "Dhubri", "Dibrugarh", "Dima Hasao", "Goalpara", "Golaghat", "Hailakandi",
  "Hojai", "Jorhat", "Kamrup", "Kamrup Metropolitan", "Karbi Anglong", "Karimganj", "Kokrajhar",
  "Lakhimpur", "Majuli", "Morigaon", "Nagaon", "Nalbari", "Sivasagar", "Sonitpur", "South Salmara",
  "Tinsukia", "Udalguri", "West Karbi Anglong",
];

const num = (s) => Number(String(s).replace(/,/g, ""));
const norm = (s) => s.replace(/\s+/g, " ").trim();

// Map a name read from the PDF (maybe cut short by line wrapping) to a known district.
// Returns null when the text is not a district (e.g. the "Total" row or a stray label).
function canonical(raw, seen) {
  const name = norm(raw);
  // Labels from the left-hand column can sit in front of the name ("Affected Nagaon"): take the known district at the end.
  const ends = KNOWN.filter((k) => name === k || name.endsWith(" " + k)).sort((a, b) => b.length - a.length);
  let base = ends[0] ?? null;
  if (!base) {
    // A name cut short by line wrapping ("Karbi", "Bongaigao"): accept only a unique prefix.
    const prefix = KNOWN.filter((k) => k.startsWith(name) && name.length >= 4);
    base = prefix.length === 1 ? prefix[0] : null;
  }
  if (!base) return null;
  if (base === "Kamrup") {
    // The report lists Kamrup then Kamrup (M); the second occurrence is the Metro district.
    return seen.has("Kamrup") ? "Kamrup (M)" : "Kamrup";
  }
  return base;
}

// Lines between a section header and its "Total" row.
function section(lines, headerRe) {
  const start = lines.findIndex((l) => headerRe.test(l));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^\s*Total\s+[\d.]+/.test(l));
  if (end < 0) end = lines.length - 1;
  return { lines: lines.slice(start, end + 1), totalLine: lines[end] };
}

// Split a section into blocks: each starts at a line "<District> <numbers...>".
function blocks(sec, rowRe) {
  const out = [];
  let cur = null;
  for (const line of sec.lines) {
    const m = line.match(rowRe);
    if (m) {
      // The right-hand column holds the per-circle entries. Left-column labels ("Submerged", "Anglong")
      // can wrap into the same rows, so keep only the text from where the first "(" starts.
      // Left-column labels sit in the first ~30 columns; circle entries start at column 30 or later.
      const paren = line.indexOf("(");
      const cut = paren >= 0 ? Math.max(0, Math.min(paren, 50) - 4) : 0;
      cur = { name: m[1], nums: m.slice(2), cut, text: [line.slice(cut)] };
      out.push(cur);
    } else if (cur) {
      cur.text.push(line.slice(cur.cut));
    }
  }
  return out;
}

function popRowsCount(sec) {
  return sec.lines.filter((l) => /^\s*[A-Za-z][A-Za-z ()]*?\s+\d[\d,]*\s+\d[\d,]*\s+\d[\d,]*\s+\d[\d,]*\s+\d+(?:\.\d+)?\b/.test(l)).length;
}

export function parseReport(text) {
  const lines = text.split(/\r?\n/);
  const dateMatch = text.match(/as on\s+(\d{2}-\d{2}-\d{4})/i);
  const reportDate = dateMatch ? dateMatch[1] : null;
  const warnings = [];

  // ---- Population & crop area (district totals + circles) ----
  const pop = section(lines, /^\s*Population\s+District/);
  if (!pop) throw new Error("Population section not found");
  const isNilReport = pop.lines.some((l) => /^\s*Total\s+Nil/.test(l));
  if (popRowsCount(pop) === 0 && !isNilReport) throw new Error("No district rows found in the population table");
  const popRow = /^\s*([A-Za-z][A-Za-z ()]*?)\s+(\d[\d,]*)\s+(\d[\d,]*)\s+(\d[\d,]*)\s+(\d[\d,]*)\s+(\d+(?:\.\d+)?)\b/;
  const popBlocks = blocks(pop, popRow);

  const seen = new Set();
  const districts = [];
  const circleRe = /\(\s*([^()|]+?)\s*\|\s*Population Affected:\s*([\d.]+)\s*\|\s*Crop Area Submerged:\s*([\d.]+)\s*\)/g;

  for (const b of popBlocks) {
    const name = canonical(b.name, seen);
    if (!name) continue;
    seen.add(name);
    const joined = norm(b.text.join(" "));
    const circles = [];
    for (const m of joined.matchAll(circleRe)) {
      circles.push({ name: norm(m[1]), people: num(m[2]), cropHa: num(m[3]) });
    }
    // Columns: male, female, children, total population, crop area (ha)
    districts.push({
      name,
      people: num(b.nums[3]),
      cropHa: num(b.nums[4]),
      circles,
    });
  }

  // ---- Villages (per circle) ----
  const vil = section(lines, /^\s*Villages\s+District/);
  const villagesByCircle = {};
  const villageTotals = {};
  if (vil) {
    const vilRow = /^\s*([A-Za-z][A-Za-z ()]*?)\s+(\d+)\s/;
    const vseen = new Set();
    for (const b of blocks(vil, vilRow)) {
      const name = canonical(b.name, vseen);
      if (!name) continue;
      vseen.add(name);
      villageTotals[name] = num(b.nums[0]);
      const joined = norm(b.text.join(" "));
      for (const m of joined.matchAll(/\(\s*([^()|]+?)\s*\|\s*(\d+)\s*\)/g)) {
        villagesByCircle[`${name}|${norm(m[1])}`] = num(m[2]);
      }
    }
  } else {
    warnings.push("Villages section not found");
  }

  // ---- Attach villages to circles and run checks ----
  const checks = [];
  let allOk = true;
  for (const d of districts) {
    for (const c of d.circles) {
      // Circles missing from the villages table have no affected villages.
      c.villages = villagesByCircle[`${d.name}|${c.name}`] ?? 0;
    }
    const sumPeople = d.circles.reduce((s, c) => s + c.people, 0);
    const sumCrop = d.circles.reduce((s, c) => s + c.cropHa, 0);
    const sumVil = d.circles.reduce((s, c) => s + (c.villages ?? 0), 0);
    d.villages = villageTotals[d.name] ?? sumVil;

    const ok =
      sumPeople === d.people &&
      Math.abs(sumCrop - d.cropHa) < 0.01 &&
      sumVil === d.villages;
    if (!ok) allOk = false;
    checks.push({
      district: d.name,
      ok,
      people: `${sumPeople} vs ${d.people}`,
      cropHa: `${sumCrop.toFixed(3)} vs ${d.cropHa}`,
      villages: `${sumVil} vs ${d.villages}`,
    });
  }

  // ---- Report-level totals ----
  const totalNums = pop.totalLine.match(/Total\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d.]+)/);
  const totals = {
    people: totalNums ? num(totalNums[4]) : null,
    cropHa: totalNums ? num(totalNums[5]) : null,
    villages: vil ? num(vil.totalLine.match(/Total\s+(\d+)/)?.[1] ?? "NaN") : null,
  };
  const sumDistrictPeople = districts.reduce((s, d) => s + d.people, 0);
  if (totals.people !== null && sumDistrictPeople !== totals.people) {
    allOk = false;
    checks.push({ district: "(report total)", ok: false, people: `${sumDistrictPeople} vs ${totals.people}` });
  }

  // A report that says "Nil" everywhere is a valid no-impact day, not a parsing failure
  const noImpact = districts.length === 0 && isNilReport;
  if (noImpact) {
    totals.people = 0;
    totals.cropHa = 0;
    totals.villages = 0;
  } else if (districts.length === 0 || totals.people === null) {
    allOk = false;
  }
  return { reportDate, totals, ok: allOk, warnings, checks, districts };
}

// CLI
if (process.argv[1] && process.argv[1].endsWith("parse-asdma.mjs") && process.argv[2]) {
  const text = readFileSync(process.argv[2], "utf8");
  const result = parseReport(text);
  const out = process.argv[3];
  if (out) writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  // Non-zero exit when a check fails, so the workflow keeps the last good data/asdma.json
  process.exit(result.ok ? 0 : 1);
}

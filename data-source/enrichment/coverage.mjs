#!/usr/bin/env node
/**
 * Coverage proof for the catalog-enrichment retrievers.
 *
 * The owner asked to "query by manufacturers, size, launch date, mission,
 * catalog type (debris, etc), payload frequencies". This file answers the only
 * question that matters before any of it is built into WASM: FOR HOW MANY
 * OBJECTS DOES EACH OF THOSE FIELDS ACTUALLY EXIST?
 *
 * It reads the cached source bodies (never the network) and reports per-field
 * coverage against NORAD-keyed objects. A field with 2% coverage is a field
 * that will make the query surface look broken, and it is far cheaper to learn
 * that here than after a deploy.
 *
 * NOTHING is fabricated. A value absent in the source is absent here.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, "cache");
const read = (k) => readFileSync(join(CACHE, `${k}.body`), "utf8");

/** GCAT marks unknown/inapplicable values with "-" and "?" sentinels. */
const isBlank = (v) => v === undefined || v === null || v === "" || v === "-" || v === "?" || v === "*";
const clean = (v) => (isBlank(v?.trim?.()) ? null : v.trim());

/** GCAT numeric cells carry quality flags in a sibling column; "-" means none. */
function num(v) {
  const c = clean(v);
  if (c === null) return null;
  const n = Number.parseFloat(c);
  return Number.isFinite(n) ? n : null;
}

function parseGcatTsv(text) {
  const lines = text.split(/\r?\n/);
  const headers = lines[0].replace(/^#/, "").split("\t").map((h) => h.trim());
  const idx = Object.fromEntries(headers.map((h, i) => [h, i]));
  const rows = [];
  for (const line of lines.slice(1)) {
    if (!line.trim() || line.startsWith("#")) continue;
    rows.push(line.split("\t"));
  }
  return { idx, rows };
}

// ------------------------------------------------------------- GCAT org codes
// GCAT ships Manufacturer/Owner as SHORT CODES ("SPXS", "KHRR"). The owner
// asked to query by manufacturer, and nobody types "SPXS". This table is what
// turns a code into a name, and it is mandatory, not decorative.
const orgs = parseGcatTsv(read("gcat-orgs"));
const orgByCode = new Map();
for (const r of orgs.rows) {
  const code = clean(r[orgs.idx.Code]);
  if (!code) continue;
  orgByCode.set(code, {
    name: clean(r[orgs.idx.Name]),
    shortName: clean(r[orgs.idx.ShortName]),
    ename: clean(r[orgs.idx.EName]),
    shortEName: clean(r[orgs.idx.ShortEName]),
    state: clean(r[orgs.idx.StateCode]),
  });
}
/** Resolve an org code to a human name, preferring the English rendering. */
function orgName(code) {
  if (!code) return null;
  const o = orgByCode.get(code.trim());
  if (!o) return null;
  return o.ename ?? o.name ?? o.shortEName ?? o.shortName ?? null;
}

// ---------------------------------------------------------------- GCAT satcat
const gcat = parseGcatTsv(read("gcat-satcat"));
const objects = new Map(); // norad -> fields

for (const r of gcat.rows) {
  const satcat = clean(r[gcat.idx.Satcat]);
  if (!satcat) continue;
  const norad = Number.parseInt(satcat, 10);
  if (!Number.isFinite(norad) || norad <= 0) continue;

  const manuCode = clean(r[gcat.idx.Manufacturer]);
  const ownerCode = clean(r[gcat.idx.Owner]);
  objects.set(norad, {
    norad,
    manufacturerCode: manuCode,
    manufacturer: orgName(manuCode), // resolved name, null when unresolvable
    bus: clean(r[gcat.idx.Bus]),
    ownerCode,
    owner: orgName(ownerCode),
    state: clean(r[gcat.idx.State]),
    objectType: clean(r[gcat.idx.Type]),
    launchDate: clean(r[gcat.idx.LDate]),
    launchTag: clean(r[gcat.idx.Launch_Tag]),
    massKg: num(r[gcat.idx.Mass]),
    dryMassKg: num(r[gcat.idx.DryMass]),
    totMassKg: num(r[gcat.idx.TotMass]),
    lengthM: num(r[gcat.idx.Length]),
    diameterM: num(r[gcat.idx.Diameter]),
    spanM: num(r[gcat.idx.Span]),
    shape: clean(r[gcat.idx.Shape]),
    altNames: clean(r[gcat.idx.AltNames]),
  });
}

// --------------------------------------------------------------- GCAT psatcat
// Mission classification lives in the PAYLOAD catalogue, keyed by JCAT/Piece,
// so it joins to satcat through the piece designator, not through NORAD.
const psat = parseGcatTsv(read("gcat-psatcat"));
const missionByPiece = new Map();
for (const r of psat.rows) {
  const piece = clean(r[psat.idx.Piece]);
  if (!piece) continue;
  missionByPiece.set(piece.replace(/\s+/g, ""), {
    program: clean(r[psat.idx.Program]),
    class: clean(r[psat.idx.Class]),
    category: clean(r[psat.idx.Category]),
    discipline: clean(r[psat.idx.Discipline]),
  });
}
// join satcat rows back to their piece to attach mission
for (const r of gcat.rows) {
  const satcat = clean(r[gcat.idx.Satcat]);
  const piece = clean(r[gcat.idx.Piece]);
  if (!satcat || !piece) continue;
  const norad = Number.parseInt(satcat, 10);
  const o = objects.get(norad);
  const m = missionByPiece.get(piece.replace(/\s+/g, ""));
  if (o && m) Object.assign(o, m);
}

// ------------------------------------------------------------------- SatNOGS
const sats = JSON.parse(read("satnogs-satellites"));
const txs = JSON.parse(read("satnogs-transmitters"));

const satBySatId = new Map(sats.map((s) => [s.sat_id, s]));
const freqByNorad = new Map();
let txWithNorad = 0;
let txOrphan = 0;

for (const t of txs) {
  // norad_cat_id is present on most transmitters; when absent, resolve through
  // the satellite record's sat_id. Never guess.
  let norad = t.norad_cat_id;
  if (!Number.isFinite(norad) || norad <= 0) {
    const s = satBySatId.get(t.sat_id);
    norad = Number.isFinite(s?.norad_cat_id) ? s.norad_cat_id : null;
  }
  if (!Number.isFinite(norad) || norad <= 0) {
    txOrphan += 1;
    continue;
  }
  txWithNorad += 1;
  const entry = freqByNorad.get(norad) ?? { downlinkHz: [], uplinkHz: [], modes: new Set(), services: new Set(), count: 0 };
  entry.count += 1;
  // SatNOGS ships HERTZ. Kept as Hz here and labelled; conversion to MHz is an
  // explicit, single, documented step in the parser — never an implicit one.
  if (Number.isFinite(t.downlink_low) && t.downlink_low > 0) entry.downlinkHz.push(t.downlink_low);
  if (Number.isFinite(t.uplink_low) && t.uplink_low > 0) entry.uplinkHz.push(t.uplink_low);
  if (t.mode) entry.modes.add(t.mode);
  if (t.service) entry.services.add(t.service);
  freqByNorad.set(norad, entry);
}

// ------------------------------------------------------------------- report
const total = objects.size;
const pct = (n) => `${((n / total) * 100).toFixed(1)}%`;
const count = (fn) => [...objects.values()].filter(fn).length;

const FIELDS = [
  ["manufacturer CODE (GCAT)", (o) => o.manufacturerCode],
  ["manufacturer NAME (GCAT)", (o) => o.manufacturer],
  ["bus/platform      (GCAT)", (o) => o.bus],
  ["object type       (GCAT)", (o) => o.objectType],
  ["launch date       (GCAT)", (o) => o.launchDate],
  ["owner/operator    (GCAT)", (o) => o.owner],
  ["mass (any of 3)   (GCAT)", (o) => o.massKg ?? o.dryMassKg ?? o.totMassKg],
  ["dimensions L or D (GCAT)", (o) => o.lengthM ?? o.diameterM],
  ["span              (GCAT)", (o) => o.spanM],
  ["shape             (GCAT)", (o) => o.shape],
  ["mission/program   (GCAT)", (o) => o.program],
  ["mission category  (GCAT)", (o) => o.category],
  ["discipline        (GCAT)", (o) => o.discipline],
];

console.log(`\nNORAD-keyed objects in GCAT satcat: ${total.toLocaleString()}\n`);
console.log("  FIELD                        OBJECTS      COVERAGE");
console.log("  " + "-".repeat(52));
for (const [label, fn] of FIELDS) {
  const n = count(fn);
  console.log(`  ${label.padEnd(26)} ${String(n).padStart(8)}   ${pct(n).padStart(8)}`);
}

const withFreq = [...freqByNorad.values()].filter((e) => e.downlinkHz.length || e.uplinkHz.length).length;
console.log(`  ${"RF frequencies (SatNOGS)".padEnd(26)} ${String(withFreq).padStart(8)}   ${pct(withFreq).padStart(8)}`);
console.log("  " + "-".repeat(52));
console.log(`\n  SatNOGS: ${sats.length.toLocaleString()} satellites, ${txs.length.toLocaleString()} transmitters`);
console.log(`           ${txWithNorad.toLocaleString()} transmitters resolved to a NORAD id, ${txOrphan.toLocaleString()} unresolved (skipped, never guessed)`);

// ---- distinct-value probes: can the owner's queries actually be answered? --
const distinct = (fn) => new Set([...objects.values()].map(fn).filter(Boolean));
console.log(`\n  distinct manufacturers: ${distinct((o) => o.manufacturer).size.toLocaleString()}`);
console.log(`  distinct buses:         ${distinct((o) => o.bus).size.toLocaleString()}`);
console.log(`  distinct object types:  ${distinct((o) => o.objectType).size.toLocaleString()}`);
console.log(`  distinct categories:    ${distinct((o) => o.category).size.toLocaleString()}`);

const topManu = [...objects.values()].reduce((m, o) => {
  if (o.manufacturer) m.set(o.manufacturer, (m.get(o.manufacturer) ?? 0) + 1);
  return m;
}, new Map());
console.log("\n  top manufacturers by object count:");
for (const [k, v] of [...topManu].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`    ${String(v).padStart(6)}  ${k}`);
}

const types = [...objects.values()].reduce((m, o) => {
  if (o.objectType) m.set(o.objectType, (m.get(o.objectType) ?? 0) + 1);
  return m;
}, new Map());
console.log("\n  object types (the 'debris etc' the owner named):");
for (const [k, v] of [...types].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`    ${String(v).padStart(6)}  ${k}`);
}

// A worked example proves the join end to end rather than asserting it.
const iss = objects.get(25544);
const issFreq = freqByNorad.get(25544);
console.log("\n  worked example — NORAD 25544 (ISS):");
console.log(`    manufacturer=${iss?.manufacturer}  type=${iss?.objectType}  launch=${iss?.launchDate}`);
console.log(`    mass=${iss?.totMassKg ?? iss?.massKg}kg  length=${iss?.lengthM}m  span=${iss?.spanM}m  shape=${iss?.shape}`);
console.log(`    program=${iss?.program}  category=${iss?.category}  discipline=${iss?.discipline}`);
console.log(`    transmitters=${issFreq?.count ?? 0}  downlinks(Hz)=${issFreq?.downlinkHz.slice(0, 4).join(", ") ?? "none"}`);
console.log(`    modes=${issFreq ? [...issFreq.modes].slice(0, 6).join(", ") : "none"}`);

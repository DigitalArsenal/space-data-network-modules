#!/usr/bin/env node
/**
 * Stage 6 — export the browser bundle.
 *
 * Emits, into one directory that a browser can fetch SAME-ORIGIN (node UIs
 * load zero external-origin bytes):
 *   query-encoder.sdnemb    the distilled encoder
 *   catalog-vectors.sdnvec  the int8 catalog table
 *   lexicon.json            the query planner's compiled term table
 *   facets.bin              dictionary-encoded predicate fields
 *   labels.json             norad -> display name, for showing results
 *
 * ⚠ facets.bin IS A SPIKE SURROGATE. In production the predicate fields are
 * already in the FlatSQL metadata table and the planner's WHERE clause runs
 * there (orbpro-wasm-flatsql law: no JS predicate filtering). Shipping them as
 * a file here is purely so the harness can measure the hybrid path end-to-end
 * without standing up FlatSQL; it is NOT the shipping design.
 */

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, statSync } from "node:fs";
import path from "node:path";
import { buildOwnerTable } from "./lib/lcc.mjs";
import { buildLexicon } from "./lib/queryplan.mjs";

const args = process.argv.slice(2);
const argOf = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : d;
};
const DATA = path.resolve(argOf("--data", "./data"));
const OUT = path.resolve(argOf("--out", "./browser-harness/assets"));
const STACK = "/Users/tj/software/spacedatanetwork-stack";

mkdirSync(OUT, { recursive: true });

const corpus = readFileSync(path.join(DATA, "corpus.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const ownerTable = buildOwnerTable(`${STACK}/repos/main-packages/spacedatastandards.org`);
const lexicon = buildLexicon({ ownerTable, corpus });

// The planner's lexicon travels as data, not code — the same table the WASM
// module will memory-map.
writeFileSync(
  path.join(OUT, "lexicon.json"),
  JSON.stringify({
    owner: lexicon.owner,
    regime: lexicon.regime,
    mission: lexicon.mission,
    constellation: lexicon.constellation,
    sizeClass: lexicon.sizeClass,
    band: lexicon.band,
    manufacturer: lexicon.manufacturer,
    launchSite: lexicon.launchSite,
    vehicle: lexicon.vehicle,
    aliases: lexicon.aliases,
    aliasIndex: Object.fromEntries([...lexicon.aliasIndex].filter(([, v]) => v.length <= 20)),
  }),
);

// Dictionary-encoded predicate fields.
const FIELDS = [
  "owner", "objectClass", "opStatus", "regime", "mission", "constellation",
  "sizeClass", "launchSite", "launchVehicle", "manufacturer",
];
const dicts = {};
const cols = {};
for (const f of FIELDS) {
  const dict = new Map();
  const col = new Int32Array(corpus.length);
  corpus.forEach((row, i) => {
    const v = row.fields[f];
    if (v === undefined || v === null) {
      col[i] = -1;
      return;
    }
    if (!dict.has(v)) dict.set(v, dict.size);
    col[i] = dict.get(v);
  });
  dicts[f] = [...dict.keys()];
  cols[f] = col;
}
// Multi-valued + numeric columns.
const nationDict = new Map();
const nationsPacked = corpus.map((row) =>
  (row.fields.nations ?? []).map((c) => {
    if (!nationDict.has(c)) nationDict.set(c, nationDict.size);
    return nationDict.get(c);
  }),
);
const bandDict = new Map();
const bandsPacked = corpus.map((row) =>
  (row.fields.bands ?? []).map((b) => {
    if (!bandDict.has(b)) bandDict.set(b, bandDict.size);
    return bandDict.get(b);
  }),
);
const launchYear = new Int32Array(corpus.map((r) => r.fields.launchYear ?? -1));
const mass = new Float32Array(corpus.map((r) => (Number.isFinite(r.fields.mass) ? r.fields.mass : -1)));
const cubesatUnits = new Int32Array(corpus.map((r) => r.fields.cubesatUnits ?? -1));
const stationProgramme = new Int32Array(corpus.map((r) => (r.fields.stationProgramme ? 1 : 0)));

writeFileSync(
  path.join(OUT, "facets.json"),
  JSON.stringify({
    count: corpus.length,
    norads: corpus.map((r) => r.norad),
    dicts,
    nationDict: [...nationDict.keys()],
    bandDict: [...bandDict.keys()],
    cols: Object.fromEntries(FIELDS.map((f) => [f, Array.from(cols[f])])),
    nations: nationsPacked,
    bands: bandsPacked,
    launchYear: Array.from(launchYear),
    mass: Array.from(mass),
    cubesatUnits: Array.from(cubesatUnits),
    stationProgramme: Array.from(stationProgramme),
  }),
);

writeFileSync(
  path.join(OUT, "labels.json"),
  JSON.stringify(corpus.map((r) => [r.norad, r.fields.name, r.fields.owner, r.fields.objectClass])),
);

for (const f of ["query-encoder.sdnemb", "catalog-vectors.sdnvec"]) {
  copyFileSync(path.join(DATA, f), path.join(OUT, f));
}

console.log("[bundle] wrote:");
let total = 0;
for (const f of ["query-encoder.sdnemb", "catalog-vectors.sdnvec", "lexicon.json", "facets.json", "labels.json"]) {
  const b = statSync(path.join(OUT, f)).size;
  total += b;
  console.log(`[bundle]   ${f.padEnd(26)} ${(b / 1048576).toFixed(2)} MB`);
}
console.log(`[bundle]   ${"TOTAL".padEnd(26)} ${(total / 1048576).toFixed(2)} MB`);

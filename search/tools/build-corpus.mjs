#!/usr/bin/env node
/**
 * Stage 1 — build the catalog corpus.
 *
 *   metadata sources -> merged NORAD-keyed records -> embedded document text
 *
 * Output: corpus.jsonl, one {norad, doc, fields} per line. `fields` carries the
 * predicate-able structured values so the FlatSQL side and the eval generator
 * read the SAME record the embedding was built from.
 *
 * Usage:
 *   node build-corpus.mjs --out <dir> [--on-orbit-only]
 */

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { buildOwnerTable } from "./lib/lcc.mjs";
import { ALL_SOURCES, mergeSources, FIELD_SCHEMA } from "./lib/sources.mjs";
import { deriveFields, buildDocument } from "./lib/document.mjs";

const args = process.argv.slice(2);
const argOf = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : dflt;
};
const OUT = path.resolve(argOf("--out", "./out"));
const ON_ORBIT_ONLY = args.includes("--on-orbit-only");

const STACK = "/Users/tj/software/spacedatanetwork-stack";
const PATHS = {
  satcat: `${STACK}/repos/main-packages/spaceaware.io/TestData/satcat.txt`,
  discos: "/Users/tj/software/spaceaware.io/TestData/discos-objects.local.json",
  freqs: `${STACK}/repos/ancillary-packages/target-models-data-repo/data/freqs.json`,
  gcatLaunch: `${STACK}/repos/ancillary-packages/target-models-data-repo/raw/mcdowell_gcat/launch.tsv`,
};
const STANDARDS = `${STACK}/repos/main-packages/spacedatastandards.org`;

for (const [k, p] of Object.entries(PATHS)) {
  if (!existsSync(p)) console.warn(`[corpus] WARNING: source ${k} absent at ${p} — its fields will be missing`);
}

console.log("[corpus] loading metadata sources...");
const t0 = Date.now();
const { records, report } = mergeSources(PATHS, ALL_SOURCES);
for (const r of report) {
  console.log(
    `[corpus]   ${r.source.padEnd(14)} ${String(r.records).padStart(7)} records, ${String(r.applied).padStart(7)} applied${r.pending ? "   (PENDING real retriever)" : ""}`,
  );
}

const ownerTable = buildOwnerTable(STANDARDS);
console.log(`[corpus] owner table: ${Object.keys(ownerTable).length} codes`);

mkdirSync(OUT, { recursive: true });
const lines = [];
const coverage = Object.fromEntries(Object.keys(FIELD_SCHEMA).map((k) => [k, 0]));
let kept = 0;

for (const [norad, raw] of records) {
  const rec = deriveFields(raw);
  if (ON_ORBIT_ONLY && !rec.onOrbit) continue;
  const doc = buildDocument(rec, ownerTable);
  for (const key of Object.keys(coverage)) {
    const v = rec[key];
    if (v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0)) coverage[key] += 1;
  }
  lines.push(JSON.stringify({ norad, doc, fields: projectFields(rec) }));
  kept += 1;
}

writeFileSync(path.join(OUT, "corpus.jsonl"), `${lines.join("\n")}\n`);
writeFileSync(
  path.join(OUT, "corpus-meta.json"),
  `${JSON.stringify(
    {
      builtAt: new Date().toISOString(),
      total: records.size,
      kept,
      onOrbitOnly: ON_ORBIT_ONLY,
      sources: report,
      fieldCoverage: Object.fromEntries(
        Object.entries(coverage).map(([k, v]) => [k, { count: v, pct: +((100 * v) / kept).toFixed(1) }]),
      ),
    },
    null,
    2,
  )}\n`,
);

console.log(`[corpus] wrote ${kept} documents in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${OUT}/corpus.jsonl`);
console.log("[corpus] field coverage:");
for (const [k, v] of Object.entries(coverage).sort((a, b) => b[1] - a[1])) {
  console.log(`[corpus]   ${k.padEnd(16)} ${String(v).padStart(6)}  ${((100 * v) / kept).toFixed(1)}%`);
}

/** Keep only schema-declared fields, so downstream never sees adapter internals. */
function projectFields(rec) {
  const out = {};
  for (const key of Object.keys(FIELD_SCHEMA)) {
    const v = rec[key];
    if (v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0)) out[key] = v;
  }
  if (rec.bus) out.bus = rec.bus;
  return out;
}

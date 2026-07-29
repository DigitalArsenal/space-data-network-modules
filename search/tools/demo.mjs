#!/usr/bin/env node
/**
 * Show the actual top results for a query, the way a user would see them.
 * Usage: node demo.mjs --data <dir> "japanese satellites" "international space station" ...
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { buildOwnerTable } from "./lib/lcc.mjs";
import { loadEncoder, encode } from "./lib/encoder.mjs";
import { buildLexicon, planQuery, applyPlan } from "./lib/queryplan.mjs";

const STACK = "/Users/tj/software/spacedatanetwork-stack";
const args = process.argv.slice(2);
const di = args.indexOf("--data");
const DATA = path.resolve(di >= 0 ? args[di + 1] : "./data");
const queries = args.filter((a, i) => a !== "--data" && (di < 0 || i !== di + 1));

const corpus = readFileSync(path.join(DATA, "corpus.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const index = JSON.parse(readFileSync(path.join(DATA, "catalog-index.json"), "utf8"));
const DIM = index.dim;
const buf = readFileSync(path.join(DATA, "catalog-vectors.f32"));
const catalog = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
const model = loadEncoder(readFileSync(path.join(DATA, "query-encoder.sdnemb")));
const lexicon = buildLexicon({
  ownerTable: buildOwnerTable(`${STACK}/repos/main-packages/spacedatastandards.org`),
  corpus,
});

for (const q of queries) {
  const plan = planQuery(q, lexicon);
  const cand = applyPlan(plan, corpus);
  const pool = cand && cand.length ? cand : [...corpus.keys()];
  const qv = encode(model, plan.semantic);
  const scored = pool.map((i) => {
    let dot = 0;
    const off = i * DIM;
    for (let d = 0; d < DIM; d += 1) dot += qv[d] * catalog[off + d];
    if (plan.prefer && corpus[i].fields[plan.prefer.field] === plan.prefer.value) dot += plan.prefer.weight;
    return [dot, i];
  });
  scored.sort((a, b) => b[0] - a[0]);
  console.log(`\n### "${q}"`);
  console.log(
    `    plan: semantic="${plan.semantic}" predicates=${JSON.stringify(plan.predicates)} candidates=${cand ? cand.length : "all"}`,
  );
  for (const [s, i] of scored.slice(0, 8)) {
    const f = corpus[i].fields;
    console.log(
      `    ${s.toFixed(3)}  ${String(f.norad).padStart(6)}  ${String(f.name).padEnd(26)} ${String(f.owner).padEnd(5)} ${f.objectClass}`,
    );
  }
}

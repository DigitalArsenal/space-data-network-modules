#!/usr/bin/env node
/**
 * Stage 4 — measure retrieval quality on the acceptance suite.
 *
 * Four systems, same 274 queries, same graded judgements:
 *   baseline   the substring/prefix index /beta ships today
 *   teacher    full MiniLM query encoding (the quality ceiling)
 *   student    the 1.4 MB distilled static encoder
 *   hybrid     student ranking INSIDE the query planner's FlatSQL candidate set
 *
 * Reported: recall@10/@50 over graded-relevant objects, nDCG@10, MRR, and
 * top-1 accuracy on the named-object family (where exactly one answer is right).
 *
 * Usage: node eval.mjs --data <dir> [--systems baseline,teacher,student,hybrid]
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { buildOwnerTable } from "./lib/lcc.mjs";
import { buildEvalSet, computeQrels } from "./lib/evalset.mjs";
import { loadEncoder, encode } from "./lib/encoder.mjs";
import { buildLexicon, planQuery, applyPlan } from "./lib/queryplan.mjs";

const STACK = "/Users/tj/software/spacedatanetwork-stack";
const STANDARDS = `${STACK}/repos/main-packages/spacedatastandards.org`;
const ORT_HOST = `${STACK}/repos/main-packages/spacedatastandards.org`;
const MODEL_DIR = `${STACK}/repos/main-packages/space-data-network/deployment/embedding`;
const SEMANTIC_CORE = `${STACK}/repos/main-packages/space-data-network/sdn-js/dashboard/src/semantic-core.js`;

const args = process.argv.slice(2);
const argOf = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : d;
};
const DATA = path.resolve(argOf("--data", "./data"));
const SYSTEMS = argOf("--systems", "baseline,teacher,student,hybrid").split(",");
const K = [1, 10, 50];

const corpus = readFileSync(path.join(DATA, "corpus.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const index = JSON.parse(readFileSync(path.join(DATA, "catalog-index.json"), "utf8"));
const DIM = index.dim;
const catBuf = readFileSync(path.join(DATA, "catalog-vectors.f32"));
const catalog = new Float32Array(catBuf.buffer, catBuf.byteOffset, catBuf.byteLength / 4);
const N = index.count;

const ownerTable = buildOwnerTable(STANDARDS);
const queries = buildEvalSet(corpus, ownerTable);
const qrels = computeQrels(queries, corpus);
const lexicon = buildLexicon({ ownerTable, corpus });

const model = loadEncoder(readFileSync(path.join(DATA, "query-encoder.sdnemb")));
console.log(`[eval] student ${model.count} tokens x ${model.dim}, corpus ${N}, queries ${queries.length}`);

/** Brute-force top-k by dot product over the (optionally restricted) catalog. */
function search(qvec, k, candidates = null, bonus = null) {
  const heap = [];
  const consider = (i) => {
    let dot = 0;
    const off = i * DIM;
    for (let d = 0; d < DIM; d += 1) dot += qvec[d] * catalog[off + d];
    if (bonus) dot += bonus(i);
    if (heap.length < k) {
      heap.push([dot, i]);
      if (heap.length === k) heap.sort((a, b) => a[0] - b[0]);
    } else if (dot > heap[0][0]) {
      heap[0] = [dot, i];
      let j = 0;
      while (true) {
        let m = j;
        const l = 2 * j + 1;
        const r = 2 * j + 2;
        if (l < k && heap[l][0] < heap[m][0]) m = l;
        if (r < k && heap[r][0] < heap[m][0]) m = r;
        if (m === j) break;
        [heap[j], heap[m]] = [heap[m], heap[j]];
        j = m;
      }
    }
  };
  if (candidates) for (const i of candidates) consider(i);
  else for (let i = 0; i < N; i += 1) consider(i);
  return heap.sort((a, b) => b[0] - a[0]).map(([, i]) => corpus[i].norad);
}

/** The prefix/substring index /beta ships today, as the honest baseline. */
function baselineSearch(query, k) {
  const q = query.toUpperCase();
  const scored = [];
  for (const row of corpus) {
    const name = String(row.fields.name ?? "").toUpperCase();
    let s = 0;
    if (name === q) s = 4;
    else if (name.startsWith(q)) s = 3;
    else if (name.includes(q)) s = 2;
    else if (String(row.norad) === query.trim()) s = 4;
    if (s) scored.push([s, row.norad]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, k).map(([, n]) => n);
}

const dcg = (grades) => grades.reduce((a, g, i) => a + (2 ** g - 1) / Math.log2(i + 2), 0);

function score(ranked, rel) {
  const out = {};
  const ideal = [...rel.values()].sort((a, b) => b - a);
  for (const k of K) {
    const top = ranked.slice(0, k);
    const hits = top.filter((n) => rel.has(n)).length;
    out[`recall@${k}`] = rel.size ? hits / Math.min(k, rel.size) : 0;
    out[`precision@${k}`] = top.length ? hits / top.length : 0;
  }
  const grades10 = ranked.slice(0, 10).map((n) => rel.get(n) ?? 0);
  const idcg = dcg(ideal.slice(0, 10));
  out["ndcg@10"] = idcg > 0 ? dcg(grades10) / idcg : 0;
  const firstHit = ranked.findIndex((n) => rel.has(n));
  out.mrr = firstHit >= 0 ? 1 / (firstHit + 1) : 0;
  out.top1 = ranked.length && rel.get(ranked[0]) === 3 ? 1 : 0;
  return out;
}

// Teacher, only if requested (slow: one transformer pass per query).
let teacherEmbed = null;
if (SYSTEMS.includes("teacher")) {
  const require_ = createRequire(path.join(ORT_HOST, "package.json"));
  const ort = require_("onnxruntime-node");
  const { wordpieceTokenize, l2normalize } = await import(pathToFileURL(SEMANTIC_CORE).href);
  const words = readFileSync(path.join(MODEL_DIR, "vocab.txt"), "utf8").split(/\r?\n/);
  const bertVocab = new Map();
  words.forEach((w, i) => {
    if (w) bertVocab.set(w, i);
  });
  const session = await ort.InferenceSession.create(path.join(MODEL_DIR, "model.onnx"));
  teacherEmbed = async (text) => {
    const ids = [
      bertVocab.get("[CLS]") ?? 101,
      ...wordpieceTokenize(text, bertVocab).slice(0, 126),
      bertVocab.get("[SEP]") ?? 102,
    ];
    const n = ids.length;
    const a = new BigInt64Array(n);
    const m = new BigInt64Array(n);
    const t = new BigInt64Array(n);
    for (let i = 0; i < n; i += 1) {
      a[i] = BigInt(ids[i]);
      m[i] = 1n;
    }
    const feeds = {
      input_ids: new ort.Tensor("int64", a, [1, n]),
      attention_mask: new ort.Tensor("int64", m, [1, n]),
    };
    if (session.inputNames.includes("token_type_ids")) {
      feeds.token_type_ids = new ort.Tensor("int64", t, [1, n]);
    }
    const out = await session.run(feeds);
    const h = out[session.outputNames[0]];
    const [, seq, dim] = h.dims;
    const v = new Float32Array(dim);
    for (let i = 0; i < seq; i += 1) for (let d = 0; d < dim; d += 1) v[d] += h.data[i * dim + d];
    for (let d = 0; d < dim; d += 1) v[d] /= seq;
    return l2normalize(v);
  };
}

const results = {};
const perQuery = [];
const timings = {};

for (const sys of SYSTEMS) {
  const agg = {};
  const byFamily = {};
  let elapsed = 0;
  for (const q of queries) {
    const rel = qrels.get(q.id);
    if (!rel.size) continue;
    const t0 = process.hrtime.bigint();
    let ranked;
    if (sys === "baseline") {
      ranked = baselineSearch(q.query, 50);
    } else if (sys === "teacher") {
      ranked = search(await teacherEmbed(q.query), 50);
    } else if (sys === "student") {
      ranked = search(encode(model, q.query), 50);
    } else {
      const plan = planQuery(q.query, lexicon);
      const cand = applyPlan(plan, corpus);
      const pref = plan.prefer
        ? (i) => (corpus[i].fields[plan.prefer.field] === plan.prefer.value ? plan.prefer.weight : 0)
        : null;
      ranked = search(encode(model, plan.semantic), 50, cand && cand.length ? cand : null, pref);
    }
    elapsed += Number(process.hrtime.bigint() - t0) / 1e6;
    const s = score(ranked, rel);
    for (const [k, v] of Object.entries(s)) agg[k] = (agg[k] ?? 0) + v;
    const fam = q.family.replace(/-paraphrase$/, "");
    byFamily[fam] ??= { n: 0, "ndcg@10": 0, "recall@10": 0 };
    byFamily[fam].n += 1;
    byFamily[fam]["ndcg@10"] += s["ndcg@10"];
    byFamily[fam]["recall@10"] += s["recall@10"];
    if (sys === SYSTEMS[SYSTEMS.length - 1]) {
      perQuery.push({ query: q.query, family: q.family, ndcg: s["ndcg@10"], top: ranked.slice(0, 3) });
    }
  }
  const n = queries.filter((q) => qrels.get(q.id).size).length;
  results[sys] = Object.fromEntries(Object.entries(agg).map(([k, v]) => [k, +(v / n).toFixed(4)]));
  results[sys].queries = n;
  timings[sys] = +(elapsed / n).toFixed(2);
  results[sys].byFamily = Object.fromEntries(
    Object.entries(byFamily).map(([f, v]) => [
      f,
      { n: v.n, ndcg10: +(v["ndcg@10"] / v.n).toFixed(3), recall10: +(v["recall@10"] / v.n).toFixed(3) },
    ]),
  );
}

console.log("\n=== ACCEPTANCE RESULTS ===");
const cols = ["recall@10", "recall@50", "ndcg@10", "mrr", "top1"];
console.log(`${"system".padEnd(10)}${cols.map((c) => c.padStart(11)).join("")}${"ms/query".padStart(11)}`);
for (const sys of SYSTEMS) {
  console.log(
    `${sys.padEnd(10)}${cols.map((c) => String(results[sys][c]).padStart(11)).join("")}${String(timings[sys]).padStart(11)}`,
  );
}

console.log("\n=== nDCG@10 BY FAMILY ===");
const fams = Object.keys(results[SYSTEMS[0]].byFamily).sort();
console.log(`${"family".padEnd(16)}${"n".padStart(5)}${SYSTEMS.map((s) => s.padStart(11)).join("")}`);
for (const f of fams) {
  const n = results[SYSTEMS[0]].byFamily[f].n;
  console.log(
    `${f.padEnd(16)}${String(n).padStart(5)}${SYSTEMS.map((s) => String(results[s].byFamily[f]?.ndcg10 ?? "-").padStart(11)).join("")}`,
  );
}

console.log("\n=== WORST 12 QUERIES (last system) ===");
for (const r of perQuery.sort((a, b) => a.ndcg - b.ndcg).slice(0, 12)) {
  console.log(`  ${r.ndcg.toFixed(3)}  [${r.family}] ${r.query}  -> ${r.top.join(", ")}`);
}

console.log(`\n${JSON.stringify({ summary: Object.fromEntries(SYSTEMS.map((s) => [s, { ...results[s], byFamily: undefined }])), msPerQuery: timings })}`);

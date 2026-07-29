#!/usr/bin/env node
/**
 * Stage 3 — distil a STATIC query encoder that runs in the browser.
 *
 * WHY STATIC. The teacher is a 6-layer transformer: 23 MB of int8 weights plus
 * an 11 MB onnxruntime WASM runtime, and a session-create that measurably froze
 * the node dashboard's main thread for nine seconds. That is far too much to
 * put in front of a search box.
 *
 * The student is a TOKEN EMBEDDING TABLE and nothing else:
 *
 *     encode(text) = L2normalise( Σ idf(t)·W[t] / Σ idf(t) )
 *
 * No attention, no layers, no runtime — a gather, a weighted sum, a normalise.
 * It is trained to REGRESS THE TEACHER'S SENTENCE VECTOR, so its output lands
 * in the teacher's space and can be dot-producted directly against the catalog
 * table the teacher produced. The catalog side keeps full transformer quality;
 * only the query side is approximated, which is the half that has to be fast.
 *
 * Training signal, in order of importance:
 *   1. the 33,814 real catalog documents (targets already computed in stage 2),
 *   2. ~40k domain phrases generated from our own catalog + GCAT metadata,
 *      which is what teaches "japanese" -> JPN and "zarya" -> the ISS.
 * The acceptance queries are HELD OUT.
 *
 * Usage:
 *   node distill-encoder.mjs --data <dir> [--epochs 12] [--dim 384] [--docs 16000]
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { buildOwnerTable } from "./lib/lcc.mjs";
import { buildEvalSet } from "./lib/evalset.mjs";
import { buildTrainingPhrases } from "./lib/phrases.mjs";

const STACK = "/Users/tj/software/spacedatanetwork-stack";
const ORT_HOST = `${STACK}/repos/main-packages/spacedatastandards.org`;
const MODEL_DIR = `${STACK}/repos/main-packages/space-data-network/deployment/embedding`;
const SEMANTIC_CORE = `${STACK}/repos/main-packages/space-data-network/sdn-js/dashboard/src/semantic-core.js`;
const STANDARDS = `${STACK}/repos/main-packages/spacedatastandards.org`;

const args = process.argv.slice(2);
const argOf = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : d;
};
const DATA = path.resolve(argOf("--data", "./data"));
const EPOCHS = Number(argOf("--epochs", "12"));
const DOC_SAMPLE = Number(argOf("--docs", "16000"));
const LR0 = Number(argOf("--lr", "0.6"));

const require_ = createRequire(path.join(ORT_HOST, "package.json"));
const ort = require_("onnxruntime-node");
const { wordpieceTokenize, l2normalize } = await import(pathToFileURL(SEMANTIC_CORE).href);

const vocabWords = readFileSync(path.join(MODEL_DIR, "vocab.txt"), "utf8").split(/\r?\n/);
const vocab = new Map();
vocabWords.forEach((w, i) => {
  if (w) vocab.set(w, i);
});

const session = await ort.InferenceSession.create(path.join(MODEL_DIR, "model.onnx"));

/** Teacher forward pass over a batch of texts -> L2-normalised mean-pooled vectors. */
async function teacherEmbed(texts, maxTokens = 128) {
  const cls = vocab.get("[CLS]") ?? 101;
  const sep = vocab.get("[SEP]") ?? 102;
  const seqs = texts.map((t) => [cls, ...wordpieceTokenize(t, vocab).slice(0, maxTokens - 2), sep]);
  const n = Math.max(...seqs.map((s) => s.length));
  const b = seqs.length;
  const ids = new BigInt64Array(b * n);
  const mask = new BigInt64Array(b * n);
  const types = new BigInt64Array(b * n);
  seqs.forEach((s, i) => {
    for (let j = 0; j < s.length; j += 1) {
      ids[i * n + j] = BigInt(s[j]);
      mask[i * n + j] = 1n;
    }
  });
  const feeds = {
    input_ids: new ort.Tensor("int64", ids, [b, n]),
    attention_mask: new ort.Tensor("int64", mask, [b, n]),
  };
  if (session.inputNames.includes("token_type_ids")) {
    feeds.token_type_ids = new ort.Tensor("int64", types, [b, n]);
  }
  const out = await session.run(feeds);
  const hidden = out[session.outputNames[0]];
  const [, seq, dim] = hidden.dims;
  const data = hidden.data;
  const vecs = [];
  for (let i = 0; i < b; i += 1) {
    const v = new Float32Array(dim);
    const len = seqs[i].length;
    for (let t = 0; t < len; t += 1) {
      const base = (i * seq + t) * dim;
      for (let d = 0; d < dim; d += 1) v[d] += data[base + d];
    }
    for (let d = 0; d < dim; d += 1) v[d] /= len;
    vecs.push(l2normalize(v));
  }
  return vecs;
}

async function teacherEmbedAll(texts, batch, label) {
  const out = [];
  const t0 = Date.now();
  for (let i = 0; i < texts.length; i += batch) {
    out.push(...(await teacherEmbed(texts.slice(i, i + batch))));
    if (i % (batch * 25) === 0) {
      const rate = (i + batch) / ((Date.now() - t0) / 1000);
      process.stdout.write(
        `\r[distil] ${label}: ${Math.min(i + batch, texts.length)}/${texts.length} (${rate.toFixed(0)}/s)   `,
      );
    }
  }
  process.stdout.write("\n");
  return out;
}

// ---------------------------------------------------------------- data setup

console.log("[distil] loading corpus + teacher catalog vectors");
const corpus = readFileSync(path.join(DATA, "corpus.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const index = JSON.parse(readFileSync(path.join(DATA, "catalog-index.json"), "utf8"));
const DIM = index.dim;
const catBuf = readFileSync(path.join(DATA, "catalog-vectors.f32"));
const catalogVecs = new Float32Array(catBuf.buffer, catBuf.byteOffset, catBuf.byteLength / 4);
console.log(`[distil] catalog ${index.count} x ${DIM}`);

const ownerTable = buildOwnerTable(STANDARDS);
const evalQueries = buildEvalSet(corpus, ownerTable);
const heldOut = new Set(evalQueries.map((q) => q.query.toLowerCase().trim()));
console.log(`[distil] holding out ${heldOut.size} acceptance queries`);

const phrases = buildTrainingPhrases(corpus, ownerTable, heldOut);
console.log(`[distil] ${phrases.length} domain training phrases`);

// Deterministic doc subsample: stride, so every part of the catalogue is seen.
const stride = Math.max(1, Math.floor(corpus.length / DOC_SAMPLE));
const docIdx = [];
for (let i = 0; i < corpus.length; i += stride) docIdx.push(i);
console.log(`[distil] ${docIdx.length} catalog documents in the training set`);

console.log("[distil] embedding phrases with the teacher (targets)...");
const phraseVecs = await teacherEmbedAll(phrases, 64, "phrases");

/** Training pairs: [tokenIds, targetVector]. */
const train = [];
for (const i of docIdx) {
  const ids = wordpieceTokenize(corpus[i].doc, vocab).slice(0, 126);
  if (ids.length) train.push([ids, catalogVecs.subarray(i * DIM, (i + 1) * DIM)]);
}
phrases.forEach((p, i) => {
  const ids = wordpieceTokenize(p, vocab).slice(0, 126);
  if (ids.length) train.push([ids, phraseVecs[i]]);
});
console.log(`[distil] ${train.length} training examples`);

// ------------------------------------------------------- vocabulary + weights

const used = new Map(); // tokenId -> document frequency
for (const [ids] of train) {
  for (const t of new Set(ids)) used.set(t, (used.get(t) ?? 0) + 1);
}
const tokenIds = [...used.keys()].sort((a, b) => a - b);
console.log(`[distil] domain vocabulary: ${tokenIds.length} of ${vocab.size} WordPiece tokens`);

const slot = new Int32Array(vocab.size).fill(-1);
tokenIds.forEach((t, i) => {
  slot[t] = i;
});
const V = tokenIds.length;

// IDF: damps "satellite", which is in almost every document and carries no
// discriminative signal, and lifts "zarya", which carries almost all of it.
const idf = new Float32Array(V);
for (let i = 0; i < V; i += 1) {
  idf[i] = Math.log((1 + train.length) / (1 + used.get(tokenIds[i]))) + 1;
}

// Initialise each row with the teacher's embedding OF THAT TOKEN ALONE. This
// is already a usable encoder before any training and makes SGD a refinement
// rather than a search from noise.
console.log("[distil] initialising rows from per-token teacher embeddings...");
const idToWord = new Map();
for (const [w, i] of vocab) idToWord.set(i, w);
const tokenTexts = tokenIds.map((t) => (idToWord.get(t) ?? "").replace(/^##/, ""));
const tokenVecs = await teacherEmbedAll(tokenTexts, 256, "tokens");

const W = new Float32Array(V * DIM);
for (let i = 0; i < V; i += 1) W.set(tokenVecs[i], i * DIM);

// ------------------------------------------------------------------ training
//
// Loss = 1 - cos(pred, target), pred = Σ idf·W[t] / Σ idf.
// d(loss)/d(m) = -(y - (u·y)u)/||m||, distributed to each token by its weight.

const scratch = new Float32Array(DIM);
const order = train.map((_, i) => i);
let seed = 12345;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

function forward(ids) {
  scratch.fill(0);
  let wsum = 0;
  for (const t of ids) {
    const s = slot[t];
    if (s < 0) continue;
    const w = idf[s];
    wsum += w;
    const off = s * DIM;
    for (let d = 0; d < DIM; d += 1) scratch[d] += w * W[off + d];
  }
  if (wsum > 0) for (let d = 0; d < DIM; d += 1) scratch[d] /= wsum;
  let norm = 0;
  for (let d = 0; d < DIM; d += 1) norm += scratch[d] * scratch[d];
  norm = Math.sqrt(norm);
  return { wsum, norm };
}

console.log(`[distil] training ${EPOCHS} epochs over ${train.length} examples`);
const grad = new Float32Array(DIM);
for (let epoch = 0; epoch < EPOCHS; epoch += 1) {
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const lr = LR0 * (1 - epoch / EPOCHS);
  let loss = 0;
  for (const oi of order) {
    const [ids, target] = train[oi];
    const { wsum, norm } = forward(ids);
    if (norm <= 1e-8 || wsum <= 0) continue;
    let dot = 0;
    for (let d = 0; d < DIM; d += 1) dot += (scratch[d] / norm) * target[d];
    loss += 1 - dot;
    // grad wrt the (weighted-mean) vector m
    for (let d = 0; d < DIM; d += 1) {
      const u = scratch[d] / norm;
      grad[d] = -(target[d] - dot * u) / norm;
    }
    for (const t of ids) {
      const s = slot[t];
      if (s < 0) continue;
      const scale = (lr * idf[s]) / wsum;
      const off = s * DIM;
      for (let d = 0; d < DIM; d += 1) W[off + d] -= scale * grad[d];
    }
  }
  console.log(`[distil]   epoch ${epoch + 1}/${EPOCHS}  lr=${lr.toFixed(3)}  mean cosine loss ${(loss / train.length).toFixed(4)}`);
}

// ---------------------------------------------------------------- quantise
//
// Per-row int8 with a per-row scale: rows have very different magnitudes after
// training, and a single global scale would crush the small ones to zero.

const qw = new Int8Array(V * DIM);
const qscale = new Float32Array(V);
for (let i = 0; i < V; i += 1) {
  const off = i * DIM;
  let max = 0;
  for (let d = 0; d < DIM; d += 1) max = Math.max(max, Math.abs(W[off + d]));
  const s = max > 0 ? max / 127 : 1;
  qscale[i] = s;
  for (let d = 0; d < DIM; d += 1) {
    qw[off + d] = Math.max(-127, Math.min(127, Math.round(W[off + d] / s)));
  }
}

// ------------------------------------------------------------------- write
//
// Layout (little-endian), designed so the WASM module can mmap it and use it
// in place with zero parsing beyond the header:
//   magic "SDNEMB01" | u32 dim | u32 vocabCount | u32 vocabBytes
//   vocabBytes of newline-separated tokens
//   f32[vocabCount] idf | f32[vocabCount] scale | i8[vocabCount*dim] weights

const vocabBlob = Buffer.from(tokenIds.map((t) => idToWord.get(t)).join("\n"), "utf8");
const header = Buffer.alloc(20);
header.write("SDNEMB01", 0, "ascii");
header.writeUInt32LE(DIM, 8);
header.writeUInt32LE(V, 12);
header.writeUInt32LE(vocabBlob.length, 16);
const out = Buffer.concat([
  header,
  vocabBlob,
  Buffer.from(idf.buffer, idf.byteOffset, idf.byteLength),
  Buffer.from(qscale.buffer, qscale.byteOffset, qscale.byteLength),
  Buffer.from(qw.buffer, qw.byteOffset, qw.byteLength),
]);
writeFileSync(path.join(DATA, "query-encoder.sdnemb"), out);

// Float reference, for measuring how much the int8 step costs.
writeFileSync(
  path.join(DATA, "query-encoder-f32.bin"),
  Buffer.concat([header, vocabBlob, Buffer.from(idf.buffer), Buffer.from(W.buffer, W.byteOffset, W.byteLength)]),
);

writeFileSync(
  path.join(DATA, "query-encoder-meta.json"),
  `${JSON.stringify(
    {
      builtAt: new Date().toISOString(),
      dim: DIM,
      vocab: V,
      epochs: EPOCHS,
      trainingExamples: train.length,
      phrases: phrases.length,
      docs: docIdx.length,
      heldOutQueries: heldOut.size,
      bytes: out.length,
      teacher: "all-MiniLM-L6-v2 int8 (node /embedding/model.onnx)",
    },
    null,
    2,
  )}\n`,
);

console.log(`[distil] wrote query-encoder.sdnemb  ${(out.length / 1024 / 1024).toFixed(2)} MB  (${V} x ${DIM} int8)`);

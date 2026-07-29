#!/usr/bin/env node
/**
 * Stage 2 — embed the catalog corpus with the TEACHER encoder.
 *
 * The teacher is the int8 all-MiniLM-L6-v2 the SDN node ALREADY stages and
 * serves at /embedding/* (deployment/embedding/fetch-model.sh). Reusing that
 * exact file — rather than pulling a fresh one from HuggingFace — means:
 *   - zero network in this pipeline,
 *   - the catalog vectors are produced by the same weights the node publishes,
 *   - and the tokenizer is literally the node's own `wordpieceTokenize`, so
 *     there is no tokenization drift between the offline table and any runtime.
 *
 * Output: catalog-vectors.f32 (row-major float32, L2-normalized) + an index
 * JSON. This IS the vector table that ships with the catalog dataset.
 *
 * Usage:
 *   node embed-catalog.mjs --corpus <dir> --out <dir> [--limit N] [--batch 64]
 */

import { readFileSync, writeFileSync, createWriteStream } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const STACK = "/Users/tj/software/spacedatanetwork-stack";
const ORT_HOST = `${STACK}/repos/main-packages/spacedatastandards.org`;
const MODEL_DIR = `${STACK}/repos/main-packages/space-data-network/deployment/embedding`;
const SEMANTIC_CORE = `${STACK}/repos/main-packages/space-data-network/sdn-js/dashboard/src/semantic-core.js`;

const args = process.argv.slice(2);
const argOf = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : dflt;
};
const CORPUS = path.resolve(argOf("--corpus", "./data"));
const OUT = path.resolve(argOf("--out", CORPUS));
const LIMIT = Number(argOf("--limit", "0"));
const BATCH = Number(argOf("--batch", "64"));
const MAX_TOKENS = Number(argOf("--max-tokens", "128"));

const require_ = createRequire(path.join(ORT_HOST, "package.json"));
const ort = require_("onnxruntime-node");
const { wordpieceTokenize, l2normalize } = await import(pathToFileURL(SEMANTIC_CORE).href);

/** Load the node's WordPiece vocabulary exactly as the dashboard worker does. */
function loadVocab() {
  const words = readFileSync(path.join(MODEL_DIR, "vocab.txt"), "utf8").split(/\r?\n/);
  const vocab = new Map();
  words.forEach((w, i) => {
    if (w) vocab.set(w, i);
  });
  return vocab;
}

/** Tokenize to a padded batch with the attention mask masked-mean-pooling needs. */
export function encodeBatch(texts, vocab, maxTokens = MAX_TOKENS) {
  const cls = vocab.get("[CLS]") ?? 101;
  const sep = vocab.get("[SEP]") ?? 102;
  const seqs = texts.map((t) => {
    const body = wordpieceTokenize(t, vocab).slice(0, maxTokens - 2);
    return [cls, ...body, sep];
  });
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
  return { ids, mask, types, b, n, lengths: seqs.map((s) => s.length) };
}

/** Masked mean-pool the last hidden state, then L2-normalize each row. */
function poolBatch(hidden, dims, lengths) {
  const [b, seq, dim] = dims;
  const out = [];
  for (let i = 0; i < b; i += 1) {
    const vec = new Float32Array(dim);
    const len = lengths[i];
    for (let t = 0; t < len; t += 1) {
      const base = (i * seq + t) * dim;
      for (let d = 0; d < dim; d += 1) vec[d] += hidden[base + d];
    }
    for (let d = 0; d < dim; d += 1) vec[d] /= len;
    out.push(l2normalize(vec));
  }
  return out;
}

async function main() {
  const vocab = loadVocab();
  console.log(`[embed] vocab ${vocab.size} tokens`);

  const session = await ort.InferenceSession.create(path.join(MODEL_DIR, "model.onnx"));
  console.log(`[embed] teacher inputs=${session.inputNames} outputs=${session.outputNames}`);

  const raw = readFileSync(path.join(CORPUS, "corpus.jsonl"), "utf8").trim().split("\n");
  const rows = (LIMIT > 0 ? raw.slice(0, LIMIT) : raw).map((l) => JSON.parse(l));
  console.log(`[embed] ${rows.length} documents, batch=${BATCH}, maxTokens=${MAX_TOKENS}`);

  let dim = 0;
  const vecStream = createWriteStream(path.join(OUT, "catalog-vectors.f32"));
  const t0 = Date.now();

  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const { ids, mask, types, b, n, lengths } = encodeBatch(chunk.map((r) => r.doc), vocab);
    const feeds = {
      input_ids: new ort.Tensor("int64", ids, [b, n]),
      attention_mask: new ort.Tensor("int64", mask, [b, n]),
    };
    if (session.inputNames.includes("token_type_ids")) {
      feeds.token_type_ids = new ort.Tensor("int64", types, [b, n]);
    }
    const out = await session.run(feeds);
    const hidden = out[session.outputNames[0]];
    const vecs = poolBatch(hidden.data, hidden.dims, lengths);
    dim = vecs[0].length;
    for (const v of vecs) {
      if (!vecStream.write(Buffer.from(v.buffer, v.byteOffset, v.byteLength))) {
        await new Promise((r) => vecStream.once("drain", r));
      }
    }
    if (i % (BATCH * 20) === 0 || i + BATCH >= rows.length) {
      const done = Math.min(i + BATCH, rows.length);
      const rate = done / ((Date.now() - t0) / 1000);
      const eta = (rows.length - done) / rate;
      console.log(
        `[embed] ${done}/${rows.length}  ${rate.toFixed(0)} docs/s  eta ${eta.toFixed(0)}s`,
      );
    }
  }

  await new Promise((r) => vecStream.end(r));
  writeFileSync(
    path.join(OUT, "catalog-index.json"),
    `${JSON.stringify(
      {
        model: "all-MiniLM-L6-v2 int8 (node /embedding/model.onnx)",
        dim,
        count: rows.length,
        maxTokens: MAX_TOKENS,
        builtAt: new Date().toISOString(),
        norads: rows.map((r) => r.norad),
      },
      null,
      0,
    )}\n`,
  );
  const secs = (Date.now() - t0) / 1000;
  console.log(
    `[embed] DONE ${rows.length} x ${dim} in ${secs.toFixed(0)}s (${(rows.length / secs).toFixed(0)} docs/s) -> ${OUT}/catalog-vectors.f32`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();

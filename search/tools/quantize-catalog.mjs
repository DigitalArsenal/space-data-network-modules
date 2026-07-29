#!/usr/bin/env node
/**
 * Stage 5 — quantise the catalog vector table to int8 for shipping.
 *
 * float32 x 384 x 33,814 = 48 MB, which is four times the $OMM shard it would
 * travel with. Per-row int8 with a float32 scale is 13 MB for a similarity loss
 * measured here (not assumed) and printed at the end.
 *
 * Layout: magic "SDNVEC01" | u32 dim | u32 count | f32[count] scale |
 *         i8[count*dim] vectors | u32[count] norads
 *
 * Usage: node quantize-catalog.mjs --data <dir>
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const i = args.indexOf("--data");
const DATA = path.resolve(i >= 0 ? args[i + 1] : "./data");

const index = JSON.parse(readFileSync(path.join(DATA, "catalog-index.json"), "utf8"));
const DIM = index.dim;
const N = index.count;
const buf = readFileSync(path.join(DATA, "catalog-vectors.f32"));
const vecs = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);

const q = new Int8Array(N * DIM);
const scale = new Float32Array(N);
let sumCos = 0;
let worst = 1;

for (let r = 0; r < N; r += 1) {
  const off = r * DIM;
  let max = 0;
  for (let d = 0; d < DIM; d += 1) max = Math.max(max, Math.abs(vecs[off + d]));
  const s = max > 0 ? max / 127 : 1;
  scale[r] = s;
  for (let d = 0; d < DIM; d += 1) {
    q[off + d] = Math.max(-127, Math.min(127, Math.round(vecs[off + d] / s)));
  }
  // Measure what quantisation actually cost on this row.
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let d = 0; d < DIM; d += 1) {
    const a = vecs[off + d];
    const b = q[off + d] * s;
    dot += a * b;
    na += a * a;
    nb += b * b;
  }
  const cos = dot / Math.sqrt(na * nb);
  sumCos += cos;
  worst = Math.min(worst, cos);
}

const header = Buffer.alloc(16);
header.write("SDNVEC01", 0, "ascii");
header.writeUInt32LE(DIM, 8);
header.writeUInt32LE(N, 12);
const norads = new Uint32Array(index.norads);

const out = Buffer.concat([
  header,
  Buffer.from(scale.buffer, scale.byteOffset, scale.byteLength),
  Buffer.from(q.buffer, q.byteOffset, q.byteLength),
  Buffer.from(norads.buffer, norads.byteOffset, norads.byteLength),
]);
writeFileSync(path.join(DATA, "catalog-vectors.sdnvec"), out);

console.log(`[quant] ${N} x ${DIM}`);
console.log(`[quant] float32 ${(buf.length / 1048576).toFixed(1)} MB -> int8 ${(out.length / 1048576).toFixed(1)} MB (${(buf.length / out.length).toFixed(2)}x)`);
console.log(`[quant] round-trip cosine: mean ${(sumCos / N).toFixed(6)}, worst ${worst.toFixed(6)}`);

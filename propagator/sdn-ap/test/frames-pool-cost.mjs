#!/usr/bin/env node
// Matched A B B A segments in four loaded instances. Eight rounds cover one complete
// first fill and eight more cover one rolling refill. Times sum actual execution over
// the whole catalog, excluding the interleaved controls, load, and pool startup.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { createHash } from "node:crypto";
import { openFrames, EPOCH_MS, STAT } from "./lib/frame-cells.mjs";
import { catalogPopulation, loadCatalog } from "./lib/frame-catalog.mjs";
const n = Number(process.env.FRAMES_OBJECTS ?? 100000), threads = Number(process.env.FRAMES_THREADS ?? 4);
assert.ok(process.env.FRAMES_CONTROL, "FRAMES_CONTROL names the unchanged serial artifact");
assert.ok(process.env.SDNAP_WASM, "SDNAP_WASM names the pooled artifact");
const rounds = 8, pop = catalogPopulation(n);
// Spread orbit classes across the ordered catalog so every timing segment samples the mix.
let seed = 20261113;
const ids = pop.map((_, i) => i);
for (let i = ids.length - 1; i > 0; --i) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  const j = seed % (i + 1); [ids[i], ids[j]] = [ids[j], ids[i]];
}
pop.forEach((o, i) => { o.norad = 300000 + ids[i]; });
const loadStart = os.loadavg(), models = [];
for (const changed of [false, true, true, false]) {
  const f = await openFrames({ wasm: changed ? process.env.SDNAP_WASM : process.env.FRAMES_CONTROL, threads: changed ? threads : 0, initialMemoryBytes: 2 * 1048576 });
  await loadCatalog(f, pop); models.push(f);
}
const quantile = (a, q) => { const s = [...a].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const median = a => { const s = [...a].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const hash = f => {
  const q = f.at(EPOCH_MS + 3600000);
  return createHash("sha256").update(Buffer.from(q.planes.buffer)).update(Buffer.from(q.status.buffer)).digest("hex");
};
const samples = { first: [], rolling: [] }, totals = { first: [], rolling: [] };
const latencies = { first: [], rolling: [] };
const summary = phase => {
  const ratios = samples[phase].map(s => (s[0].ms + s[3].ms) / (s[1].ms + s[2].ms));
  const sorted = [...ratios].sort((a, b) => a - b), mid = median(ratios);
  const middle = [sorted[Math.floor(sorted.length / 4)], sorted[Math.ceil(sorted.length * 3 / 4) - 1]];
  const bSeconds = totals[phase].flatMap(s => [s[1] / 1000, s[2] / 1000]);
  const aSeconds = totals[phase].flatMap(s => [s[0] / 1000, s[3] / 1000]);
  const rowCount = phase === "first" ? 2 * n : n;
  return { rounds: ratios.length, ratioMedian: mid, ratioMiddleHalf: middle, usable: (middle[1] - middle[0]) <= 0.05 * mid,
    serialSeconds: median(aSeconds), pooledSeconds: median(bSeconds), rows: rowCount,
    pooledRowsPerSecond: rowCount / median(bSeconds), meets2100: rowCount / median(bSeconds) >= 2100,
    callMs: { p50: quantile(latencies[phase], 0.5), p95: quantile(latencies[phase], 0.95), max: Math.max(...latencies[phase]) } };
};
for (let cycle = 0; cycle < 4; ++cycle) {
  for (const f of models) { f.close(); assert.equal(f.open(n * (32 + 1700) + 1048576), 0); }
  for (const phase of ["first", "rolling"]) {
    const t = EPOCH_MS + 3600000 + (phase === "rolling" ? 2880000 : 0);
    const target = phase === "first" ? 2 * n : n, elapsed = [0, 0, 0, 0];
    const startRows = models.map(f => f.stats()[STAT.rows]);
    for (let r = 0; r < rounds; ++r) {
      const endRows = Math.ceil(target * (r + 1) / rounds), run = [];
      for (let k = 0; k < 4; ++k) {
        const f = models[k], begin = f.stats()[STAT.rows], deadlineRows = startRows[k] + endRows;
        let completed = begin, result;
        const beginMs = performance.now();
        while (completed < deadlineRows) {
          const callStart = performance.now();
          result = f.refill(t, 2880, Math.min(32, deadlineRows - completed));
          const callMs = performance.now() - callStart;
          if (k === 1 || k === 2) latencies[phase].push(callMs);
          assert.equal(result.rc, 0); assert.equal(result.unstored, 0);
          const after = f.stats()[STAT.rows]; assert.ok(after > completed, "logical work remains"); completed = after;
        }
        const ms = performance.now() - beginMs; elapsed[k] += ms;
        run.push({ ms, rows: completed - begin });
      }
      assert.ok(run.every(s => s.rows === run[0].rows));
      const stats = models.map(f => f.stats());
      for (let k = 1; k < 4; ++k) assert.deepEqual(stats[k], stats[0]);
      samples[phase].push(run);
      console.log(JSON.stringify({ phase, cycle, round: r + 1, rows: run[0].rows, ratio: (run[0].ms + run[3].ms) / (run[1].ms + run[2].ms), load: os.loadavg() }));
    }
    totals[phase].push(elapsed);
    for (let k = 0; k < 4; ++k) {
      assert.equal(models[k].stats()[STAT.rows] - startRows[k], target);
      assert.equal(models[k].fill(t, 2880, 32).stored, 0);
      assert.equal(models[k].poolStats()[4], 0);
    }
    const hashes = models.map(hash); assert.ok(hashes.every(h => h === hashes[0]), "control and pooled frame bits");
  }
  if (summary("first").usable && summary("rolling").usable) break;
}
const result = { n, threads, cells: 2, maxRows: 32, order: "A B B A", loadStart, loadEnd: os.loadavg(),
  controlSha256: createHash("sha256").update(fs.readFileSync(process.env.FRAMES_CONTROL)).digest("hex"),
  changedSha256: createHash("sha256").update(fs.readFileSync(process.env.SDNAP_WASM)).digest("hex"),
  first: summary("first"), rolling: summary("rolling"), pool: models[1].poolStats(), samples, totals,
  completeCatalog: n === 100000 };
if (process.env.FRAMES_RESULT) fs.writeFileSync(process.env.FRAMES_RESULT, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ ...result, samples: undefined, totals: undefined }));
for (const f of models) await f.h.destroy();

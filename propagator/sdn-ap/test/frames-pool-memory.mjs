#!/usr/bin/env node
// One instance per measurement, synthetic records, size-prefixed OCM load parts of at most 1,000.
// The covariance shape comes from the synthetic fit fixture; elements and weather come from the seeded population.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { openFrames, EPOCH_MS, STAT } from "./lib/frame-cells.mjs";
import { catalogPopulation, loadCatalog } from "./lib/frame-catalog.mjs";
const n = Number(process.env.FRAMES_OBJECTS ?? 100000), threads = Number(process.env.FRAMES_THREADS ?? 4);
const cells = Number(process.env.FRAMES_CELLS ?? 2), covariance = process.env.FRAMES_COV === "1";
const profile = process.env.FRAMES_PROFILE ?? "recipe";
const maxDegree = Number(process.env.FRAMES_MAX_DEGREE ?? 0);
const pop = catalogPopulation(n, profile), eligible = pop.filter(o => o.serves).length;
const f = await openFrames({ initialMemoryBytes: 2 * 1048576, threads });
const result = { n, threads, cells, covariance, profile, maxDegree, loadStart: os.loadavg(), emptyBytes: f.mem().byteLength };
await loadCatalog(f, pop, { covariance, maxDegree });
result.afterLoad = f.mem().byteLength; result.framePlaneBytes = 52 * n;
console.log(JSON.stringify({ stage: "loaded", n, threads, cells, covariance, profile, bytes: result.afterLoad }));
result.budget = 32 * n + 850 * eligible * cells + 1048576;
assert.equal(f.open(result.budget), 0); result.afterOpen = f.mem().byteLength;
const time = EPOCH_MS + 3600000, ahead = cells === 1 ? 0 : 2880;
assert.equal(f.refill(time, ahead, 32).rc, 0); result.afterFirstBatch = f.mem().byteLength;
assert.equal(f.fill(time, ahead, 5000).due, 0); result.afterFill = f.mem().byteLength;
console.log(JSON.stringify({ stage: "filled", bytes: result.afterFill }));
result.initialStats = f.stats();
for (let turn = 1; turn <= 2; ++turn) assert.equal(f.fill(time + turn * 2880000, ahead, 5000).due, 0);
result.afterTurns = f.mem().byteLength; result.stats = f.stats(); result.pool = f.poolStats();
result.statusCounts = {};
for (const s of f.at(time + 5760000).status) result.statusCounts[s] = (result.statusCounts[s] ?? 0) + 1;
assert.equal(result.stats[STAT.rowsOom], 0); assert.equal(result.stats[STAT.full], 0);
assert.equal(result.stats[STAT.cells], eligible * cells);
assert.equal((result.statusCounts[0] ?? 0) + (result.statusCounts[3] ?? 0) + (result.statusCounts[4] ?? 0), eligible);
assert.equal(result.pool[4], 0);
if (threads) assert.ok(result.pool[14] > 0 && result.pool[15] > 0);
result.totalBytes = f.mem().byteLength; result.excessBytes = Math.max(0, result.totalBytes - 300000000);
result.loadEnd = os.loadavg(); result.completeCatalog = n === 100000;
if (process.env.FRAMES_RESULT) fs.writeFileSync(process.env.FRAMES_RESULT, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result));
await f.h.destroy();

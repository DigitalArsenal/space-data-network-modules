#!/usr/bin/env node
// One instance per measurement, synthetic records, size-prefixed OCM load parts of at most 1,000.
// The covariance shape comes from the synthetic fit fixture; elements and weather come from the seeded population.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { openFrames, population, ocmOfObject, EPOCH_MS, STAT } from "./lib/frame-cells.mjs";
import { T, ocmOf, repackOcm } from "./lib/ocm.mjs";
const n = Number(process.env.FRAMES_OBJECTS ?? 100000), threads = Number(process.env.FRAMES_THREADS ?? 4);
const cells = Number(process.env.FRAMES_CELLS ?? 2), covariance = process.env.FRAMES_COV === "1";
const profile = process.env.FRAMES_PROFILE ?? "recipe";
const share = p => Math.round(n * p / 100);
const plan = profile === "public" ? [["leo500", share(40.1)], ["leo830", share(33.3)], ["ecc", share(11.8)], ["meo", share(1.6)], ["geo", share(5.3)]] :
  [["leo500", share(25.5)], ["leo830", share(45.05)], ["drag300", share(14.45)], ["meo", share(5)], ["geo", share(5)]];
plan.push([profile === "public" ? "wide" : "ecc", n - plan.reduce((s, p) => s + p[1], 0)]);
const pop = population(plan, 20261113, 48), eligible = pop.filter(o => o.serves).length;
const template = covariance ? ocmOf(fs.readFileSync(new URL("fixtures/synthetic-grid-hp300-e0-i70.ocm", import.meta.url))) : null;
const f = await openFrames({ initialMemoryBytes: 2 * 1048576, threads });
const result = { n, threads, cells, covariance, profile, loadStart: os.loadavg(), emptyBytes: f.mem().byteLength };
const invoke = async (methodId, inputs = []) => { const r = await f.h.invoke({ methodId, inputs }); assert.equal(r.statusCode, 0, r.errorMessage); };
await invoke("load_epochs_open");
for (let k = 0; k < n; k += 1000) {
  const payload = Buffer.concat(pop.slice(k, k + 1000).map(o => {
    let u = ocmOfObject(o);
    if (template) u = repackOcm(u, t => {
      for (const key of Object.keys(template)) if (key.startsWith("COV")) t[key] = template[key];
      t.ORBIT_DETERMINATION = template.ORBIT_DETERMINATION;
      t.PROVENANCE = template.PROVENANCE;
      const p = t.COV_PROPAGATION;
      p.NOISE_NON_GRAVITATIONAL_RAD_DAY2 = p.NON_GRAVITATIONAL_SHARE * Math.abs(p.NON_GRAVITATIONAL_RATE_PER_DAY) * t.MEAN_ELEMENTS.MEAN_MOTION * 2 * Math.PI;
    });
    const b = Buffer.alloc(4 + u.length); b.writeUInt32LE(u.length); b.set(u, 4); return b;
  }));
  const p = f.x.plugin_alloc(payload.length); assert.ok(p);
  new Uint8Array(f.mem(), p, payload.length).set(payload);
  const r = await f.h.invoke({ methodId: "load_epochs_part", externalArena: new Uint8Array(f.mem()), inputs: [{ portId: "ocm", typeRef: T("OCM"), offset: p, size: payload.length, alignment: 1 }] });
  f.x.plugin_free(p, payload.length); assert.equal(r.statusCode, 0, r.errorMessage);
}
await invoke("load_epochs_close");
assert.equal(f.x.sdnap_epochs_count(), n); f.adopt(n);
result.afterLoad = f.mem().byteLength; result.framePlaneBytes = 52 * n;
result.budget = 32 * n + 850 * eligible * cells + 1048576;
assert.equal(f.open(result.budget), 0); result.afterOpen = f.mem().byteLength;
const time = EPOCH_MS + 3600000, ahead = cells === 1 ? 0 : 2880;
assert.equal(f.refill(time, ahead, 32).rc, 0); result.afterFirstBatch = f.mem().byteLength;
assert.equal(f.fill(time, ahead, 5000).due, 0); result.afterFill = f.mem().byteLength;
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

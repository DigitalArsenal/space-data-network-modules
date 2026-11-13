#!/usr/bin/env node
// SPEC 19.6: the bytes of the frames at 100,000 objects. Two catalogs: the load probe's recipe (85 % low near-circular, 5 % medium, 5 % geosynchronous,
// 5 % eccentric) and the public catalog's shares (92.1 % of its objects at eccentricity 0.05 or under; the rest are wide and not served). The epochs are spread
// over one window, so each object's grid is anchored at its own epoch. Each catalog is loaded in parts of 1,000, the frames opened over a budget, every object
// filled at one instant, then the clock moved to 170 s before the next window of the objects whose window ends first.
// Asserted: the frames' own bytes are the budget given (one block); the slab used after a full fill is at most the figure SPEC 19.6 states; no row is refused
// for room; the instance's memory grows by no more than the block plus 4 MiB; the objects the entry does not serve answer "not served by this entry".
//   FRAMES_OBJECTS=100000 node test/frames-memory.e2e.mjs   (the default; a smaller count scales the figures)
import assert from "node:assert/strict";
import { T } from "./lib/ocm.mjs";
import { population, ocmOfObject, openFrames, EPOCH_MS, STAT, STATUS } from "./lib/frame-cells.mjs";

const N = Number(process.env.FRAMES_OBJECTS ?? 100000);
const PART = 1000, MIB = 1048576;
// SPEC 19.6: bytes of slab used by one served object after a full fill, per catalog (the cell holding the instant), and the budget a host gives per object
const FIGURE = { recipe: Number(process.env.FIGURE_RECIPE ?? 850), public: Number(process.env.FIGURE_PUBLIC ?? 850) };
const share = (n, p) => Math.round((n * p) / 100);
const plans = {
  recipe: (n) => { const low = share(n, 85), a = share(low, 30), b = share(low, 53); return [["leo500", a], ["leo830", b], ["drag300", low - a - b], ["meo", share(n, 5)], ["geo", share(n, 5)], ["ecc", n - low - 2 * share(n, 5)]]; },
  public: (n) => { const a = share(n, 40.1), b = share(n, 33.3), c = share(n, 11.8), d = share(n, 1.6), e = share(n, 5.3); return [["leo500", a], ["leo830", b], ["ecc", c], ["meo", d], ["geo", e], ["wide", n - a - b - c - d - e]]; },
};
const out = {};
for (const [name, plan] of Object.entries(plans)) {
  const pop = population(plan(N), 20261113, 48);
  const f = await openFrames({ initialMemoryBytes: 2 * MIB });
  // the load, in parts of 1,000
  const x = f.x;
  let r = await f.h.invoke({ methodId: "load_epochs_open", inputs: [] });
  assert.equal(r.statusCode, 0, r.errorMessage);
  for (let k = 0; k < pop.length; k += PART) {
    const payload = Buffer.concat(pop.slice(k, k + PART).map((o) => { const u = ocmOfObject(o); const b = Buffer.alloc(4 + u.length); b.writeUInt32LE(u.length, 0); Buffer.from(u).copy(b, 4); return b; }));
    r = await f.h.invoke({ methodId: "load_epochs_part", inputs: [{ portId: "ocm", typeRef: T("OCM"), payload }] });
    assert.equal(r.statusCode, 0, r.errorMessage);
  }
  r = await f.h.invoke({ methodId: "load_epochs_close", inputs: [] });
  assert.equal(r.statusCode, 0, r.errorMessage);
  { const p = x.sdnap_alloc(64); x.sdnap_epochs_stats(p); const s = Array.from(new Float64Array(f.mem(), p, 8)); assert.equal(x.sdnap_epochs_count(), pop.length, `the store kept ${s.slice(0, 7).join(" ")} of ${pop.length}`); }
  f.adopt(pop.length);
  const afterLoad = f.mem().byteLength;
  const served = pop.filter((o) => o.serves).length;
  const budget = Math.ceil(FIGURE[name] * served * 1.0) + pop.length * 48 + MIB;
  assert.equal(f.open(budget), 0);
  const afterOpen = f.mem().byteLength;
  const st0 = f.stats();
  assert.equal(st0[STAT.held], budget - (budget - st0[STAT.table] - st0[STAT.slab]), "the table and the slab are the block");
  assert.equal(st0[STAT.eligible], served);
  const t = EPOCH_MS + 3600e3;
  const t0 = performance.now();
  let due = f.refill(t, 180, 2000);
  while (due > 0) { const left = f.refill(t, 180, 2000); assert.ok(left < due, "every call builds rows"); due = left; }
  const fillS = (performance.now() - t0) / 1000;
  const afterFill = f.mem().byteLength;
  const st = f.stats();
  assert.equal(st[STAT.full], 0, "no row refused for room");
  assert.equal(st[STAT.rowsOom], 0);
  assert.equal(st[STAT.cells] >= served - st[STAT.apRefused] - st[STAT.builderFailed], true);
  const perObject = (st[STAT.used] - 64) / Math.max(1, st[STAT.cells]);
  const q = f.at(t);
  for (let i = 0; i < pop.length; i++) if (!pop[i].serves) assert.equal(q.status[i], STATUS.notServedHere);
  out[name] = { objects: pop.length, served, budget, afterLoad, afterOpen, afterFill, slabUsed: st[STAT.used], cells: st[STAT.cells], bytesPerCell: +perObject.toFixed(1), table: st[STAT.table], fillSeconds: +fillS.toFixed(1), apRefused: st[STAT.apRefused], builderFailed: st[STAT.builderFailed] };
  console.log(name, JSON.stringify(out[name]));
  assert.ok(afterFill - afterOpen <= 4 * MIB, `a refill row's cold set and the thread caches grew the instance by ${afterFill - afterOpen} B`);
  assert.ok(st[STAT.used] <= FIGURE[name] * served + MIB, `slab used ${st[STAT.used]} B over the stated ${FIGURE[name]} B an object`);
  // the clock moves on: the cells of the objects whose window ends within 3 minutes are replaced; the slab holds them beside the cells they replace
  let worstUsed = st[STAT.used];
  for (let m = 1; m <= 48; m++) { f.refill(t + m * 60000, 180, 1 << 30); worstUsed = Math.max(worstUsed, f.stats()[STAT.used]); }
  const sf = f.stats();
  assert.equal(sf[STAT.full], 0, "no row refused for room while the windows turn over");
  assert.ok(sf[STAT.used] <= FIGURE[name] * served + MIB, `slab used ${sf[STAT.used]} B after the windows turned over: over the stated ${FIGURE[name]} B an object served`);
  out[name].afterTurn = { slabUsed: sf[STAT.used], bytesPerServed: +(sf[STAT.used] / served).toFixed(1), cells: sf[STAT.cells], cellBytes: sf[STAT.cellBytes], slackShare: +((sf[STAT.used] - 64 - sf[STAT.cellBytes]) / sf[STAT.used]).toFixed(4) };  // the slab's classes of 64 B and the cells on the free lists
  console.log(`${name}: slab used after a full turn of the windows ${sf[STAT.used]} B (${(sf[STAT.used] / served).toFixed(1)} B an object served), cells ${sf[STAT.cells]}, their own bytes ${sf[STAT.cellBytes]}`);
  f.close();
}
console.log(JSON.stringify(out));
console.log("FRAMES-MEMORY PASS");

#!/usr/bin/env node
// SPEC 19.6: the bytes of the frames at 100,000 objects. Two catalogs: the load probe's recipe (85 % low near-circular, 5 % medium, 5 % geosynchronous,
// 5 % eccentric below 0.05) and the public catalog's shares (92.1 % of its objects served, the rest wide). Seeded sets with epochs spread over one window, so each
// object's grid is anchored at its own epoch. Each catalog is loaded in parts of 1,000, the frames opened with the budget SPEC 19.6 states as a rule (850 bytes for
// each object served, 32 bytes for each series, 1 MiB), every object filled at one instant, then the windows turned over (48 minutes in steps of one).
// Asserted: the open grows the instance by the block and no more than 4 MiB; a full fill grows it by no more than 4 MiB (a thread's caches, made once);
// every object the entry serves is served; no row is refused for room through the turn of the windows; the slab used stays under the stated figure; on the
// recipe the instance, with the stored load of 100,000 sets with covariance (180,486,144 bytes), is under 300 MB decimal; the objects not served answer 2.
// A run with another count is PARTIAL: it prints PARTIAL and exits 2, unless FRAMES_PARTIAL=1 (exit 0, still printing PARTIAL).
//   node test/frames-memory.e2e.mjs   (about 7 minutes, 3 GB of the host's memory)
import assert from "node:assert/strict";
import { T } from "./lib/ocm.mjs";
import { population, ocmOfObject, openFrames, EPOCH_MS, STAT, STATUS } from "./lib/frame-cells.mjs";

const FULL = 100000;
const N = Number(process.env.FRAMES_OBJECTS ?? FULL);
const PART = 1000, MIB = 1048576;
const PER_SERVED = 850, PER_SERIES = 32;       // SPEC 19.6: the host's rule for the budget
const STORED_LOAD_BYTES = 180486144;           // the stored 100,000-set load with covariance: counted by test/load-memory.e2e.mjs's probe at 100,000 sets
const share = (n, p) => Math.round((n * p) / 100);
const plans = {
  recipe: (n) => { const low = share(n, 85), a = share(low, 30), b = share(low, 53); return [["leo500", a], ["leo830", b], ["drag300", low - a - b], ["meo", share(n, 5)], ["geo", share(n, 5)], ["ecc", n - low - 2 * share(n, 5)]]; },
  public: (n) => { const a = share(n, 40.1), b = share(n, 33.3), c = share(n, 11.8), d = share(n, 1.6), e = share(n, 5.3); return [["leo500", a], ["leo830", b], ["ecc", c], ["meo", d], ["geo", e], ["wide", n - a - b - c - d - e]]; },
};
const out = {};
for (const [name, plan] of Object.entries(plans)) {
  const pop = population(plan(N), 20261113, 48);
  const f = await openFrames({ initialMemoryBytes: 2 * MIB });
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
  const budget = Math.ceil(PER_SERVED * served + PER_SERIES * pop.length + MIB);
  assert.equal(f.open(budget), 0);
  const afterOpen = f.mem().byteLength;
  const st0 = f.stats();
  assert.equal(st0[STAT.block], budget, "the block as allocated is the budget");
  assert.equal(st0[STAT.eligible], served);
  assert.ok(afterOpen - afterLoad <= budget + 4 * MIB, `open grew the instance by ${afterOpen - afterLoad} B for a block of ${budget} B`);
  const t = EPOCH_MS + 3600e3;
  const t0 = performance.now();
  const fill = f.fill(t, 180, 2000);
  assert.equal(fill.due, 0, "the fill completes");
  const fillS = (performance.now() - t0) / 1000;
  const afterFill = f.mem().byteLength;
  const st = f.stats();
  assert.equal(st[STAT.full], 0, "no row refused for room");
  assert.equal(st[STAT.rowsOom], 0);
  assert.ok(afterFill - afterOpen <= 4 * MIB, `a full fill grew the instance by ${afterFill - afterOpen} B (a thread's caches and a cold set)`);
  const q = f.at(t);
  let nServed = 0;
  for (let i = 0; i < pop.length; i++) {
    if (pop[i].serves) { assert.equal(q.status[i], STATUS.served, `object ${i} (${pop[i].kind}) is served`); nServed++; }
    else assert.equal(q.status[i], STATUS.notServedHere);
  }
  assert.equal(nServed, served);
  out[name] = { objects: pop.length, served, budget, afterLoad, afterOpen, afterFill, slabUsed: st[STAT.used], cells: st[STAT.cells], bytesPerCell: +((st[STAT.used] - 64) / st[STAT.cells]).toFixed(1), table: st[STAT.table], fillSeconds: +fillS.toFixed(1), tombstones: st[STAT.apTombstones] + st[STAT.builderTombstones] };
  console.log(name, JSON.stringify(out[name]));
  // the windows turn over
  for (let m = 1; m <= 48; m++) f.refill(t + m * 60000, 180, 1 << 30);
  const sf = f.stats();
  assert.equal(sf[STAT.full], 0, "no row refused for room while the windows turn over");
  assert.ok(sf[STAT.used] <= PER_SERVED * served, `slab used ${sf[STAT.used]} B after the windows turned over: over the stated ${PER_SERVED} B an object served`);
  out[name].afterTurn = { slabUsed: sf[STAT.used], bytesPerServed: +(sf[STAT.used] / served).toFixed(1), cells: sf[STAT.cells], cellBytes: sf[STAT.cellBytes], slackShare: +((sf[STAT.used] - 64 - sf[STAT.cellBytes]) / sf[STAT.used]).toFixed(4), compactions: sf[STAT.compactions], moved: sf[STAT.moved] };
  const total = STORED_LOAD_BYTES + budget + (afterFill - afterOpen);
  out[name].totalWithStoredLoad = total;
  console.log(`${name}: slab used after a full turn of the windows ${sf[STAT.used]} B (${(sf[STAT.used] / served).toFixed(1)} B an object served), cells ${sf[STAT.cells]}, their own bytes ${sf[STAT.cellBytes]}; with the stored load ${(total / 1e6).toFixed(1)} MB`);
  if (name === "recipe" && N === FULL) assert.ok(total < 300e6, `the recipe's instance ${total} B is not under 300 MB decimal`);
  f.close();
}
console.log(JSON.stringify(out));
if (N !== FULL) {
  console.log(`FRAMES-MEMORY PARTIAL (${N} objects, not ${FULL}): the 100,000-object figures are not verified`);
  process.exit(process.env.FRAMES_PARTIAL === "1" ? 0 : 2);
}
console.log("FRAMES-MEMORY PASS");

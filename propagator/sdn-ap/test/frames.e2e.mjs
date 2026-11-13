#!/usr/bin/env node
// SPEC 19, the frames: Chebyshev cells of AP's own states, served by sdnap_frames_*. Each assertion states one outcome (and counts, so that a run in which
// nothing is served cannot pass):
//  - the bound: for a seeded population of 25 objects across the regime (inclinations 0.3 to 140 degrees, eccentricity to 0.05, epochs spread over a day,
//    strong drag, a decaying set, weather rows that start a day before the epoch), every served state is within 1 cm and 1e-4 m/s of AP's own, scanned
//    every second over a day at 0 and 5 days from the epoch and every 17 s over a day at -1, 2 and 10 days (the build tolerance is 5 mm and 5e-5 m/s);
//  - a status depends on the record and the time alone: AP's refusal before the epoch does not reach the times after it; refused and failing windows are tombstones;
//  - purity: two instances that fill their cells in different orders, with different cadences and a jump of the clock, return the same bits and statuses;
//    sdnap_epochs_at (TEME and Earth-fixed), sdnap_epochs_set_at (every set) and propagate_epochs are not changed by refills, in a threaded instance as well;
//  - what the entry does not serve (wide, several sets, a forecast, a hand-over, a stock set) answers "not served by this entry" after a refill;
//  - the slab: refused open by name and a refused open leaves the earlier frames standing; a slab filled to the figure of its own run survives turns of windows
//    whose cells change size (compaction); a refill sliced at 8 rows stores the bits of one at 5,000, visiting each object once;
//  - position-only mode writes three planes; every counted allocation of open and of a refill row failed in turn.
// The module under test is the one SDNAP_WASM names (the committed dist by default): build it first (SDM_MODULE_UNSIGNED_BUILD=1 node build.mjs).
import assert from "node:assert/strict";
import { buildDiagnostic, failureSeam, failureProbe } from "./lib/ap-diagnostic.mjs";
import { population, ocmOfObject, openFrames, epochOf, EPOCH, EPOCH_MS, DAY, STAT, STATUS, CODE } from "./lib/frame-cells.mjs";
import { repackOcm } from "./lib/ocm.mjs";
import { OCMTrajectoryBlockT } from "spacedatastandards.org/lib/js/OCM/OCMTrajectoryBlock.js";
import { CLASSES, harness, carriedRecord } from "./lib/carried.mjs";

// the test builds of this file (a changed tolerance, the allocation seam) are never signed
process.env.SDM_MODULE_UNSIGNED_BUILD = "1";
delete process.env.SDM_MODULE_SIGNING_KEYPAIR_PATH;
const PLAN = [["leo500", 3], ["leo830", 2], ["leo1400", 2], ["drag300", 3], ["drag250", 1], ["ecc", 2], ["ecc05", 1], ["meo", 2], ["geo", 1], ["eqgeo", 1], ["crit", 1], ["polar", 1], ["retro", 1],
  ["shortrows", 1], ["wide", 2], ["decay", 2]];
const POP = population(PLAN, 20261113, 1440);
assert.equal(POP.length, 26);
const BUDGET = 8e6;
const POS_BOUND = 0.01, VEL_BOUND = 1e-4;  // m, m/s
const iso = (ms) => new Date(ms).toISOString().replace("Z", "");
const finish = (name, t0) => console.log(`${name}: ${((Date.now() - t0) / 1000).toFixed(0)} s`);
const T_START = Date.now();

// ---------------------------------------------------------------------------------------------------------------- the bound
{
  const t0 = Date.now();
  const f = await openFrames();
  await f.load(POP);
  assert.equal(f.count, POP.length);
  assert.equal(f.open(BUDGET), 0);
  const kindOf = POP.map((o) => o.kind);
  const strict = new Set(["leo500", "leo830", "leo1400", "ecc", "ecc05", "meo", "geo", "eqgeo", "crit", "polar", "retro"]);
  const drag = new Set(["drag300", "drag250"]);
  let totalServed = 0, decayAll = 0, dragAll = 0;
  for (const [day, stride] of [[0, 1], [5, 1], [-1, 17], [2, 17], [10, 17]]) {
    const t0s = EPOCH_MS + day * DAY + 5000 + 86400000 * 0;
    let worstPos = 0, worstVel = 0, worstAt = "", decayWorst = 0, dragWorst = 0;
    const served = new Array(f.count).fill(0), asked = new Array(f.count).fill(0), refused = new Array(f.count).fill(0);
    for (let s = 0; s < 86400; s += stride) {
      const t = t0s + s * 1000;
      if (s % 60 < stride) f.refill(t, 180);
      const q = f.at(t);
      assert.equal(q.rc, 0);
      for (let i = 0; i < f.count; i++) {
        const kind = kindOf[i];
        asked[i]++;
        if (kind === "wide") { assert.equal(q.status[i], STATUS.notServedHere, `wide object ${i} at ${s} s`); continue; }
        if (q.status[i] === STATUS.served) {
          served[i]++;
          const a = f.ap(i, t);
          assert.ok(a, `AP refuses where a frame is served: ${kind} ${i} at day ${day} + ${s} s`);
          for (let c = 0; c < 3; c++) {
            const dp = Math.abs(a[c] - q.planes[c * f.count + i]) * 1000, dv = Math.abs(a[3 + c] - q.planes[(3 + c) * f.count + i]) * 1000;
            if (kind === "decay") { decayWorst = Math.max(decayWorst, dp); continue; }  // AP's own output steps by centimeters in the last hours before decay (SPEC 19.5)
            if (drag.has(kind)) { dragWorst = Math.max(dragWorst, dp); worstVel = Math.max(worstVel, dv); continue; }  // strong drag: AP's own output steps by up to 10 mm
            if (dp > worstPos) worstAt = `${kind} ${i} at ${s} s`;
            worstPos = Math.max(worstPos, dp);
            worstVel = Math.max(worstVel, dv);
          }
        } else {
          assert.ok([STATUS.apRefuses, STATUS.builderFails].includes(q.status[i]), `object ${i} (${kind}) at day ${day} + ${s} s answered status ${q.status[i]}: after a refill every time is served or a tombstone`);
          refused[i]++;
        }
      }
    }
    assert.ok(worstPos <= POS_BOUND, `day ${day}: worst position ${worstPos} m (${worstAt})`);
    assert.ok(worstVel <= VEL_BOUND, `day ${day}: worst velocity ${worstVel} m/s`);
    assert.ok(dragWorst <= 0.015, `day ${day}: the strong-drag sets' worst position ${dragWorst} m`);
    dragAll = Math.max(dragAll, dragWorst);
    assert.ok(decayWorst <= 0.05, `day ${day}: the decaying sets' worst position ${decayWorst} m`);
    decayAll = Math.max(decayAll, decayWorst);
    for (let i = 0; i < f.count; i++) {
      const kind = kindOf[i];
      if (strict.has(kind)) assert.equal(served[i], asked[i], `object ${i} (${kind}) served at every scanned time of day ${day}`);
      if (drag.has(kind) && day <= 5) assert.ok(served[i] >= 0.95 * asked[i], `object ${i} (${kind}) served at ${served[i]} of ${asked[i]} times of day ${day}`);
      if (kind === "shortrows") assert.equal(served[i] + refused[i], asked[i]);
      totalServed += served[i];
    }
    const nServedObjects = served.filter((v) => v > 0).length;
    assert.ok(nServedObjects >= 18,`${nServedObjects} objects served on day ${day}`);
    // the decaying sets: served while AP serves them, tombstones where it refuses
    if (day >= 5) POP.forEach((o, i) => { if (o.kind === "decay") assert.ok(refused[i] > 0, `decaying set ${i} reaches a tombstone by day ${day}`); });
    console.log(`bound day ${day}: ${served.reduce((a, b) => a + b, 0)} served points, worst ${worstPos.toExponential(2)} m, ${worstVel.toExponential(2)} m/s`);
  }
  assert.ok(totalServed > 1.5e6, `${totalServed} served points in all`);
  console.log(`the strong-drag sets (perigee 250 and 300 km): worst position ${dragAll.toExponential(2)} m against the bound of 1.5 cm`);
  console.log(`the decaying sets: worst position ${decayAll.toExponential(2)} m while served (the 1 cm bound is not promised in the last hours before decay)`);
  const st = f.stats();
  assert.ok(st[STAT.apTombstones] > 0, "the decaying sets leave AP-refusal tombstones");
  finish("bound", t0);
}

// ---------------------------------------------------------------------------------------------------------------- a status depends on the record and the time alone
{
  const t0 = Date.now();
  const pop = population([["shortrows", 1], ["leo500", 1]], 7, 1440);
  const a = await openFrames(), b = await openFrames();
  await a.load(pop); await b.load(pop);
  assert.equal(a.open(BUDGET), 0); assert.equal(b.open(BUDGET), 0);
  const epoch = epochOf(pop[0]);
  const back = epoch - 2 * DAY + 3600e3, fwd = epoch + 3600e3;
  // a: before the epoch first, then after; b: after first, then before
  a.fill(back, 180); const qaBack = a.at(back);
  a.fill(fwd, 180); const qaFwd = a.at(fwd);
  b.fill(fwd, 180); const qbFwd = b.at(fwd);
  b.fill(back, 180); const qbBack = b.at(back);
  assert.equal(qaBack.status[0], STATUS.apRefuses, "two days before the epoch the weather rows are short: AP refuses");
  assert.equal(a.ap(0, back), null, "and AP's own export refuses there");
  assert.equal(qaFwd.status[0], STATUS.served, "AP's refusal before the epoch does not reach the times after it");
  assert.ok(a.ap(0, fwd) !== null);
  assert.deepEqual([Array.from(qaBack.status), Array.from(qaFwd.status)], [Array.from(qbBack.status), Array.from(qbFwd.status)], "the same statuses whatever the order");
  for (let q = 0; q < qaFwd.planes.length; q++) assert.ok(Object.is(qaFwd.planes[q], qbFwd.planes[q]), "the same bits whatever the order");
  // a time before the epoch that AP serves is served
  const near = epoch - 12 * 3600e3;
  a.fill(near, 180);
  const qn = a.at(near);
  assert.equal(qn.status[1], STATUS.served, "a time before the epoch is served like one after it");
  for (let c = 0; c < 3; c++) assert.ok(Math.abs(a.ap(1, near)[c] - qn.planes[c * 2 + 1]) * 1000 <= POS_BOUND);
  // a tombstone is not rebuilt: a second refill at the same time builds nothing
  a.fill(back, 180);
  const again = a.refill(back, 181);  // another sweep: the tombstone and the cells that cover the time are not rebuilt
  assert.equal(again.stored + again.tombstones, 0);
  assert.equal(a.at(back).status[0], STATUS.apRefuses);
  finish("status by record and time", t0);
}

// ---------------------------------------------------------------------------------------------------------------- what the entry does not serve; the existing exports
{
  const t0 = Date.now();
  const f = await openFrames();
  const base = population([["leo500", 2]], 11, 0);
  const ocms = base.map((o) => ocmOfObject(o));
  const wide = population([["wide", 1]], 12, 0); wide[0].norad = 310000;
  const multi = population([["leo830", 1]], 13, 0); multi[0].norad = 310001;
  const multi2 = { ...multi[0], epochOffsetMs: 6 * 3600e3, ma: 40 };
  const stock = population([["leo500", 1]], 14, 0); stock[0].norad = 310002;
  const hand = repackOcm(ocmOfObject({ ...base[0], norad: 310003 }), (t) => {
    t.TRAJECTORY_BLOCKS = [Object.assign(new OCMTrajectoryBlockT(), { TRAJ_ID: "HAND-OVER", USEABLE_START_TIME: iso(EPOCH_MS + 3600e3) })];
  });
  const ch = await harness();
  const carried = (await carriedRecord(ch, CLASSES[2], { norad: 310004 })).ocm;
  const records = [...ocms, ocmOfObject(wide[0]), ocmOfObject(multi[0]), ocmOfObject(multi2), ocmOfObject(stock[0], false), hand, new Uint8Array(carried)];
  await f.load(null, records);
  const series = f.count;
  // series order is by catalog number: 300000, 300001 (leo500), 310000 wide, 310001 two sets, 310002 stock, 310003 hand-over, 310004 forecast
  assert.equal(series, 7);
  const times = [0.3, 0.9, 1.4].map((d) => EPOCH_MS + d * DAY);
  const sets = [1, 1, 1, 2, 1, 1, 1];
  const snapshot = () => {
    const out = [];
    for (const t of times) { const a = f.epochsAt(t), e = f.epochsAt(t, 3); out.push(a, e); }
    for (let i = 0; i < series; i++) for (let k = 0; k < sets[i]; k++) for (const t of times) out.push(f.ap(i, t, k));
    return out;
  };
  const before = snapshot();
  assert.equal(f.open(BUDGET), 0);
  const eligible = f.stats()[STAT.eligible];
  assert.equal(eligible, 2, "only the two plain AP sets can be served");
  const t = EPOCH_MS + 0.5 * DAY;
  const r = f.fill(t, 180);
  assert.ok(r.stored >= 0 && r.calls >= 1);
  const q = f.at(t);
  assert.deepEqual(Array.from(q.status), [STATUS.served, STATUS.served, ...[2, 2, 2, 2, 2]], "wide, two sets, stock, hand-over and forecast answer 'not served by this entry'");
  const after = snapshot();
  assert.equal(after.length, before.length);
  for (let k = 0; k < before.length; k++) {
    const x = before[k], y = after[k];
    if (Array.isArray(x)) assert.ok(x.length === y.length && x.every((v, j) => Object.is(v, y[j])), `set state ${k} changed after a refill`);
    else {
      assert.equal(y.rc, x.rc);
      assert.deepEqual(Array.from(y.status), Array.from(x.status));
      assert.ok(x.planes.every((v, j) => Object.is(v, y.planes[j])), `sdnap_epochs_at call ${k} changed after a refill`);
    }
  }
  const propBefore = await f.propagateEpochs(records.slice(0, 3), times.map(iso));
  f.fill(t + 3600e3, 180);
  assert.ok((await f.propagateEpochs(records.slice(0, 3), times.map(iso))).equals(propBefore), "propagate_epochs changed after a refill");
  finish("not served by this entry", t0);
}

// ---------------------------------------------------------------------------------------------------------------- purity, and a threaded instance
{
  const t0 = Date.now();
  const a = await openFrames({ threads: 4 }), b = await openFrames();
  const live = population([["leo500", 20], ["leo830", 10], ["drag300", 6], ["meo", 4], ["geo", 4], ["ecc", 4], ["decay", 2]], 99, 1440);
  await a.load(live); await b.load(live);
  const times = [0.3, 1.7, 5.2].map((d) => EPOCH_MS + d * DAY);
  const before = [];
  for (const t of times) before.push(a.epochsAt(t), a.epochsAt(t, 3));  // pool batches (the store is above the chunk size)
  const beforeSet = times.map((t) => live.map((_, i) => a.ap(i, t)));
  const isoTimes = times.map(iso);
  const propBefore = await a.propagateEpochs(live.slice(0, 6).map((o) => ocmOfObject(o)), isoTimes);
  assert.equal(a.open(BUDGET), 0);
  assert.equal(b.open(BUDGET), 0);
  const all = Array.from({ length: live.length }, (_, i) => i);
  let compared = 0, tombstones = 0;
  for (const day of [0, 5, -1]) {
    const base = EPOCH_MS + day * DAY + 3600e3;
    // a: the clock moves forward a minute at a time, objects in index order; b: three minutes at a time, objects in reverse priority, after a jump away and back
    for (let m = 0; m <= 120; m++) a.refill(base + m * 60000, 180, 1 << 30, all);
    b.refill(base + 3 * DAY, 180, 1 << 30, all.slice().reverse());
    for (let m = 0; m <= 120; m += 3) b.refill(base + m * 60000, 180, 1 << 30, all.slice().reverse());
    for (const m of [30, 61, 90.5]) {
      const t = base + m * 60000;
      a.fill(t, 180); b.fill(t, 180);
      const qa = a.at(t), qb = b.at(t);
      for (let i = 0; i < live.length; i++) {
        assert.equal(qa.status[i], qb.status[i], `status ${i}`);
        if (qa.status[i] !== STATUS.served) { if (qa.status[i] >= 3) tombstones++; continue; }
        for (let c = 0; c < 6; c++) assert.ok(Object.is(qa.planes[c * live.length + i], qb.planes[c * live.length + i]), `bits of object ${i} component ${c} at day ${day} minute ${m}`);
        compared++;
      }
      // no ask of the epoch store between the refills: in this release a later ask at an earlier time moves AP's own states of medium-orbit sets, with no frames
      // open (the history dependence of AP's flight, known; SPEC 19.4); the store is asked before the first refill and after the last, in the same order
    }
  }
  assert.ok(compared >= 9 * 40, `${compared} served states compared`);
  assert.ok(tombstones >= 0);
  const after = [];
  for (const t of times) after.push(a.epochsAt(t), a.epochsAt(t, 3));
  for (let k = 0; k < before.length; k++) {
    assert.equal(after[k].rc, before[k].rc);
    assert.deepEqual(Array.from(after[k].status), Array.from(before[k].status));
    for (let q = 0; q < before[k].planes.length; q++) assert.ok(Object.is(after[k].planes[q], before[k].planes[q]), `sdnap_epochs_at changed after a refill (call ${k}, value ${q})`);
  }
  times.forEach((t, k) => live.forEach((_, i) => {
    const s = a.ap(i, t);
    for (let c = 0; c < 6; c++) assert.ok(Object.is(s?.[c], beforeSet[k][i]?.[c]), `sdnap_epochs_set_at changed after a refill (object ${i})`);
  }));
  assert.ok((await a.propagateEpochs(live.slice(0, 6).map((o) => ocmOfObject(o)), isoTimes)).equals(propBefore), "propagate_epochs changed after a refill");
  console.log(`purity: ${compared} served states from two fill orders identical; epochs_at (TEME, Earth-fixed), set_at and propagate_epochs unchanged, the instance threaded, with pool batches before the first refill and after the last`);
  finish("purity", t0);
}

// ---------------------------------------------------------------------------------------------------------------- the slab: budget, lifetime, compaction, slicing
{
  const t0 = Date.now();
  const f = await openFrames();
  await f.load(POP);
  // lifetime and arguments
  assert.equal(f.at(EPOCH_MS).rc, CODE.notOpen);
  assert.equal(f.refill(EPOCH_MS).rc, CODE.notOpen);
  assert.equal(f.open(1000), CODE.budgetTooSmall);
  const needed = f.stats()[STAT.needed];
  assert.ok(needed > 1000);
  assert.equal(f.open(needed - 1), CODE.budgetTooSmall);
  assert.equal(f.open(needed), 0, "open at exactly the bytes it stated it needed");
  assert.equal(f.stats()[STAT.block], needed, "the block as allocated is the budget to the byte");
  assert.equal(f.open(1000), CODE.budgetTooSmall, "a refused open");
  assert.equal(f.at(EPOCH_MS).rc, 0, "leaves the earlier frames standing");
  assert.equal(f.open(-1), CODE.badArgument);
  assert.equal(f.open(1e9, 2), CODE.badArgument);
  const bad = f.refill(NaN);
  assert.equal(bad.rc, CODE.badArgument);
  assert.equal(f.refill(EPOCH_MS, Infinity).rc, CODE.badArgument);
  assert.equal(f.refill(EPOCH_MS, -1).rc, CODE.badArgument);
  assert.equal(f.at(EPOCH_MS, 0, f.count + 1).rc, CODE.badArgument);
  assert.equal(f.at(EPOCH_MS, 0, 1, 1).rc, CODE.badArgument);
  f.close();
  assert.equal(f.at(EPOCH_MS).rc, CODE.notOpen);
  assert.equal(f.open(BUDGET), 0);
  // statuses: no segment before a refill, not served for the wide sets, the result of a refill
  const t = EPOCH_MS + 3600e3 + 86400000;
  let q = f.at(t);
  POP.forEach((o, i) => assert.equal(q.status[i], o.kind === "wide" ? STATUS.notServedHere : STATUS.noSegment, `before a refill: ${o.kind}`));
  assert.ok(q.planes.every((v) => Number.isNaN(v)), "the planes of an unserved object are NaN");
  const first = f.refill(t, 0, 1, [4, 99999]);  // one row, the object the host named first; an index past the end is skipped
  assert.equal(first.rc, 0);
  assert.equal(first.stored + first.tombstones, 1);
  assert.ok(first.left[0] > 0);
  q = f.at(t);
  assert.equal(q.status[4], STATUS.served);
  assert.equal(q.status.filter((s) => s === STATUS.served).length, 1);
  const rest = f.fill(t, 180);
  assert.equal(rest.due, 0);
  q = f.at(t);
  const nServed = q.status.filter((s) => s === STATUS.served).length;
  assert.ok(nServed >= POP.length - 5,`${nServed} objects served after a full fill`);
  // the Earth-fixed frame is AP's, rotated by the same function the epoch store uses
  const ecef = f.at(t, 0, f.count, 3), ref = f.epochsAt(t, 3);
  let ecefChecked = 0;
  for (let i = 0; i < f.count; i++) if (ecef.status[i] === STATUS.served) {
    ecefChecked++;
    for (let c = 0; c < 6; c++) assert.ok(Math.abs(ecef.planes[c * f.count + i] - ref.planes[c * f.count + i]) <= (c < 3 ? 0.015 : VEL_BOUND), `ECEF ${i} ${c}`);
  }
  assert.equal(ecefChecked, nServed);
  // ahead is clamped to one window: a day ahead stores no more than 48 minutes ahead would
  const g = await openFrames();
  await g.load(POP);
  assert.equal(g.open(BUDGET), 0);
  g.fill(t, 86400);
  assert.ok(g.stats()[STAT.cells] <= 2 * POP.length);
  // a load replaces the store: every cell is dropped, the table read again
  await f.load(POP);
  q = f.at(t);
  assert.equal(q.rc, CODE.storeChanged);
  assert.ok(q.status.every((s) => s === STATUS.noSegment));
  assert.equal(f.stats()[STAT.current], 0);
  assert.equal(f.fill(t, 180).due, 0);
  assert.equal(f.stats()[STAT.current], 1);
  assert.equal(f.at(t).status[0], STATUS.served);
  await f.load(population([["leo500", 100]]));  // more series than open's table
  assert.equal(f.refill(t).rc, CODE.reopen);
  // a slab with room for one largest cell only: rows are refused and counted, the call ends, the objects stay "no segment"
  const small = await openFrames();
  await small.load(POP);
  assert.equal(small.open(1000), CODE.budgetTooSmall);
  assert.equal(small.open(small.stats()[STAT.needed]), 0);
  const left = small.refill(t, 0);
  assert.equal(left.unstored, 1, "a row that cannot be stored ends the call");
  assert.ok(small.stats()[STAT.full] >= 1);
  assert.ok(small.at(t).status.some((s) => s === STATUS.noSegment));
  const again = small.refill(t, 0);
  assert.equal(again.stored + again.tombstones, 0, "and a call that stores nothing is the host's word to stop");
  // compaction: a slab sized to the figure of an unconstrained run survives turns of windows whose cells change size
  const popC = population([["leo500", 20], ["leo830", 20], ["meo", 10], ["geo", 10], ["ecc", 10], ["drag300", 10]], 5, 48);
  const run = async (budget) => {
    const h = await openFrames();
    await h.load(popC);
    assert.equal(h.open(budget), 0);
    let maxLive = 0, full = 0, rows = 0;
    for (let m = 0; m <= 24 * 60; m += 3) {
      const r = h.refill(EPOCH_MS + 3600e3 + m * 60000, 180);
      full += r.unstored; rows += r.stored + r.tombstones;
      maxLive = Math.max(maxLive, h.stats()[STAT.cellBytes]);
    }
    return { h, maxLive, full, rows };
  };
  const free = await run(8e6);
  assert.ok(free.rows > 600 && free.full === 0);
  const tight = Math.ceil(free.maxLive * 1.12) + popC.length * 32 + 64 + 3136 * 2;
  const tightRun = await run(tight);
  const st = tightRun.h.stats();
  assert.equal(tightRun.full, 0, `a slab of ${tight} B (the unconstrained run's largest live cells and 12 %) never refused a row`);
  assert.ok(st[STAT.compactions] > 0, "and it was compacted");
  assert.equal(tightRun.rows, free.rows, "the same rows");
  console.log(`compaction: ${st[STAT.compactions]} compactions, ${st[STAT.moved]} bytes moved, slab ${st[STAT.slab]} B, live cells ${free.maxLive} B`);
  // a sliced refill stores the bits of one big call, visiting each object once
  const popS = population([["leo500", 60], ["leo830", 40], ["meo", 20], ["geo", 20], ["ecc", 20], ["drag300", 20]], 6, 48);
  const sliced = async (maxRows) => {
    const h = await openFrames();
    await h.load(popS);
    assert.equal(h.open(BUDGET * 2), 0);
    let calls = 0, r;
    do { r = h.refill(t, 180, maxRows); calls++; } while (r.due > 0);
    return { h, calls, st: h.stats() };
  };
  const s8 = await sliced(8), sBig = await sliced(5000);
  assert.ok(s8.calls >= popS.length / 8 && sBig.calls <= 2);
  const qa = s8.h.at(t), qb = sBig.h.at(t);
  assert.deepEqual(Array.from(qa.status), Array.from(qb.status));
  for (let q = 0; q < qa.planes.length; q++) assert.ok(Object.is(qa.planes[q], qb.planes[q]), "sliced and unsliced fills store the same bits");
  assert.equal(s8.st[STAT.cells], sBig.st[STAT.cells]);
  assert.ok(s8.st[STAT.visits] <= 2 * popS.length + 2 * s8.calls, `${s8.st[STAT.visits]} visits for ${popS.length} objects in ${s8.calls} calls: one pass over the objects however it is sliced`);
  assert.ok(sBig.st[STAT.visits] <= 2 * popS.length + 2 * sBig.calls);
  finish("slab", t0);
}

// ---------------------------------------------------------------------------------------------------------------- position only; the builder's own status
{
  const t0 = Date.now();
  const pop = population([["leo500", 3], ["leo830", 2], ["geo", 1]], 21, 1440);
  const p = await openFrames(), v = await openFrames();
  await p.load(pop); await v.load(pop);
  assert.equal(p.open(BUDGET, 1), 0);
  assert.equal(v.open(BUDGET), 0);
  const t = EPOCH_MS + 3600e3 + DAY;
  p.fill(t, 180); v.fill(t, 180);
  const qp = p.at(t), qv = v.at(t);
  assert.equal(qp.planes.length, 3 * pop.length, "position-only writes three planes");
  assert.equal(qv.planes.length, 6 * pop.length);
  for (let i = 0; i < pop.length; i++) {
    assert.equal(qp.status[i], STATUS.served);
    for (let c = 0; c < 3; c++) {
      assert.ok(Object.is(qp.planes[c * pop.length + i], qv.planes[c * pop.length + i]), "the positions are the same bits with and without velocity");
      assert.ok(Math.abs(p.ap(i, t)[c] - qp.planes[c * pop.length + i]) * 1000 <= POS_BOUND);
    }
  }
  const ecef = p.at(t, 0, pop.length, 3), rv = v.at(t, 0, pop.length, 3);
  for (let q = 0; q < 3 * pop.length; q++) assert.ok(Object.is(ecef.planes[q], rv.planes[q]));
  // a build whose tolerance no window of 3 minutes holds: the builder's own status
  const wasm = buildDiagnostic("frames-tolerance", "", (s) => s, { "frames.inc": (s) => s.replace("constexpr double kTolPos = 5.0e-6;", "constexpr double kTolPos = 1.0e-15;") });
  const f = await openFrames({ wasm });
  await f.load(pop.slice(0, 2));
  assert.equal(f.open(BUDGET), 0);
  const r = f.fill(t, 0);
  assert.equal(r.due, 0);
  assert.equal(r.left[0] + r.left[1], 0);
  const q = f.at(t);
  assert.ok(q.status.every((s) => s === STATUS.builderFails), "a tolerance no window of 3 minutes holds: the builder's own status");
  assert.deepEqual([f.stats()[STAT.apTombstones], f.stats()[STAT.builderTombstones]], [0, 2]);
  finish("position only, builder status", t0);
}

// ---------------------------------------------------------------------------------------------------------------- allocation failures
{
  const t0 = Date.now();
  const wasm = buildDiagnostic("frames-failure", failureProbe, (s) => s, failureSeam);
  const pop = population([["leo500", 1], ["geo", 1], ["ecc", 1]], 31, 0);
  const make = async () => { const f = await openFrames({ wasm }); await f.load(pop); return f; };
  // open: its counted allocations, exactly, then each failed in turn
  const probe = await make();
  probe.x.sdnap_test_fail_at(0);
  assert.equal(probe.open(BUDGET), 0);
  const openCount = probe.x.sdnap_test_alloc_count();
  assert.equal(openCount, 1, "open makes one counted allocation: the block");
  for (let k = 1; k <= openCount; k++) {
    const f = await make();
    f.x.sdnap_test_fail_at(k);
    assert.equal(f.open(BUDGET), CODE.outOfMemory, `open with allocation ${k} refused`);
    assert.equal(f.stats()[STAT.needed], BUDGET, "the bytes asked are stated");
    assert.equal(f.at(EPOCH_MS).rc, CODE.notOpen);
    f.x.sdnap_test_fail_at(0);
    assert.equal(f.open(BUDGET), 0, "open then succeeds");
  }
  // a refused open leaves the earlier frames standing, the cells included
  {
    const f = await make();
    assert.equal(f.open(BUDGET), 0);
    f.fill(EPOCH_MS + 3600e3, 0);
    f.x.sdnap_test_fail_at(1);
    assert.equal(f.open(BUDGET), CODE.outOfMemory);
    f.x.sdnap_test_fail_at(0);
    assert.ok(f.at(EPOCH_MS + 3600e3).status.every((s) => s === STATUS.served), "the earlier frames and their cells stand");
  }
  // a refill row: the clean run first
  for (const idx of [0, 1, 2]) {
    const t = EPOCH_MS + 2 * DAY + 600e3;
    const clean = await make();
    assert.equal(clean.open(BUDGET), 0);
    clean.refill(t, 0, 1, [idx], 1 << 30);  // armed at a count never reached: counts the row's allocations
    const rowCount = clean.x.sdnap_test_alloc_count();
    assert.ok(rowCount >= 2);
    clean.x.sdnap_test_fail_at(0);
    assert.equal(clean.fill(t, 0, 5000, [idx]).due, 0);
    const want = clean.at(t), wantStats = clean.stats();
    for (let k = 1; k <= rowCount; k++) {
      const f = await make();
      assert.equal(f.open(BUDGET), 0);
      const before = f.stats();
      const r = f.refill(t, 0, 1, [idx], k);
      assert.equal(r.rc, 0);
      assert.equal(r.unstored, 1, `allocation ${k} of a row (object ${idx}): the row is reported as not stored`);
      assert.equal(f.stats()[STAT.rowsOom], 1);
      assert.equal(f.at(t).status[idx], STATUS.noSegment, `allocation ${k}: the object keeps no cell`);
      const mid = f.stats();
      assert.deepEqual([mid[STAT.cells], mid[STAT.used], mid[STAT.cellBytes], mid[STAT.block]], [before[STAT.cells], before[STAT.used], before[STAT.cellBytes], before[STAT.block]], "the slab is as it was");
      f.x.sdnap_test_fail_at(0);
      assert.equal(f.fill(t, 0, 5000, [idx]).due, 0);
      const got = f.at(t), end = f.stats();
      for (let q = 0; q < want.planes.length; q++) assert.ok(Object.is(got.planes[q], want.planes[q]), `allocation ${k}: the refill after it returns the clean run's bits`);
      assert.deepEqual([end[STAT.cells], end[STAT.used], end[STAT.cellBytes]], [wantStats[STAT.cells], wantStats[STAT.used], wantStats[STAT.cellBytes]], "and the clean run's slab");
    }
    console.log(`allocation failures: object ${idx}: ${rowCount} allocations of a row failed in turn`);
  }
  finish("allocation failures", t0);
}
console.log(`FRAMES PASS (${((Date.now() - T_START) / 1000).toFixed(0)} s)`);

#!/usr/bin/env node
// SPEC 19, the frames: Chebyshev cells of AP's own states, served by sdnap_frames_*. Each assertion states one outcome:
//  - the bound: every served object's frame state is within 1 cm and 1e-4 m/s of AP's own, scanned every second over a day at 0 and at 5 days from the epoch,
//    for a seeded population across the regime (the build tolerance is 5 mm and 5e-5 m/s);
//  - purity: two instances that fill their cells in different orders, with different cadences and a jump of the clock, return the same bits; a refill changes
//    no bit of sdnap_epochs_at or sdnap_epochs_set_at asked before and after it;
//  - statuses: no segment, served, not served by this entry (wide, stock set), AP refuses (decay), the builder fails (a build whose tolerance cannot be held),
//    a load drops every cell; the position-only option and the Earth-fixed frame;
//  - the budget: refused by name with the bytes needed, a slab that is full refuses rows and counts them; every counted allocation of open and of a refill row
//    failed in turn leaves the cells as they were, and the same call then answers with the bits of a clean run.
import assert from "node:assert/strict";
import { buildDiagnostic, failureSeam, failureProbe } from "./lib/ap-diagnostic.mjs";
import { population, openFrames, EPOCH_MS, DAY, STAT, STATUS, CODE } from "./lib/frame-cells.mjs";

const POP = population([["leo500", 3], ["leo830", 2], ["leo1400", 2], ["drag300", 2], ["ecc", 2], ["meo", 2], ["geo", 2], ["wide", 2], ["decay", 2]]);
const SERVED_KINDS = new Set(["leo500", "leo830", "leo1400", "drag300", "ecc", "meo", "geo"]);
const BUDGET = 4e6;
const POS_BOUND = 0.01, VEL_BOUND = 1e-4;  // m, m/s

// ---------------------------------------------------------------------------------------------------------------- the bound
{
  const f = await openFrames();
  await f.load(POP);
  assert.equal(f.count, POP.length);
  assert.equal(f.open(BUDGET), 0);
  for (const day of [0, 5]) {
    const t0 = EPOCH_MS + day * DAY + 5000;
    let worstPos = 0, worstVel = 0, scanned = 0, notServed = 0;
    const wasServed = new Array(f.count).fill(0);
    for (let s = 0; s < 86400; s++) {
      const t = t0 + s * 1000;
      if (s % 60 === 0) f.refill(t, 180);
      const q = f.at(t);
      assert.equal(q.rc, 0);
      for (let i = 0; i < f.count; i++) {
        const kind = POP[i].kind;
        if (q.status[i] !== STATUS.served) {
          if (SERVED_KINDS.has(kind)) notServed++;
          if (kind === "wide") assert.equal(q.status[i], STATUS.notServedHere);
          continue;
        }
        wasServed[i]++;
        const a = f.ap(i, t);
        assert.ok(a, `AP refuses where a frame is served: ${kind} ${i} at ${s} s`);
        for (let c = 0; c < 3; c++) {
          worstPos = Math.max(worstPos, Math.abs(a[c] - q.planes[c * f.count + i]) * 1000);
          worstVel = Math.max(worstVel, Math.abs(a[3 + c] - q.planes[(3 + c) * f.count + i]) * 1000);
        }
        scanned++;
      }
    }
    assert.ok(worstPos <= POS_BOUND, `day ${day}: worst position ${worstPos} m`);
    assert.ok(worstVel <= VEL_BOUND, `day ${day}: worst velocity ${worstVel} m/s`);
    assert.equal(notServed, 0, `day ${day}: ${notServed} points of objects the population expects served were not served`);
    for (let i = 0; i < f.count; i++) if (SERVED_KINDS.has(POP[i].kind)) assert.equal(wasServed[i], 86400, `object ${i} (${POP[i].kind}) served at every second`);
    console.log(`bound day ${day}: ${scanned} served points, worst ${worstPos.toExponential(2)} m, ${worstVel.toExponential(2)} m/s`);
  }
  const st = f.stats();
  assert.equal(st[STAT.builderFailed] + st[STAT.apRefused], 2, "only the two decaying sets are marked not served");
}

// ---------------------------------------------------------------------------------------------------------------- purity
{
  const live = POP.filter((o) => o.kind !== "decay");  // the decaying sets are marked by what was asked first: their flight is not the subject here
  const a = await openFrames(), b = await openFrames();
  await a.load(live); await b.load(live);
  // the existing exports, asked before any cell exists
  const before = [];
  const times = [0.3, 1.7, 5.2].map((d) => EPOCH_MS + d * DAY);
  for (const t of times) before.push(a.epochsAt(t), a.epochsAt(t, 3));
  const beforeSet = times.map((t) => live.map((_, i) => a.ap(i, t)));
  const isoTimes = [0.4, 2.2, 5.1].map((d) => new Date(EPOCH_MS + d * DAY).toISOString().replace("Z", ""));
  const propBefore = await a.propagateEpochs(live.slice(0, 6), isoTimes);
  assert.ok(propBefore.length > 0);
  assert.equal(a.open(BUDGET), 0);
  assert.equal(b.open(BUDGET), 0);
  const all = Array.from({ length: live.length }, (_, i) => i);
  for (const day of [0, 5]) {
    const base = EPOCH_MS + day * DAY;
    // a: the clock moves forward a minute at a time, objects in index order; b: three minutes at a time, objects in reverse priority, after a jump away and back
    for (let m = 0; m <= 120; m++) a.refill(base + m * 60000, 180, 1 << 30, all);
    b.refill(base + 3 * DAY, 180, 1 << 30, all.slice().reverse());
    for (let m = 0; m <= 120; m += 3) b.refill(base + m * 60000, 180, 1 << 30, all.slice().reverse());
    for (const m of [30, 61, 90.5]) {
      const t = base + m * 60000;
      a.refill(t, 180); b.refill(t, 180);
      const qa = a.at(t), qb = b.at(t);
      for (let i = 0; i < live.length; i++) {
        assert.equal(qa.status[i], qb.status[i], `status ${i}`);
        if (qa.status[i] !== STATUS.served) continue;
        for (let c = 0; c < 6; c++) assert.ok(Object.is(qa.planes[c * live.length + i], qb.planes[c * live.length + i]), `bits of object ${i} component ${c} at day ${day} minute ${m}`);
      }
    }
  }
  // the existing exports after the refills: not one bit differs
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
  assert.ok((await a.propagateEpochs(live.slice(0, 6), isoTimes)).equals(propBefore), "propagate_epochs changed after a refill");
  console.log("purity: two fill orders return the same bits; sdnap_epochs_at, sdnap_epochs_set_at and propagate_epochs unchanged by refills");
}

// ---------------------------------------------------------------------------------------------------------------- statuses
{
  const f = await openFrames();
  await f.load(POP);
  assert.equal(f.at(EPOCH_MS).rc, CODE.notOpen);
  assert.equal(f.open(1000), CODE.budgetTooSmall);
  const needed = f.stats()[STAT.needed];
  assert.ok(needed > 1000, `the budget needed is stated (${needed} B)`);
  assert.equal(f.open(needed), 0, "open at exactly the bytes it stated it needed");
  f.close();
  assert.equal(f.open(BUDGET), 0);
  const t = EPOCH_MS + 3600e3;
  // no segment before a refill; not served by this entry where it never serves
  let q = f.at(t);
  POP.forEach((o, i) => assert.equal(q.status[i], o.kind === "wide" ? STATUS.notServedHere : STATUS.noSegment, `before a refill: ${o.kind}`));
  assert.ok(q.planes.every((v) => Number.isNaN(v)), "the planes of an unserved object are NaN");
  // a budget of rows and a priority list: one row builds the object the host named first
  const due = f.refill(t, 0, 1, [4]);
  assert.equal(due, f.stats()[STAT.eligible] - 1);
  q = f.at(t);
  assert.equal(q.status[4], STATUS.served);
  assert.equal(q.status.filter((s) => s === STATUS.served).length, 1);
  assert.equal(f.refill(t, 0), 0);
  q = f.at(t);
  POP.forEach((o, i) => { if (o.kind !== "wide" && o.kind !== "decay") assert.equal(q.status[i], STATUS.served, `${o.kind} ${i} served after a refill`); });
  // the Earth-fixed frame is AP's, rotated by the same function the epoch store uses
  const ecef = f.at(t, 0, f.count, 3), ref = f.epochsAt(t, 3);
  for (let i = 0; i < f.count; i++) if (ecef.status[i] === STATUS.served)
    for (let c = 0; c < 6; c++) assert.ok(Math.abs(ecef.planes[c * f.count + i] - ref.planes[c * f.count + i]) <= (c < 3 ? POS_BOUND : VEL_BOUND), `ECEF ${i} ${c}`);
  // a load replaces the store: every cell is dropped
  await f.load(POP);
  q = f.at(t);
  assert.equal(q.rc, CODE.storeChanged);
  assert.ok(q.status.every((s) => s === STATUS.noSegment));
  assert.equal(f.stats()[STAT.current], 0);
  assert.ok(f.refill(t, 0) === 0);
  assert.equal(f.stats()[STAT.current], 1);
  assert.equal(f.at(t).status[0], STATUS.served);
  assert.equal(f.stats()[STAT.cells] > 0, true);
  // a slab with room for the minimum only: rows are refused and counted, the objects stay "no segment"
  const small = await openFrames();
  await small.load(POP);
  assert.equal(small.open(1000), CODE.budgetTooSmall);
  assert.equal(small.open(small.stats()[STAT.needed]), 0);
  const left = small.refill(t, 0);
  assert.ok(left > 0 && small.stats()[STAT.full] > 0, "a full slab is counted, never silent");
  assert.ok(small.at(t).status.some((s) => s === STATUS.noSegment));
  // decay: a set that AP refuses beyond its crossing; seen first at day 8 so no earlier build marks it
  const d = await openFrames();
  const dp = population([["decay", 2]]);
  await d.load(dp);
  assert.equal(d.open(BUDGET), 0);
  d.refill(EPOCH_MS + 8 * DAY, 0);
  assert.ok(d.at(EPOCH_MS + 8 * DAY).status.every((s) => s === STATUS.apRefuses), "AP refuses the decayed set: its own status");
  assert.deepEqual([d.stats()[STAT.apRefused], d.stats()[STAT.builderFailed]], [2, 0]);
  // a stock (non-AP) set is not served by this entry
  const s = await openFrames();
  await s.load(null, [ocmStock(dp[0])]);
  assert.equal(s.open(BUDGET), 0);
  assert.equal(s.at(t).status[0], STATUS.notServedHere);
  // position only: the velocity planes are the position polynomial's derivative (checked against a difference of positions)
  const p = await openFrames();
  await p.load(POP.filter((o) => o.kind === "leo500"));
  assert.equal(p.open(BUDGET, 1), 0);
  p.refill(t, 0);
  const h = 0.25, plus = p.at(t + h * 1000), minus = p.at(t - h * 1000), mid = p.at(t);
  for (let i = 0; i < p.count; i++) for (let c = 0; c < 3; c++) {
    const diff = ((plus.planes[c * p.count + i] - minus.planes[c * p.count + i]) * 1000) / (2 * h);
    assert.ok(Math.abs(diff - mid.planes[(3 + c) * p.count + i] * 1000) < 1e-3, `derivative ${i} ${c}: ${diff} against ${mid.planes[(3 + c) * p.count + i] * 1000}`);
  }
  console.log("statuses: no segment, served, not served by this entry, AP refuses, load drops cells, budget refused by name, full slab counted, position-only, ECEF");
}
import { seedOcm } from "./lib/ocm.mjs";
import { revPerDay, EPOCH } from "./lib/frame-cells.mjs";
function ocmStock(o) { return seedOcm({ epoch: EPOCH, n: revPerDay(o.a), e: o.e, i: o.inc, raan: o.raan, argp: o.argp, ma: o.ma, bterm: 0.01, agom: 0.01, norad: o.norad }); }

// ---------------------------------------------------------------------------------------------------------------- the builder fails
{
  const wasm = buildDiagnostic("frames-tolerance", "", (s) => s, { "frames.inc": (s) => s.replace("constexpr double kTolPos = 5.0e-6;", "constexpr double kTolPos = 1.0e-15;") });
  const f = await openFrames({ wasm });
  await f.load(POP.filter((o) => o.kind === "leo500"));
  assert.equal(f.open(BUDGET), 0);
  f.refill(EPOCH_MS + 3600e3, 0);
  const q = f.at(EPOCH_MS + 3600e3);
  assert.ok(q.status.every((s) => s === STATUS.builderFails), "a tolerance no window of 3 minutes holds: the builder's own status");
  assert.deepEqual([f.stats()[STAT.apRefused], f.stats()[STAT.builderFailed]], [0, f.count]);
  console.log("builder fails: its own status, counted apart from AP's refusals");
}

// ---------------------------------------------------------------------------------------------------------------- allocation failures
{
  const wasm = buildDiagnostic("frames-failure", failureProbe, (s) => s, failureSeam);
  const pop = POP.filter((o) => o.kind === "leo500" || o.kind === "geo").slice(0, 3);
  const run = async (failAt, steps) => {
    const f = await openFrames({ wasm });
    await f.load(pop);
    return f;
  };
  // open: count its counted allocations, then fail each in turn
  const probe = await run();
  probe.x.sdnap_test_fail_at(0);
  assert.equal(probe.open(BUDGET), 0);
  const openCount = probe.x.sdnap_test_alloc_count();
  assert.ok(openCount >= 1, "open makes a counted allocation");
  for (let k = 1; k <= openCount; k++) {
    const f = await run();
    f.x.sdnap_test_fail_at(k);
    assert.equal(f.open(BUDGET), CODE.outOfMemory, `open with allocation ${k} refused`);
    assert.ok(f.stats()[STAT.needed] > 0, "the bytes asked are stated");
    assert.equal(f.at(EPOCH_MS).rc, CODE.notOpen);
    f.x.sdnap_test_fail_at(0);
    assert.equal(f.open(BUDGET), 0, "open then succeeds");
  }
  // a refill row: the clean answer first
  const t = EPOCH_MS + 2 * DAY + 600e3;
  const clean = await run();
  assert.equal(clean.open(BUDGET), 0);
  clean.x.sdnap_test_fail_at(0);
  assert.equal(clean.refill(t, 0, 1, [0], 1 << 30), pop.length - 1);  // armed at a count that is never reached: counts the row's allocations
  const rowCount = clean.x.sdnap_test_alloc_count();
  assert.ok(rowCount >= 2, `a refill row makes counted allocations (${rowCount})`);
  assert.equal(clean.refill(t, 0), 0);
  const want = clean.at(t);
  for (let k = 1; k <= rowCount; k++) {
    const f = await run();
    assert.equal(f.open(BUDGET), 0);
    f.refill(t, 0, 1, [0], k);
    assert.equal(f.stats()[STAT.rowsOom], 1, `allocation ${k} of a row: refused and counted`);
    assert.equal(f.at(t).status[0], STATUS.noSegment, `allocation ${k}: the object keeps no cell`);
    assert.equal(f.stats()[STAT.cells], 0);
    f.x.sdnap_test_fail_at(0);
    assert.equal(f.refill(t, 0), 0);
    const got = f.at(t);
    for (let q = 0; q < want.planes.length; q++) assert.ok(Object.is(got.planes[q], want.planes[q]), `allocation ${k}: the refill after it returns the clean run's bits`);
  }
  console.log(`allocation failures: ${openCount} of open and ${rowCount} of a row failed in turn`);
}
console.log("FRAMES PASS");

#!/usr/bin/env node
// SPEC 19, the frames: Chebyshev cells of AP's own states, served by sdnap_frames_*. Each assertion states one outcome (and counts, so that a run in which
// nothing is served cannot pass):
//  - the bound: for a seeded population of 34 objects across the regime (30 served kinds, 2 wide, 2 sets AP refuses; inclinations 0.3 to 140 degrees, eccentricity
//    to 0.05, resonance-class sets to 0.2, epochs spread over a day, strong drag at 250 to 560 km and BTERM 0.01 to 1, decaying sets, weather rows that start a day
//    before the epoch), every served state is within 1 cm (3-D) and 1e-4 m/s (3-D) of AP's state for that record and time asked of a fresh instance, in every
//    class, strong drag and decay included. The scan runs every second over a day at 0 and 5 days from the epoch and every 17 s over a day at -1, 2 and 10 days;
//    the fresh asks are made at every 61st served second (every 5th sample at the other days), the count is printed; a window that cannot meet the bound is a
//    tombstone; the edges of windows and the epoch instant are checked;
//  - a status depends on the record and the time alone: AP's refusal before the epoch does not reach the times after it; refused and failing windows are tombstones;
//  - purity: two instances that fill their cells in different orders, with different cadences and a jump of the clock, return the same bits and statuses; an
//    instance that asks the epoch store between its refills returns the cells of a clean instance, within 1 cm of the store's first asks;
//    sdnap_epochs_at (TEME and Earth-fixed), sdnap_epochs_set_at (every set) and propagate_epochs are not changed by refills, in a threaded instance whose
//    sdnap_epochs_at batches run on pool threads;
//  - what the entry does not serve (wide, several sets, a forecast, a hand-over, a stock set) answers "not served by this entry" after a refill;
//  - the slab: refused open by name and a refused open leaves the earlier frames standing; a slab filled to the figure of its own run survives turns of windows
//    whose cells change size (compaction) with the states of its cells equal to the unconstrained run's; a refill sliced at 8 rows stores the bits of one at 5,000
//    and visits each object once; a clock that advances at every call, and one that advances 20 s a call across 3-minute windows, serve every object; a changed
//    priority list restarts the sweep; no frame between calls finds an object without the cell it had;
//  - position-only mode writes three planes and halves like the full mode; a set whose initialization refuses (a test build) answers 3 once an object and does not
//    stall a refill; every counted allocation of open and of a refill row failed in turn.
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
const PLAN = [["leo500", 3], ["leo830", 2], ["leo1400", 2], ["drag300", 3], ["drag250", 1], ["hp490", 1], ["hp520b01", 1], ["hp560b1", 1], ["ecc", 2], ["ecc05", 1], ["meo", 2], ["geo", 1],
  ["eqgeo", 1], ["crit", 1], ["polar", 1], ["retro", 1], ["geoE10", 1], ["res2E20", 1], ["res3E10", 1], ["shortrows", 1], ["wide", 2], ["decay", 2], ["underground", 2]];
const POP = population(PLAN, 20261113, 1440);
assert.equal(POP.length, 34);
const BUDGET = 8e6;
const POS_BOUND = 0.01, VEL_BOUND = 1e-4;  // m (3-D), m/s (3-D)
const iso = (ms) => new Date(ms).toISOString().replace("Z", "");
const finish = (name, t0) => console.log(`${name}: ${((Date.now() - t0) / 1000).toFixed(0)} s`);
const dist3 = (a, b, o, n, i) => Math.hypot(a[o] - b[o * n + i], a[o + 1] - b[(o + 1) * n + i], a[o + 2] - b[(o + 2) * n + i]);  // km or km/s, ap array against a plane array
const T_START = Date.now();

// ---------------------------------------------------------------------------------------------------------------- the bound
{
  const t0 = Date.now();
  const f = await openFrames();
  await f.load(POP);
  assert.equal(f.count, POP.length);
  assert.equal(f.open(BUDGET), 0);
  const kindOf = POP.map((o) => o.kind);
  const strict = new Set(["leo500", "leo830", "leo1400", "ecc", "ecc05", "meo", "geo", "eqgeo", "crit", "polar", "retro", "geoE10", "res2E20", "res3E10"]);
  const drag = new Set(["drag300", "drag250"]);
  let totalServed = 0, worstAll = 0, worstVelAll = 0, coldChecked = 0;
  const worstByKind = {}, tombstonePoints = {}, warmWorst = {}, shareKind = {};
  const denseKinds = new Set(["drag300", "drag250", "decay", "hp490", "hp520b01", "hp560b1"]);  // the sets whose output steps: the dense check (SPEC 19.5)
  const cold = await openFrames();
  for (const [day, stride] of [[0, 1], [5, 1], [-1, 17], [2, 17], [10, 17]]) {
    const coldEvery = stride === 1 ? 61 : 5;
    const t0s = EPOCH_MS + day * DAY + 5000;
    const served = new Array(f.count).fill(0), asked = new Array(f.count).fill(0), refused = new Array(f.count).fill(0);
    for (let s = 0; s < 86400; s += stride) {
      const t = t0s + s * 1000;
      if (s % 60 < stride) f.refill(t, 180);
      const q = f.at(t);
      assert.equal(q.rc, 0);
      const isColdInstant = (s / stride) % coldEvery === 0;
      if (isColdInstant) await cold.load(POP);  // a fresh store: each set's first ask is at this instant
      for (let i = 0; i < f.count; i++) {
        const kind = kindOf[i];
        asked[i]++;
        if (kind === "wide") { assert.equal(q.status[i], STATUS.notServedHere, `wide object ${i} at ${s} s`); continue; }
        if (kind === "underground") { assert.equal(q.status[i], STATUS.apRefuses, `a set AP refuses answers 3 at every time (object ${i})`); assert.equal(f.ap(i, t), null); refused[i]++; continue; }
        if (q.status[i] === STATUS.served) {
          served[i]++;
          const a = f.ap(i, t);
          assert.ok(a, `AP refuses where a frame is served: ${kind} ${i} at day ${day} + ${s} s`);
          const dp = dist3(a, q.planes, 0, f.count, i) * 1000, dv = dist3(a, q.planes, 3, f.count, i) * 1000;
          // the asserted reference, for every kind: AP's state for the record and the time asked of a fresh instance (every set's first ask), at the instants of the
          // scan that are a multiple of `coldEvery` seconds; the comparison with the same instance asked every second is asserted for the kinds without dense
          // checks and printed for the others
          if (!denseKinds.has(kind)) {
            assert.ok(dp <= POS_BOUND, `${kind} ${i} at day ${day} + ${s} s: ${dp} m from the instance asked every second (3-D)`);
            assert.ok(dv <= VEL_BOUND, `${kind} ${i} at day ${day} + ${s} s: ${dv} m/s from the instance asked every second (3-D)`);
          } else warmWorst[kind] = Math.max(warmWorst[kind] ?? 0, dp);
          if (isColdInstant) {
            const c = cold.ap(i, t);
            assert.ok(c, `AP asked of a fresh instance refuses where a frame is served: ${kind} ${i}`);
            const cp = dist3(c, q.planes, 0, f.count, i) * 1000, cv = dist3(c, q.planes, 3, f.count, i) * 1000;
            assert.ok(cp <= POS_BOUND, `${kind} ${i} at day ${day} + ${s} s: ${cp} m from AP asked of a fresh instance (3-D)`);
            assert.ok(cv <= VEL_BOUND, `${kind} ${i} at day ${day} + ${s} s: ${cv} m/s from AP asked of a fresh instance (3-D)`);
            worstByKind[kind] = Math.max(worstByKind[kind] ?? 0, cp);
            worstAll = Math.max(worstAll, cp); worstVelAll = Math.max(worstVelAll, cv);
            coldChecked++;
          }
        } else {
          assert.ok([STATUS.apRefuses, STATUS.builderFails].includes(q.status[i]), `object ${i} (${kind}) at day ${day} + ${s} s answered status ${q.status[i]}: after a refill every time is served or a tombstone`);
          refused[i]++;
          tombstonePoints[kind] = (tombstonePoints[kind] ?? 0) + 1;
          if (q.status[i] === STATUS.apRefuses) {  // AP refuses somewhere in the 3-minute window that holds the time (SPEC 19.1)
            let refuses = false;
            for (let k = -18; k <= 18 && !refuses; k++) refuses = f.ap(i, t + k * 10000) === null;
            assert.ok(refuses, `status 3 for ${kind} ${i} at day ${day} + ${s} s, and AP serves every second within 3 minutes of it`);
          }
        }
      }
    }
    for (let i = 0; i < f.count; i++) { shareKind[kindOf[i]] ??= [0, 0]; shareKind[kindOf[i]][0] += served[i]; shareKind[kindOf[i]][1] += asked[i]; }
    for (let i = 0; i < f.count; i++) {
      const kind = kindOf[i];
      if (strict.has(kind)) assert.equal(served[i], asked[i], `object ${i} (${kind}) served at every scanned time of day ${day}`);
      if (denseKinds.has(kind) && kind !== "decay" && day <= 5) assert.ok(served[i] >= 0.9 * asked[i], `object ${i} (${kind}) served at ${served[i]} of ${asked[i]} times of day ${day}`);
      // the set with short rows: AP serves it from the midnight that begins the rows' coverage; the 3-minute window that holds that midnight is a tombstone (SPEC 19.3)
      if (kind === "shortrows") assert.ok(day >= 0 ? served[i] >= asked[i] - Math.ceil(180 / stride) : served[i] === 0, `the set with short rows is served from its first covered midnight on and refused before it (day ${day}: ${served[i]} of ${asked[i]})`);
      totalServed += served[i];
    }
    const nServedObjects = served.filter((v) => v > 0).length;
    assert.ok(nServedObjects >= 24, `${nServedObjects} objects served on day ${day}`);
    console.log(`bound day ${day}: ${served.reduce((a, b) => a + b, 0)} served points`);
  }
  assert.ok(totalServed > 1.5e6, `${totalServed} served points in all`);
  const st = f.stats();
  assert.ok(st[STAT.apTombstones] > 0, "the decaying sets leave AP-refusal tombstones");
  assert.ok(coldChecked > 20000, `${coldChecked} served states compared with AP asked of a fresh instance`);
  console.log(`share of the scanned times served: ${JSON.stringify(Object.fromEntries(["drag300", "drag250", "decay", "hp490", "hp520b01", "hp560b1", "leo500", "ecc", "shortrows"].map((k) => [k, +(shareKind[k][0] / shareKind[k][1]).toFixed(4)])))}`);
  console.log(`asserted: ${coldChecked} served states against AP asked of a fresh instance (every kind), and every served second of the sets without dense checks against the instance asked every second; printed: the sets with dense checks against the instance asked every second, worst ${JSON.stringify(Object.fromEntries(Object.entries(warmWorst).map(([k, v]) => [k, +(v).toExponential(2)])))} m`);
  console.log(`worst 3-D position ${(worstAll).toExponential(2)} m, velocity ${worstVelAll.toExponential(2)} m/s; by kind ${JSON.stringify(Object.fromEntries(Object.entries(worstByKind).map(([k, v]) => [k, +v.toExponential(2)])))}; points answered by a tombstone ${JSON.stringify(tombstonePoints)}`);
  finish("bound", t0);
}

// ---------------------------------------------------------------------------------------------------------------- the epoch instant and the edges of windows
{
  const t0 = Date.now();
  const pop = population([["leo500", 2], ["drag300", 2], ["meo", 1], ["geo", 1]], 3, 0);
  const MINUTE = 60000, GAP = 1e-6 * MINUTE;  // the last instant a window is checked at is a minute-millionth before its end (src/frames.inc kEndGap)
  const cold = await openFrames();
  const run = async (wasm, edges, label0) => {
    const f = await openFrames({ wasm });
    await f.load(pop);
    assert.equal(f.open(BUDGET), 0);
    let worst = 0, checked = 0;
    for (const [ms, label] of edges) {
      f.fill(EPOCH_MS + ms, 0);
      const q = f.at(EPOCH_MS + ms);
      await cold.load(pop);
      for (let i = 0; i < f.count; i++) {
        assert.equal(q.status[i], STATUS.served, `${label0} ${label}: object ${i}`);
        const d = dist3(cold.ap(i, EPOCH_MS + ms), q.planes, 0, f.count, i) * 1000;
        assert.ok(d <= POS_BOUND, `${label0} ${label}: object ${i} ${d} m from AP asked of a fresh instance`);
        worst = Math.max(worst, d); checked++;
      }
    }
    return { worst, checked, f };
  };
  // 48-minute windows: the epoch (t = 0 exactly), the last instant of the first and second windows, the first instant of the second, just before the epoch
  const w48 = await run(undefined, [[0, "the epoch"], [48 * MINUTE - GAP, "the end of the first window"], [48 * MINUTE, "the start of the second"], [96 * MINUTE - GAP, "the end of the second"],
    [-GAP, "the end of the window before the epoch"], [-48 * MINUTE, "the start of the window before the epoch"]], "48-minute windows:");
  // 3-minute windows (a test build whose base window is 3 minutes: no window is halved, every edge is the edge of a 3-minute window)
  const wasm3 = buildDiagnostic("frames-base3", "", (s) => s, { "frames.inc": (s) => s.replace("constexpr double kBaseMinutes = 48.0;", "constexpr double kBaseMinutes = 3.0;") });
  const w3 = await run(wasm3, [[0, "the epoch"], [3 * MINUTE - GAP, "the end of the first window"], [3 * MINUTE, "the start of the second"], [6 * MINUTE - GAP, "the end of the second"], [-3 * MINUTE, "the start of the window before the epoch"]], "3-minute windows:");
  assert.equal(w3.f.stats()[STAT.split], 0, "in the test build no window is halved: every edge asked is the edge of a 3-minute window");
  assert.ok(w48.checked >= 36 && w3.checked >= 30);
  console.log(`edges: ${w48.checked + w3.checked} states at the epoch and at the edges of 48-minute and 3-minute windows, worst ${Math.max(w48.worst, w3.worst).toExponential(2)} m against AP asked of a fresh instance`);
  finish("edges", t0);
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
  // every time from the epoch on is served where AP serves it
  let servedAfter = 0;
  for (let m = 0; m < 600; m += 7) {
    const t = epoch + m * 60000;
    a.fill(t, 180);
    const s = a.at(t).status[0];
    assert.equal(s, STATUS.served, `shortrows at ${m} min after the epoch`);
    servedAfter++;
  }
  assert.ok(servedAfter > 80);
  // a time before the epoch that AP serves is served
  const near = epoch - 12 * 3600e3;
  a.fill(near, 180);
  const qn = a.at(near);
  assert.equal(qn.status[1], STATUS.served, "a time before the epoch is served like one after it");
  assert.ok(dist3(a.ap(1, near), qn.planes, 0, 2, 1) * 1000 <= POS_BOUND);
  // a tombstone is not rebuilt: a second sweep builds nothing
  a.fill(back, 180);
  const again = a.refill(back, 181);
  assert.equal(again.stored + again.tombstones, 0);
  assert.equal(a.at(back).status[0], STATUS.apRefuses);
  finish("status by record and time", t0);
}

// ---------------------------------------------------------------------------------------------------------------- a window that ends at a coverage cliff
{
  const t0 = Date.now();
  const f = await openFrames();
  const pop = population([["leo500", 1]], 8, 0);  // the epoch is a UTC midnight: every 48-minute window ends on one when it is a multiple of 30
  await f.load(pop);
  assert.equal(f.open(BUDGET), 0);
  // the first midnight after which AP refuses: the end of the weather rows
  let cliff = 0;
  for (let d = 40; d < 70 && !cliff; d++) { const m = EPOCH_MS + d * DAY; if (f.ap(0, m - 1000) !== null && f.ap(0, m + 1000) === null) cliff = m; }
  assert.ok(cliff > 0, "the weather rows end at a midnight");
  for (const lead of [90 * 1000, 60 * 1000, 20 * 1000]) {
    f.fill(cliff - lead, 0);
    const q = f.at(cliff - lead);
    assert.equal(q.status[0], STATUS.served, `${lead / 1000} s before the end of the rows`);
    assert.ok(dist3(f.ap(0, cliff - lead), q.planes, 0, 1, 0) * 1000 <= POS_BOUND);
  }
  // epochs at random offsets: the window that holds the cliff is not aligned to it. Just after it AP refuses and the frame says 3; four minutes before it the frame
  // is served; the leaf that holds the cliff answers 3 or served and, where it answers 3, AP refuses within 3 minutes
  const spread = population([["leo500", 6]], 18, 1440);
  const g = await openFrames();
  await g.load(spread);
  assert.equal(g.open(BUDGET), 0);
  for (let i = 0; i < g.count; i++) {
    let m = 0;
    for (let d = 40; d < 70 && !m; d++) { const mm = EPOCH_MS + d * DAY; if (g.ap(i, mm - 1000) !== null && g.ap(i, mm + 1000) === null) m = mm; }
    assert.ok(m > 0);
    for (const [lead, expect] of [[4 * 60000, [0]], [1000, [0, 3]], [-1000, [3]], [-60000, [3]]]) {
      g.fill(m - lead, 0);
      const s = g.at(m - lead).status[i];
      assert.ok(expect.includes(s), `object ${i}, ${lead / 1000} s before the end of the rows: status ${s}`);
      if (s === 3) assert.equal(g.ap(i, m - lead + (lead > 0 ? 180000 : 0)), null, "AP refuses within 3 minutes after a status 3");
    }
  }
  finish("coverage cliff", t0);
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
  assert.equal(f.stats()[STAT.eligible], 2, "only the two plain AP sets can be served");
  const t = EPOCH_MS + 0.5 * DAY;
  const r = f.fill(t, 180);
  assert.equal(r.due, 0);
  const q = f.at(t);
  assert.deepEqual(Array.from(q.status), [STATUS.served, STATUS.served, 2, 2, 2, 2, 2], "wide, two sets, stock, hand-over and forecast answer 'not served by this entry'");
  assert.ok(Array.from(q.planes).slice(0, 2).every(Number.isFinite));
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
  for (const t of times) before.push(a.epochsAt(t), a.epochsAt(t, 3));  // the store's first pass runs on the pool: batches of its series
  { const p = a.poolStats(); assert.equal(p[0], 4, "four pool threads"); assert.ok(p[1] > 0 && p[14] > 0 && p[15] >= 1, `sdnap_epochs_at rows ran on pool threads: ${p[1]} batches, ${p[14]} rows on ${p[15]} pool threads`); }
  const beforeSet = times.map((t) => live.map((_, i) => a.ap(i, t)));
  const isoTimes = times.map(iso);
  const propBefore = await a.propagateEpochs(live.slice(0, 6).map((o) => ocmOfObject(o)), isoTimes);
  assert.equal(a.open(BUDGET), 0);
  assert.equal(b.open(BUDGET), 0);
  const all = Array.from({ length: live.length }, (_, i) => i);
  let compared = 0;
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
        if (qa.status[i] !== STATUS.served) continue;
        for (let c = 0; c < 6; c++) assert.ok(Object.is(qa.planes[c * live.length + i], qb.planes[c * live.length + i]), `bits of object ${i} component ${c} at day ${day} minute ${m}`);
        compared++;
      }
    }
  }
  assert.ok(compared >= 9 * 40, `${compared} served states compared`);
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
  console.log(`purity: ${compared} served states from two fill orders identical; epochs_at (TEME, Earth-fixed), set_at and propagate_epochs unchanged, the instance with 4 pool threads that ran the batches of sdnap_epochs_at`);
  finish("purity", t0);
}

// ---------------------------------------------------------------------------------------------------------------- cells against AP's own history dependence
{
  const t0 = Date.now();
  // Instance `a` asks the store between its refills, at other times, earlier ones after later ones; instance `c` never asks. Their cells are compared bit for bit,
  // and the cells of `a` are compared with the store's first asks of `a` (taken before any other ask) at the instants of those asks, for every object.
  const live = population([["leo500", 20], ["leo830", 10], ["drag300", 6], ["meo", 4], ["geo", 4], ["ecc", 4], ["decay", 2]], 99, 1440);
  const a = await openFrames({ threads: 4 }), c = await openFrames();
  await a.load(live); await c.load(live);
  assert.equal(a.open(BUDGET), 0); assert.equal(c.open(BUDGET), 0);
  const first = [0.3, 1.7, 5.2].map((d) => EPOCH_MS + d * DAY);
  const early = first.map((t) => a.epochsAt(t));
  // the asks that move AP's own medium-orbit states: the store at other times, earlier ones after later ones
  const trigger = () => { for (const day of [0, 5, -1]) for (const m of [30, 61, 90.5]) a.epochsAt(EPOCH_MS + day * DAY + 3600e3 + m * 60000); };  // asks at other times
  let compared = 0;
  for (const day of [0, 2, 5]) {
    const base = EPOCH_MS + day * DAY + 3600e3;
    for (let m = 0; m <= 90; m += 6) {
      const t = base + m * 60000;
      a.refill(t, 180); c.refill(t, 180);
      trigger();
    }
    const t = base + 45 * 60000;
    a.fill(t, 180); c.fill(t, 180);
    const qa = a.at(t), qc = c.at(t);
    assert.deepEqual(Array.from(qa.status), Array.from(qc.status));
    for (let i = 0; i < live.length; i++) {
      if (qa.status[i] !== STATUS.served) continue;
      for (let k = 0; k < 6; k++) assert.ok(Object.is(qa.planes[k * live.length + i], qc.planes[k * live.length + i]), `cell of object ${i} component ${k} differs after the store was asked in the order that moves AP's states`);
      compared++;
    }
  }
  assert.ok(compared >= 3 * 40);
  // every object's cell at each of the first instants against the store's first ask there (a fresh instance's ask, before any other)
  let againstFirst = 0;
  first.forEach((t, k) => {
    a.fill(t, 180);
    const q = a.at(t);
    for (let i = 0; i < live.length; i++) {
      if (q.status[i] !== STATUS.served) continue;
      const d = Math.hypot(early[k].planes[i] - q.planes[i], early[k].planes[live.length + i] - q.planes[live.length + i], early[k].planes[2 * live.length + i] - q.planes[2 * live.length + i]) * 1000;
      assert.ok(d <= POS_BOUND, `cell of object ${i} (${live[i].kind}) at first instant ${k}: ${d} m from the store's first ask`);
      againstFirst++;
    }
  });
  assert.ok(againstFirst >= 3 * 30, `${againstFirst} cells compared with the store's first asks`);
  console.log(`cells: ${compared} served states identical to a clean instance's; ${againstFirst} within 1 cm of the store's first asks`);
  finish("cells against AP history dependence", t0);
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
  assert.equal(f.refill(NaN).rc, CODE.badArgument);
  assert.equal(f.refill(EPOCH_MS, Infinity).rc, CODE.badArgument);
  assert.equal(f.refill(EPOCH_MS, -1).rc, CODE.badArgument);
  assert.equal(f.refill(EPOCH_MS, 180, 0).rc, CODE.badArgument, "max_rows under 1");
  assert.equal(f.refill(EPOCH_MS, 180, 5, Array(f.count + 1).fill(0)).rc, CODE.badArgument, "more priority entries than objects");
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
  const first = f.refill(t, 0, 1, [4, 29]);  // one row, the object the host named first
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
  assert.ok(nServed >= POP.length - 8, `${nServed} objects served after a full fill`);
  assert.equal(q.status.filter((s) => s === STATUS.apRefuses).length >= 2, true, "the sets AP refuses answer 3");
  // the Earth-fixed frame is AP's, rotated by the same function the epoch store uses
  const ecef = f.at(t, 0, f.count, 3), ref = f.epochsAt(t, 3);
  let ecefChecked = 0;
  for (let i = 0; i < f.count; i++) if (ecef.status[i] === STATUS.served) {
    ecefChecked++;
    const d3 = (o) => Math.hypot(ecef.planes[o * f.count + i] - ref.planes[o * f.count + i], ecef.planes[(o + 1) * f.count + i] - ref.planes[(o + 1) * f.count + i], ecef.planes[(o + 2) * f.count + i] - ref.planes[(o + 2) * f.count + i]);
    assert.ok(d3(0) <= POS_BOUND, `ECEF position ${i}: ${d3(0)} m`);
    assert.ok(d3(3) <= VEL_BOUND, `ECEF velocity ${i}: ${d3(3)} m/s (all six planes are compared)`);
  }
  assert.equal(ecefChecked, nServed);
  // `ahead` is clamped to one window: a day ahead stores at most two cells an object
  const g = await openFrames();
  await g.load(POP);
  assert.equal(g.open(BUDGET), 0);
  g.fill(t, 86400);
  assert.ok(g.stats()[STAT.cells] <= 2 * POP.length);
  // two clocks more than a window apart on one instance take the same two slots: each alternation rebuilds
  const h = await openFrames();
  await h.load(population([["leo500", 10]], 9, 0));
  assert.equal(h.open(BUDGET), 0);
  h.fill(t, 180);
  let rebuilt = 0;
  for (let k = 0; k < 4; k++) { rebuilt += h.fill(t + (k % 2 ? 0 : 3 * DAY), 180).stored > 0 ? 1 : 0; }
  assert.ok(rebuilt >= 3, "two clocks a window apart rebuild at every alternation: frames serve one clock and its look-ahead to an instance");
  // A catalog reload releases the frame allocation; the host opens a fresh budget for the new catalog.
  await f.load(POP);
  q = f.at(t);
  assert.equal(q.rc, CODE.notOpen);
  assert.equal(f.open(BUDGET), 0);
  assert.equal(f.fill(t, 180).due, 0);
  assert.equal(f.stats()[STAT.current], 1);
  assert.equal(f.at(t).status[0], STATUS.served);
  await f.load(population([["leo500", 100]]));  // A larger catalog also releases the frame allocation.
  assert.equal(f.refill(t).rc, CODE.notOpen);
  // a slab with room for one largest cell only: rows are refused and counted, each skipped and reported, the later objects still visited; the objects stay "no segment"
  const small = await openFrames();
  await small.load(POP);
  assert.equal(small.open(1000), CODE.budgetTooSmall);
  assert.equal(small.open(small.stats()[STAT.needed]), 0);
  const left = small.refill(t, 0);
  assert.ok(left.unstored > 1, `${left.unstored} rows that could not be stored: each is skipped and the later objects are still visited`);
  assert.equal(left.left[0] + left.left[1], 0, "the sweep went through every object");
  assert.ok(left.stalled >= 0, "and names the last object it could not store");
  assert.ok(small.stats()[STAT.full] >= 1);
  assert.ok(small.at(t).status.some((s) => s === STATUS.noSegment));
  const again = small.refill(t, 0);
  assert.equal(again.stored + again.tombstones, 0, "and a call that stores nothing is the host's word to stop");
  assert.ok(small.fill(t, 0).calls <= 3, "the host's loop ends: no call retries what cannot be stored");
  // compaction: a slab sized to the figure of an unconstrained run survives turns of windows whose cells change size
  const popC = population([["leo500", 20], ["leo830", 20], ["meo", 10], ["geo", 10], ["ecc", 10], ["drag300", 10]], 5, 48);
  const run = async (budget) => {
    const hh = await openFrames();
    await hh.load(popC);
    assert.equal(hh.open(budget), 0);
    let maxLive = 0, full = 0, rows = 0;
    for (let m = 0; m <= 24 * 60; m += 3) {
      const r = hh.refill(EPOCH_MS + 3600e3 + m * 60000, 180);
      full += r.unstored; rows += r.stored + r.tombstones;
      maxLive = Math.max(maxLive, hh.stats()[STAT.cellBytes]);
    }
    return { h: hh, maxLive, full, rows };
  };
  const free = await run(8e6);
  assert.ok(free.rows > 600 && free.full === 0);
  const tight = Math.ceil(free.maxLive * 1.12) + popC.length * 32 + 64 + 3136 * 2;
  const tightRun = await run(tight);
  const st = tightRun.h.stats();
  assert.equal(tightRun.full, 0, `a slab of ${tight} B (the unconstrained run's largest live cells and 12 %) never refused a row`);
  assert.ok(st[STAT.compactions] > 0, "and it was compacted");
  assert.equal(tightRun.rows, free.rows, "the same rows");
  {  // the states of the compacted slab's cells are the unconstrained run's, bit for bit, and within the bound
    const tf = EPOCH_MS + 3600e3 + 24 * 60 * 60000;
    const qa = tightRun.h.at(tf), qb = free.h.at(tf);
    assert.deepEqual(Array.from(qa.status), Array.from(qb.status));
    const served = qa.status.filter((s) => s === STATUS.served).length;
    assert.ok(served >= popC.length - 2, `${served} served at the end of the compacted run`);
    for (let k = 0; k < qa.planes.length; k++) assert.ok(Object.is(qa.planes[k], qb.planes[k]), "the compacted slab serves the unconstrained run's bits");
    for (let i = 0; i < popC.length; i += 7) if (qa.status[i] === STATUS.served) assert.ok(dist3(tightRun.h.ap(i, tf), qa.planes, 0, popC.length, i) * 1000 <= POS_BOUND);
  }
  console.log(`compaction: ${st[STAT.compactions]} compactions, ${st[STAT.moved]} bytes moved, slab ${st[STAT.slab]} B, live cells ${free.maxLive} B`);
  // a slab that cannot hold what a compaction would free does not compact for nothing
  const noRoom = await openFrames();
  await noRoom.load(popC);
  assert.equal(noRoom.open(1), CODE.budgetTooSmall);
  assert.equal(noRoom.open(noRoom.stats()[STAT.needed] + 1), 0);
  noRoom.refill(EPOCH_MS + 3600e3, 180);
  assert.equal(noRoom.stats()[STAT.compactions], 0, "a slab full of live cells is not compacted");
  assert.ok(noRoom.stats()[STAT.full] > 0, "the minimum slab was full");
  // a sliced refill stores the bits of one big call, visiting each object once
  const popS = population([["leo500", 60], ["leo830", 40], ["meo", 20], ["geo", 20], ["ecc", 20], ["drag300", 20]], 6, 48);
  const sliced = async (maxRows) => {
    const hh = await openFrames();
    await hh.load(popS);
    assert.equal(hh.open(BUDGET * 2), 0);
    let calls = 0, r;
    do { r = hh.refill(t, 180, maxRows); calls++; } while (r.due > 0);
    return { h: hh, calls, st: hh.stats() };
  };
  const s8 = await sliced(8), sBig = await sliced(5000);
  assert.ok(s8.calls >= popS.length / 8 && sBig.calls <= 2);
  const qa = s8.h.at(t), qb = sBig.h.at(t);
  assert.deepEqual(Array.from(qa.status), Array.from(qb.status));
  assert.ok(qa.status.filter((s) => s === STATUS.served).length >= popS.length - 2, "the sliced fill serves the objects");
  for (let k = 0; k < qa.planes.length; k++) assert.ok(Object.is(qa.planes[k], qb.planes[k]), "sliced and unsliced fills store the same bits");
  assert.equal(s8.st[STAT.cells], sBig.st[STAT.cells]);
  assert.ok(s8.st[STAT.visits] <= 2 * popS.length + 2 * s8.calls, `${s8.st[STAT.visits]} visits for ${popS.length} objects in ${s8.calls} calls: one pass over the objects however it is sliced`);
  assert.ok(sBig.st[STAT.visits] <= 2 * popS.length + 2 * sBig.calls);
  // a display's calls: a new clock every call (16 ms on), 8 rows a call: every object is served within 2 N / 8 + a few calls
  {
    const d = await openFrames();
    await d.load(popS);
    assert.equal(d.open(BUDGET * 2), 0);
    let calls = 0, tt = t, r;
    do { r = d.refill(tt, 180, 8); tt += 16; calls++; } while (r.due > 0 && calls < 1000);
    assert.ok(calls <= (2 * popS.length) / 8 + 4, `${calls} calls with a new clock every call for ${popS.length} objects at 8 rows a call`);
    assert.ok(d.at(tt).status.filter((s) => s === STATUS.served).length >= popS.length - 2);
    // a place in the sweep is kept while only the clock advances: the visits stay linear (pass 0 runs once more when the clock advanced while it ran)
    assert.ok(d.stats()[STAT.visits] <= 3 * popS.length + 2 * calls + 4, `${d.stats()[STAT.visits]} visits`);
    // a changed priority list restarts the sweep: the objects the shorter list skipped are visited
    const p = await openFrames();
    await p.load(popS.slice(0, 40));
    assert.equal(p.open(BUDGET), 0);
    p.refill(t, 180, 4, [5, 6, 7]);
    const rest = p.fill(t, 180, 5000, []);
    assert.equal(rest.due, 0);
    assert.ok(p.at(t).status.every((s, i) => s === STATUS.served || [2, 3, 4].includes(s)), "every object is served or answers for itself after the list shrank mid-sweep");
    assert.equal(p.at(t).status.filter((s) => s === STATUS.served).length >= 38, true);
  }
  // a clock that advances 20 s a call across 3-minute windows (a test build whose base window is 3 minutes), 4 rows a call, a look-ahead of 170 s: every frame
  // asked between calls finds every object with a cell (served, or a tombstone) once the first fill is done, and a served object stays served
  {
    const wasm3 = buildDiagnostic("frames-base3", "", (s) => s, { "frames.inc": (s) => s.replace("constexpr double kBaseMinutes = 48.0;", "constexpr double kBaseMinutes = 3.0;") });
    const dd = await openFrames({ wasm: wasm3 });
    const pd = population([["drag300", 4], ["leo500", 8], ["geo", 4]], 77, 3);
    await dd.load(pd);
    assert.equal(dd.open(BUDGET), 0);
    let now = EPOCH_MS + 3600e3, lost = 0, checked = 0, tombstoned = 0;
    dd.fill(now, 170, 4);
    let prev = dd.at(now).status;
    for (let call = 0; call < 90; call++) {
      now += 20000;
      const q = dd.at(now);  // a frame drawn between two calls
      q.status.forEach((s, i) => { checked++; if (s === STATUS.noSegment) lost++; if (prev[i] === STATUS.served && s === STATUS.noSegment) assert.fail(`object ${i} had a cell and has none at call ${call}`); if (s >= 3) tombstoned++; });
      dd.refill(now, 170, 4);
      prev = dd.at(now).status;
    }
    assert.equal(lost, 0, `${lost} of ${checked} object-frames had no cell across 90 calls of 20 s over 3-minute windows`);
    assert.ok(dd.stats()[STAT.stored] > 60, "the windows turned over many times");
    assert.ok(prev.filter((s) => s === STATUS.served).length >= pd.length - 2);
  }
  finish("slab", t0);
}

// ---------------------------------------------------------------------------------------------------------------- sets AP refuses never stall a refill
{
  const t0 = Date.now();
  const pop = population([["underground", 4], ["leo500", 4], ["underground", 2], ["leo830", 3]], 33, 0);
  const f = await openFrames();
  await f.load(pop);
  assert.equal(f.open(BUDGET), 0);
  const t = EPOCH_MS + 3600e3;
  const r = f.fill(t, 180, 1);
  assert.equal(r.due, 0, "sets AP refuses are made and answered once, and the others served");
  const q = f.at(t);
  pop.forEach((o, i) => assert.equal(q.status[i], o.kind === "underground" ? STATUS.apRefuses : STATUS.served, `${o.kind} ${i}`));
  assert.equal(f.stats()[STAT.apTombstones], 12, "each of the 6 sets AP refuses at every time holds a tombstone for the window of `now` and one for the window of `now + ahead`");
  // a set whose initialization refuses (a test build refuses the initialization of the sets whose catalog number is 0, 1 or 2 modulo 4): status 3 at every time, counted once
  // an object, three in a row at max_rows 1 with no stall
  const wasmI = buildDiagnostic("frames-init-refusal", "", (s) => s, { "frames.inc": (s) => s.replace("err = xp == nullptr ? kPropRefused : xpt::xp_init(e, *xp);", "err = (en.row.norad_cat_id % 4 < 3 || xp == nullptr) ? kPropRefused : xpt::xp_init(e, *xp);") });
  const popI = population([["leo500", 8]], 44, 0);
  const g = await openFrames({ wasm: wasmI });
  await g.load(popI);
  assert.equal(g.open(BUDGET), 0);
  const rI = g.fill(t, 180, 1);
  assert.equal(rI.due, 0, "no stall behind three sets in a row whose initialization refuses");
  const qI = g.at(t), qI2 = g.at(t + 3 * 86400000 + 12345);
  popI.forEach((o, i) => assert.equal(qI.status[i], o.norad % 4 < 3 ? STATUS.apRefuses : STATUS.served, `object ${i} (catalog number ${o.norad})`));
  assert.equal(g.stats()[STAT.apTombstones], 6, "6 sets whose initialization refuses, counted once an object");
  assert.ok(qI2.status.every((s, i) => popI[i].norad % 4 < 3 ? s === STATUS.apRefuses : s === STATUS.noSegment), "and they answer 3 at every time");
  finish("sets AP refuses", t0);
}

// ---------------------------------------------------------------------------------------------------------------- position only; the builder's own status
{
  const t0 = Date.now();
  const pop = population([["leo500", 3], ["leo830", 2], ["geo", 1], ["ecc", 2], ["drag300", 3], ["drag250", 1], ["meo", 1]], 21, 1440);
  const p = await openFrames(), v = await openFrames();
  await p.load(pop); await v.load(pop);
  assert.equal(p.open(BUDGET, 1), 0);
  assert.equal(v.open(BUDGET), 0);
  for (const dayOffset of [0, 2]) {
    const t = EPOCH_MS + 3600e3 + dayOffset * DAY;
    p.fill(t, 180); v.fill(t, 180);
    const qp = p.at(t), qv = v.at(t);
    assert.equal(qp.planes.length, 3 * pop.length, "position-only writes three planes");
    assert.equal(qv.planes.length, 6 * pop.length);
    assert.deepEqual(Array.from(qp.status), Array.from(qv.status), "both modes halve alike: the same statuses");
    let compared = 0;
    for (let i = 0; i < pop.length; i++) {
      if (qp.status[i] !== STATUS.served) continue;
      compared++;
      for (let c = 0; c < 3; c++) assert.ok(Object.is(qp.planes[c * pop.length + i], qv.planes[c * pop.length + i]), "the positions are the same bits with and without velocity");
      assert.ok(dist3(p.ap(i, t), qp.planes, 0, pop.length, i) * 1000 <= POS_BOUND);
    }
    assert.ok(compared >= pop.length - 1, `${compared} states compared`);
    const ecef = p.at(t, 0, pop.length, 3), rv = v.at(t, 0, pop.length, 3);
    for (let i = 0; i < pop.length; i++) if (qp.status[i] === STATUS.served) for (let c = 0; c < 3; c++) assert.ok(Object.is(ecef.planes[c * pop.length + i], rv.planes[c * pop.length + i]));
  }
  // a build whose tolerance no window of 3 minutes holds: the builder's own status
  const wasm = buildDiagnostic("frames-tolerance", "", (s) => s, { "frames.inc": (s) => s.replace("constexpr double kTolPos = 5.0e-6;", "constexpr double kTolPos = 1.0e-15;") });
  const f = await openFrames({ wasm });
  const t = EPOCH_MS + 3600e3 + DAY;
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
  // a refill row: the clean answer first
  const ROW_ALLOCATIONS = [48, 48, 48];  // the counted allocations of one row of the leo500, geo and ecc objects: what xp_init allocates (the flight allocates none)
  for (const idx of [0, 1, 2]) {
    const t = EPOCH_MS + 2 * DAY + 600e3;
    const clean = await make();
    assert.equal(clean.open(BUDGET), 0);
    clean.refill(t, 0, 1, [idx], 1 << 30);  // armed at a count never reached: counts the row's allocations
    const rowCount = clean.x.sdnap_test_alloc_count();
    assert.equal(rowCount, ROW_ALLOCATIONS[idx], `object ${idx}: counted allocations of a row`);
    clean.refill(t + 3 * 3600e3, 0, 1, [idx], 1 << 30);  // a second row on the same instance (the thread's caches exist now): the same count
    const second = clean.x.sdnap_test_alloc_count();  // the thread's caches exist now: the row allocates its own set only
    assert.ok(second > 0 && second < ROW_ALLOCATIONS[idx], `object ${idx}: a second row's counted allocations (${second}) are fewer than the first's, and not none`);
    clean.x.sdnap_test_fail_at(0);
    assert.equal(clean.fill(t, 0, 5000, [idx]).due, 0);
    const want = clean.at(t), wantStats = clean.stats();
    assert.equal(want.status[idx], STATUS.served, "the clean run serves the object");
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
      assert.deepEqual([end[STAT.cells], end[STAT.cellBytes]], [wantStats[STAT.cells], wantStats[STAT.cellBytes]], "and the clean run's cells (where they lie differs: the clean run placed and freed the probe rows' cells first)");
    }
    console.log(`allocation failures: object ${idx}: ${rowCount} allocations of a row failed in turn`);
  }
  finish("allocation failures", t0);
}
console.log(`FRAMES PASS (${((Date.now() - T_START) / 1000).toFixed(0)} s)`);

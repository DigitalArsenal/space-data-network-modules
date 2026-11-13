#!/usr/bin/env node
// E2E (sdn-ap 0.6.18, stack issues #398 and #420): an AP state is a function of its set and its time alone.
// Made-up AP sets with the headline forces (zonal 20, tesseral 31, NRLMSISE-00 on made-up quiet rows), near-circular
// (500 km, 830 km, MEO, GEO) and eccentric (e 0.1 and 0.25 with tesseral 31, the transfer orbit with and without
// tesseral 31, Molniya), 7 days at 300 s from a day after the epoch. In the epoch store (sdnap_epochs_set_at):
// - random order and alternating ends against ascending order, bit for bit;
// - one state from a freshly loaded record against the ascending pass, bit for bit;
// - two records interleaved (time-major) against each alone, bit for bit;
// - the same with the pool's budget at 1 MB, on a test build of the same sources that adds the setter (the shipped
//   build keeps its 256 MB default: no export sets it, no typed message carries it yet); then forty 500 km sets at 1 MB stepped together (a
//   steady cycle over more sets than fit reclaims nothing, the sets without room fly on the thread's caches), the last
//   twenty alone (the holders no longer flown are reclaimed), the first twenty again (their runs refill from where they
//   were flown): bit for bit against 256 MB, sdnap_cache_stats counting it and never holding more than the budget.
// The pool's threads: 1,000 AP rows of the carrier lane's catalog mix through sdnap_propagate_soa at 20 instants, on 0
// and on 4 threads, bit for bit (the transfer and Molniya orbits left out: stack #424); the memory their row store's build
// takes at most ROW_STORE_MB (stack #477: a set's table built where it leaves no hole). AP's Sun and Moon (SPEC 16.17,
// nodes of an absolute grid in each thread's store): 64 rows whose epochs lie 85 1/3 days apart, so their nodes share
// store slots, on 0 and 4 threads against each epoch's rows alone, bit for bit; a batch at one instant
// (sdnap_propagate_soa, whose shared bodies are SGP4XP's) against the minutes call at the same instants, bit for bit, of
// AP sets and of AP and SGP4XP sets mixed.
// Through `propagate` (#420): a time asked alone against the same time inside one call of 2,016 states, bit for bit.
// The covariance (stack #491) and the third body's bracket tables (stack #475): thirteen AP records with covariance
// (fits of a catalog mix, and three at the mean motions where the bracket's builder changes), state and covariance at
// five leads asked in turn, in reverse turn, shuffled and on 4 threads, against each record alone, bit for bit. The
// 500 km record's covariance after the 815 km record's flown at lead 2 h, bit for bit. Two fits in either order, the
// records byte for byte.
// JS moves bytes and compares numbers the module produced.
//   node test/set-caches.e2e.mjs
import * as flatbuffers from "flatbuffers";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { F107DataType } from "spacedatastandards.org/lib/js/OCM/F107DataType.js";
import { OEM, OEMT } from "spacedatastandards.org/lib/js/OEM/OEM.js";
import { CATT } from "spacedatastandards.org/lib/js/OEM/CAT.js";
import { ephemerisDataBlockT as EphemerisBlockT } from "spacedatastandards.org/lib/js/OEM/ephemerisDataBlock.js";
import { timingStandard as oemTiming } from "spacedatastandards.org/lib/js/OEM/timingStandard.js";
import { OMM, OMMT } from "spacedatastandards.org/lib/js/OMM/OMM.js";
import { meanElementSource } from "spacedatastandards.org/lib/js/OMM/meanElementSource.js";
import { timingStandard as ommTiming } from "spacedatastandards.org/lib/js/OMM/timingStandard.js";
import { pcfSolidTideModel } from "spacedatastandards.org/lib/js/PCF/pcfSolidTideModel.js";
import { configuration } from "./lib/pcf.mjs";
import { packOem, rfm } from "./lib/frames.mjs";
import { PCFT } from "spacedatastandards.org/lib/js/PCF/PCF.js";
import { PCFOutputT } from "spacedatastandards.org/lib/js/PCF/PCFOutput.js";
import { pcfOutputFrame } from "spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js";
import { ensureBuilt, wasmPath, elementRows, THEORY } from "./lib/module.mjs";
import { guardExports, guardTesseral, warmCounts } from "./lib/warm-cache-guard.mjs";
import { buildDiagnostic } from "./lib/ap-diagnostic.mjs";
import { T, seedOcm, rowsThrough, repackOcm, ocmOf, flight, spwStream, AP_FORCES } from "./lib/ocm.mjs";
import { OCMDynamicParameterT } from "spacedatastandards.org/lib/js/OCM/OCMDynamicParameter.js";
import { OrbitDeterminationT } from "spacedatastandards.org/lib/js/OCM/OrbitDetermination.js";
import { prwDynamicParameter } from "spacedatastandards.org/lib/js/OCM/prwDynamicParameter.js";

const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };
const DAY = 86400000, EPOCH = Date.parse("2026-06-15T00:00:00Z"), MU = 398600.4418, RE = 6378.137;
const iso = (ms) => new Date(ms).toISOString().replace("Z", "");
const revPerDay = (a) => (Math.sqrt(MU / a ** 3) * 86400) / (2 * Math.PI);
const ROWS = Array.from({ length: 46 }, (_, k) => ({ DATE: iso(EPOCH + (k - 5) * DAY).slice(0, 10), F107_OBS: 70, F107_OBS_CENTER81: 72, AP_AVG: 4, F107_DATA_TYPE: F107DataType.OBS }));
const ORBITS = {
  "500 km": { n: revPerDay(RE + 500), e: 0.001, i: 97.4, bterm: 3.8e-3, tesseral: 31 },
  "830 km": { n: revPerDay(RE + 830), e: 0.001, i: 98.7, bterm: 1.27e-3, tesseral: 31 },
  MEO: { n: 2.0056, e: 0.005, i: 55, bterm: 0.001, tesseral: 31 },
  GEO: { n: 1.0027, e: 0.0003, i: 0.05, bterm: 0.001, tesseral: 31 },
  "e 0.1, tesseral 31": { n: revPerDay((RE + 600) / 0.9), e: 0.1, i: 65, bterm: 1.27e-3, tesseral: 31 },
  "e 0.25, tesseral 31": { n: revPerDay((RE + 600) / 0.75), e: 0.25, i: 65, bterm: 1.27e-3, tesseral: 31 },
  "transfer orbit": { n: 2.26, e: 0.72, i: 27, bterm: 1.27e-3, tesseral: 0 },
  "transfer orbit, tesseral 31": { n: 2.26, e: 0.72, i: 27, bterm: 1.27e-3, tesseral: 31 },
  Molniya: { n: 2.006, e: 0.74, i: 63.4, bterm: 1.27e-3, tesseral: 0 },
};
const record = (o, k) => seedOcm({ epoch: iso(EPOCH), n: o.n, e: o.e, i: o.i, raan: (60 + 3.3 * k) % 360, argp: 90, ma: (10 + 7.1 * k) % 360,
  bterm: o.bterm, agom: 0.01, norad: 80000 + k, name: `P${k}`, msis: true, records: true, rows: rowsThrough(ROWS), tesseral: o.tesseral, zonal: 20 });
const prefixed = (u) => { const b = Buffer.alloc(4 + u.length); b.writeUInt32LE(u.length, 0); Buffer.from(u).copy(b, 4); return b; };
const jd = (ms) => { const d = ms / DAY; return [Math.floor(d) + 2440587.5, d - Math.floor(d)]; };
const times = Array.from({ length: 2016 }, (_, k) => EPOCH + DAY + k * 300000);
let seed = 20261110;
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const shuffled = times.map((_, i) => i);
for (let i = shuffled.length - 1; i > 0; --i) { const j = Math.floor(rand() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
const ends = [];
for (let i = 0, j = times.length - 1; i <= j; ++i, --j) { ends.push(i); if (i !== j) ends.push(j); }
const same = (a, b) => a.length === b.length && a.every((v, q) => Object.is(v, b[q]));
// the pool's timer in the test build (polls of the calling thread without a completed row): a short count for the
// trapped and slowed batches, and a long one whose time gives the poll rate
const DEAD_TEST = 2 ** 28, DEAD_RATE = 2 ** 31;
// the memory the pool case's row store build may take (MB, the module's memory as the host sees it; stack #477): 0.6.42
// with each set's table built in its thread's scratch measures 51.75 MB (main 0.6.41 51.94 MB); the bound is a quarter
// over it. A build that took each table at its bound and cut it down after measured 223.94 MB.
const ROW_STORE_MB = 64;

ensureBuilt();
async function open(file, threads = 0) {
  const h = await createStandaloneHarness("browser", file, { surface: "direct", maxThreads: Math.max(1, threads), enableBrowserWasiThreads: threads > 0 });
  const x = h.instance.exports;
  if (threads > 0) x.sdnap_threads(threads);
  const out = x.sdnap_alloc(48), stats = x.sdnap_alloc(64);
  const mem = () => new Float64Array((h.memory ?? x.memory).buffer);
  return {
    h, x,
    load: async (records) => {
      const r = await h.invoke({ methodId: "load_epochs", inputs: [{ portId: "ocm", typeRef: T("OCM"), payload: Buffer.concat(records.map(prefixed)) }] });
      if (r.statusCode !== 0) throw new Error(`load_epochs ${r.errorCode}: ${r.errorMessage}`);
    },
    at: (i, ms) => {
      const [w, f] = jd(ms);
      const rc = x.sdnap_epochs_set_at(i, 0, w, f, out);
      if (rc !== 0) throw new Error(`sdnap_epochs_set_at ${rc}`);
      return Array.from(mem().subarray(out / 8, out / 8 + 6));
    },
    stats: () => { x.sdnap_cache_stats(stats); return Array.from(mem().subarray(stats / 8, stats / 8 + 8)); },
  };
}
const shipped = await open(wasmPath);
const { h, load, at } = shipped;
// the budget is the module's default (256 MB) and no export sets it (configuration reaches the module as a typed message,
// and none carries it yet): the budget cases run on a test build of the same sources that adds the setter
// (and AP's terms for the row store, which no call selects outside a call: the pool-thread case below)
const testBuild = buildDiagnostic("set-caches-budget",
  'SDNAP_EXPORT("sdnap_test_cache_budget") uint32_t sdnap_test_cache_budget(uint32_t mb) { return sdnap::xpt::cache_budget_mb(mb); }\n' +
  'SDNAP_EXPORT("sdnap_test_select_ap") void sdnap_test_select_ap(int32_t t, int32_t z) { sdnap::xpt::tess::active() = sdnap::xpt::tess::Terms{t, z}; }\n' +
  // rows carrying a radiation term Y0 (SPEC 16.13: in the row's mean_motion_dot slot), which sdnap_init_elements holds
  // refused from outside the module
  'SDNAP_EXPORT("sdnap_test_init_rows") int32_t sdnap_test_init_rows(const sdnap::ElementRow* rows, uint32_t count) { return sdnap::store_init(rows, count); }\n' +
  // the pool (stack #487): a pool thread that traps on its first chunk (mode 1), every chunk slowed by `slow` polls
  // (mode 2) or every row of the pool threads slowed by `slow` polls (mode 3; the calling thread's rows are not), the
  // polls without a completed row that take the pool for
  // dead, and no reserve before a threaded batch (every growth inside it refused); the rate of the yields start's wait
  // counts
  'static double sdnap_test_slow = 0; static volatile int32_t sdnap_test_sink = 0;\n' +
  'static void sdnap_test_trap(int32_t, bool pool_thread) { if (pool_thread) __builtin_trap(); }\n' +
  'static void sdnap_test_slowed(int32_t, bool) { for (double k = 0; k < sdnap_test_slow; ++k) (void)sdnap_test_sink; }\n' +
  'static void sdnap_test_slowed_row(uint32_t, bool pool_thread) { if (pool_thread) for (double k = 0; k < sdnap_test_slow; ++k) (void)sdnap_test_sink; }\n' +
  'SDNAP_EXPORT("sdnap_test_pool") void sdnap_test_pool(int32_t mode, double dead_polls, int32_t reserve_off, double slow) {\n' +
  '  sdnap::pool::g_chunk_hook = mode == 1 ? sdnap_test_trap : mode == 2 ? sdnap_test_slowed : nullptr; sdnap_test_slow = slow;\n' +
  '  sdnap::pool::g_row_hook = mode == 3 ? sdnap_test_slowed_row : nullptr;\n' +
  '  if (dead_polls > 0) sdnap::pool::dead_polls() = static_cast<uint64_t>(dead_polls); sdnap::pool::g_reserve_off = reserve_off != 0; }\n' +
  'SDNAP_EXPORT("sdnap_test_yields") void sdnap_test_yields(double n) { for (double k = 0; k < n; ++k) sched_yield(); }\n' +
  'SDNAP_EXPORT("sdnap_test_dead_yields") double sdnap_test_dead_yields() { return static_cast<double>(sdnap::pool::dead_yields()); }\n' +
  // a row store whose rows from `ap_from` on are AP sets (AP's terms) and the rest SGP4XP's: one batch mixing the two
  'SDNAP_EXPORT("sdnap_test_init_mixed") int32_t sdnap_test_init_mixed(const sdnap::ElementRow* rows, uint32_t count, uint32_t ap_from) {\n' +
  '  sdnap::xpt::tess::active() = sdnap::xpt::tess::Terms{};\n' +
  '  const int32_t n = sdnap::store_init(rows, count);\n' +
  '  sdnap::Store& st = sdnap::store();\n' +
  '  sdnap::xpt::tess::active() = sdnap::xpt::tess::Terms{31, 20};\n' +
  '  for (uint32_t i = ap_from; n > 0 && i < count; ++i) if (st.kind[i] == 1) { sdnap::xpt::XpSat& x = st.xps[st.slot[i]];\n' +
  '    sdnap::xpt::xp_release(x); sdnap::xpt::xp_init(sdnap::elements_of(rows[i]), x); sdnap::xpt::xp_set_pooled(x); }\n' +
  '  sdnap::xpt::tess::active() = sdnap::xpt::tess::Terms{};\n' +
  '  return n;\n' +
  '}' + guardExports, s => s, { 'tesseral.inc': guardTesseral });
const tiny = await open(testBuild);
tiny.x.sdnap_test_cache_budget(1);
check(tiny.stats()[0] === 2 ** 20 && shipped.stats()[0] === 256 * 2 ** 20, `budgets: the test build ${tiny.stats()[0]}, the shipped default ${shipped.stats()[0]}`);
check(shipped.x.sdnap_test_cache_budget === undefined && shipped.x.sdnap_cache_budget === undefined, "the shipped build exports a budget setter");

{
  // TEME km and km/s at UTC epochs: zero tolerance because interleaving must not change any state bit.
  // X, Y, X changes X's base key and exercises a resonant-only rebuild after Y's base bake.
  const x = record(ORBITS["500 km"], 0), y = record(ORBITS["830 km"], 1);
  const mixed = await open(testBuild), alone = await open(wasmPath);
  await mixed.load([x, y]); await alone.load([x]);
  mixed.at(0, times[0]); alone.at(0, times[0]);
  for (let k = 1; k <= 240; ++k) {
    const ms = times[0] + k * 60000;
    mixed.at(1, ms + DAY);
    check(same(mixed.at(0, ms), alone.at(0, ms)), `X,Y,X at minute ${k}: state differs from X alone`);
  }
  const counts = warmCounts(mixed);
  check(counts[2] > 0 && counts[3] > 0 && counts[4] > 0 && counts[5] > 0, `X,Y,X: ${counts[2]} base and ${counts[3]} resonant-only coefficient rebuilds; after another set base: ${counts[4]} base and ${counts[5]} resonant-only`);
  check(counts[1] === 0, `X,Y,X: ${counts[1]} coefficient mismatches`);
  console.log(`X,Y,X guard: ${counts[2]} base, ${counts[3]} resonant-only rebuilds; after another set base: ${counts[4]} base, ${counts[5]} resonant-only; ${counts[1]} mismatches`);
}

for (const [name, o] of Object.entries(ORBITS)) {
  const one = [record(o, 0)], two = [record(o, 0), record(o, 1)];
  await load(one);
  const asc = times.map((ms) => at(0, ms));
  for (const [label, order] of [["random order", shuffled], ["alternating ends", ends]]) {
    await load(one);
    const got = new Array(times.length);
    for (const i of order) got[i] = at(0, times[i]);
    const differ = got.filter((s, i) => !same(s, asc[i])).length;
    check(differ === 0, `${name}: ${label} against ascending: ${differ} of ${times.length} states differ`);
  }
  let freshDiffer = 0;
  for (let q = 0; q < 24; ++q) {
    const i = (q * 337 + 5) % times.length;
    await load(one);
    if (!same(at(0, times[i]), asc[i])) ++freshDiffer;
  }
  check(freshDiffer === 0, `${name}: one state from a fresh record against the ascending pass: ${freshDiffer} of 24 differ`);
  await load([record(o, 1)]);
  const asc1 = times.map((ms) => at(0, ms));
  for (const m of [shipped, tiny]) {
    await m.load(two);
    let differ = 0;
    times.forEach((ms, i) => { if (!same(m.at(0, ms), asc[i]) || !same(m.at(1, ms), asc1[i])) ++differ; });
    check(differ === 0, `${name}: two records interleaved${m === tiny ? " at a 1 MB budget" : ""} against each alone: ${differ} of ${times.length} instants differ`);
    const s = m.stats();
    check(s[1] <= s[0], `${name}: the pool holds ${s[1]} bytes, over its budget ${s[0]}`);
  }
  console.log(`${name}: random order, alternating ends, fresh records and interleaving bit for bit`);
}
{
  // a 1 MB budget: forty low-orbit sets stepped together (more than fit: the first to ask keep their caches, a steady
  // cycle reclaims none, the others fly on the thread's), then the last twenty alone (the holders no longer flown give way)
  const o = ORBITS["500 km"];
  const records = Array.from({ length: 40 }, (_, k) => record(o, k));
  const first = times.slice(0, 96), then = times.slice(96, 192), last = times.slice(192, 288);
  await load(records);
  const alone = first.map((ms) => records.map((_, i) => at(i, ms)));
  const aloneThen = then.map((ms) => records.map((_, i) => (i >= 20 ? at(i, ms) : null)));
  const aloneLast = last.map((ms) => records.map((_, i) => (i < 20 ? at(i, ms) : null)));
  await tiny.load(records);
  const s0 = tiny.stats();
  let differ = 0;
  first.forEach((ms, k) => records.forEach((_, i) => { if (!same(tiny.at(i, ms), alone[k][i])) ++differ; }));
  const s1 = tiny.stats();
  then.forEach((ms, k) => records.forEach((_, i) => { if (i >= 20 && !same(tiny.at(i, ms), aloneThen[k][i])) ++differ; }));
  const s2 = tiny.stats();
  // the first twenty again: their caches were reclaimed, the runs refill from where each set was flown
  last.forEach((ms, k) => records.forEach((_, i) => { if (i < 20 && !same(tiny.at(i, ms), aloneLast[k][i])) ++differ; }));
  check(differ === 0, `40 sets at a 1 MB budget against the same at 256 MB: ${differ} states differ`);
  const onThread = (s) => s[5] + s[6];  // caches and tesseral caches refused: flown on the thread's
  check(onThread(s1) > onThread(s0) && s1[4] === s0[4], `the cycle over 40 sets at 1 MB: ${onThread(s1) - onThread(s0)} asks on the thread's caches (some expected), ${s1[4] - s0[4]} caches reclaimed (none expected)`);
  check(s2[4] > s1[4], `the last twenty sets alone reclaimed no caches of the sets no longer flown (${s1[4]} then ${s2[4]})`);
  check(s1[1] <= s1[0] && s2[1] <= s2[0], `the pool holds ${s1[1]} then ${s2[1]} bytes, over its budget ${s2[0]}`);
  console.log(`40 sets at 1 MB: bit for bit; the cycle over all 40 kept its holders (${s1[2]} sets with caches, ${s1[3]} with tesseral caches, ${onThread(s1) - onThread(s0)} asks on the thread's caches, ${s1[4] - s0[4]} reclaimed); the last 20 alone reclaimed ${s2[4] - s1[4]}; ${s2[1]} of ${s2[0]} bytes held`);
}
{
  // the pool's threads: 1,000 AP rows of the carrier lane's catalog mix (its seeded sequence; the transfer and Molniya
  // orbits left out, whose family grids meet stack #424's cap and are refused by whichever thread asks last) in the row
  // store (sdnap_init_elements, AP's terms selected, the theory's own flux model), sdnap_propagate_soa at 20 instants
  // on 0 and on 4 pool threads: every double and status the same
  let seed = 20261110;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const rows = [];
  for (let k = 0; rows.length < 1000; k++) {
    const u = rnd();
    let a, e, i;
    if (u < 0.70) { a = RE + 300 + 1200 * rnd() ** 1.5; e = 0.02 * rnd() ** 2; i = 100 * rnd(); }
    else if (u < 0.80) { a = 26560 + 200 * (rnd() - 0.5); e = 0.02 * rnd(); i = 50 + 10 * rnd(); }
    else if (u < 0.88) { a = 42164 + 50 * (rnd() - 0.5); e = 0.001 * rnd(); i = 15 * rnd(); }
    else if (u < 0.95) { const rp = RE + 250 + 350 * rnd(); e = 0.5 + 0.25 * rnd(); a = rp / (1 - e); i = 7 + 50 * rnd(); }
    else { a = 26560; e = 0.70 + 0.04 * rnd(); i = 63.4; }
    const row = { epochWhole: 2461328.5, epochFrac: 0, meanMotion: revPerDay(a), ecc: e, inc: i, raan: 360 * rnd(), argp: 360 * rnd(), ma: 360 * rnd(),
      bterm: a < RE + 2000 ? 0.005 + 0.05 * rnd() : 0.01, agom: 0.01, norad: 100000 + k, theory: THEORY.SGP4XP };
    if (e < 0.3) rows.push(row);
  }
  // stack #564 (SPEC 16.25): one decaying AP set (perigee 200 km, BTERM 0.01: refused from about 70 h) beside the catalog mix, flown at
  // instants on both sides of its crossing, so the comparison below asserts the same status and the same bits for it on 0 and on
  // 4 threads. A test of the law on the new path (a crossing found by whichever worker's node run reaches it), not a regression test
  const decayRow = { epochWhole: 2461328.5, epochFrac: 0, meanMotion: revPerDay((RE + 200) / (1 - 0.001)), ecc: 0.001, inc: 55, raan: 40, argp: 90, ma: 0,
    bterm: 0.01, agom: 0.01, norad: 199564, theory: THEORY.SGP4XP };
  rows.push(decayRow);
  // each instant's planes and statuses, the calls' returns, sdnap_pool_stats after the last
  const fly = async (threads, setup = () => {}) => {
    const m = await open(testBuild, threads);
    m.x.sdnap_test_select_ap(31, 20);
    setup(m.x);
    const bytes = elementRows(rows), n = rows.length;
    const p = m.x.sdnap_alloc(bytes.length);
    new Uint8Array(m.h.memory.buffer, p, bytes.length).set(bytes);
    // the memory the row store's build takes, as the host sees the module's memory (stack #477)
    const before = m.h.memory.buffer.byteLength;
    check(m.x.sdnap_init_elements(p, n) === n, `${threads} threads: the row store took ${n} rows`);
    const storeMB = (m.h.memory.buffer.byteLength - before) / 1048576;
    const out = m.x.sdnap_alloc(48 * n), status = m.x.sdnap_alloc(4 * n), ps = m.x.sdnap_alloc(96), all = [], rcs = [];
    for (let k = 0; k < 20; ++k) {
      rcs.push(m.x.sdnap_propagate_soa(2461328.5, 0.5 + 0.25 * k, 0, n, 0, out, status));
      all.push([...new Float64Array(m.h.memory.buffer, out, 6 * n), ...new Int32Array(m.h.memory.buffer, status, n)]);
    }
    const counts = warmCounts(m);
    check(counts[0] > 0 && counts[1] === 0, `${threads} threads: coefficient reuse matches ${counts[0]}, mismatches ${counts[1]}`);
    console.log(`coefficient guard: ${threads} threads, ${counts[0]} matches, ${counts[1]} mismatches`);
    m.x.sdnap_pool_stats(ps);
    return { all, rcs, storeMB, pool: Array.from(new Float64Array(m.h.memory.buffer, ps, 10)) };
  };
  const differing = (a, b, from = 0) => a.all.slice(from).reduce((d, v, k) => d + v.filter((w, q) => !Object.is(w, b.all[from + k][q])).length, 0);
  const zero = await fly(0), four = await fly(4);
  check(zero.rcs.every((r) => r === 0) && four.rcs.every((r) => r === 0), `sdnap_propagate_soa returned ${zero.rcs} on 0 threads, ${four.rcs} on 4`);
  // the row store's build at AP 31/20 (stack #477): each set fills its output table in its thread's scratch at the table's
  // bound and keeps a copy at its counts (ROW_STORE_MB); a build that took each table at its bound and cut it down after took
  // 224 MB here, 167 MB of it left free inside the heap between the sets' tables, and refused no growth without the reserve
  check(zero.storeMB <= ROW_STORE_MB && four.storeMB <= ROW_STORE_MB,
    `the row store's build of ${rows.length} AP rows at 31/20 took ${zero.storeMB.toFixed(2)} MB (0 threads) and ${four.storeMB.toFixed(2)} MB (4 threads) of memory (at most ${ROW_STORE_MB} MB)`);
  console.log(`the row store's build of ${rows.length} AP rows at 31/20: ${zero.storeMB.toFixed(2)} MB of memory on 0 threads, ${four.storeMB.toFixed(2)} MB on 4 (at most ${ROW_STORE_MB} MB)`);
  const differ = differing(four, zero), values = zero.all.length * zero.all[0].length;
  check(differ === 0, `the pool's threads: ${differ} of ${values} values differ between 0 and 4 threads`);
  // the decaying set (the last row): flown (status 0) at the first instant, refused as decayed (status 4) at the last, on both
  const statusAt = (r, k) => r.all[k][6 * rows.length + rows.length - 1];
  check(statusAt(zero, 0) === 0 && statusAt(zero, 19) === 4 && statusAt(four, 0) === 0 && statusAt(four, 19) === 4,
    `the decaying set's status at the first and last instants: ${statusAt(zero, 0)}, ${statusAt(zero, 19)} on 0 threads; ${statusAt(four, 0)}, ${statusAt(four, 19)} on 4 (0 and 4 expected)`);
  // stack #487: the memory does not grow inside a threaded batch (its sets' room is made before it; sbrk refuses inside it)
  const [, batches, refused, deferred, grew, dead] = four.pool;
  check(zero.pool[1] === 0 && batches === 20 && grew === 0 && dead === 0, `the pool's batches: ${batches} threaded (20 expected), ${grew} with the memory grown inside (none expected), dead ${dead}`);
  console.log(`1,000 AP rows of the catalog mix through sdnap_propagate_soa: 0 and 4 pool threads bit for bit (${values} values); 20 threaded batches, the memory grown inside none, ${refused} growths refused, ${deferred} rows deferred`);
  // no reserve: every growth a batch would make is refused, its sets fly on the threads' caches and the rows stopped
  // short are computed again on the calling thread after it; the same bits
  const off = await fly(4, (x) => x.sdnap_test_pool(0, 0, 1, 0));
  const offDiffer = differing(off, zero);
  check(off.rcs.every((r) => r === 0) && offDiffer === 0, `no reserve: ${offDiffer} of ${values} values differ from 0 threads (returns ${off.rcs})`);
  check(off.pool[2] > 0 && off.pool[3] > 0 && off.pool[4] === 0, `no reserve: ${off.pool[2]} growths refused, ${off.pool[3]} rows deferred (some of each expected), ${off.pool[4]} batches grew the memory`);
  console.log(`no reserve: bit for bit; ${off.pool[2]} growths refused, ${off.pool[3]} rows deferred, the memory grown inside no batch`);
  // a pool thread that traps on its first chunk: the batch returns -20 (every status 9) once the calling thread has
  // polled DEAD_TEST times without a row completing, the pool is not used again, and the later batches on the calling
  // thread give the same bits
  const t0 = Date.now();
  const trap = await fly(4, (x) => x.sdnap_test_pool(1, DEAD_TEST, 0, 0));
  const n = rows.length, first = trap.all[0].slice(6 * n);
  check(trap.rcs[0] === -20 && first.every((s) => s === 9), `a trapped pool thread: the batch returned ${trap.rcs[0]} (-20 expected), ${first.filter((s) => s !== 9).length} statuses not 9`);
  const trapDiffer = differing(trap, zero, 1);
  check(trap.rcs.slice(1).every((r) => r === 0) && trapDiffer === 0 && trap.pool[5] === 1, `after a trapped pool thread: returns ${trap.rcs.slice(1)}, ${trapDiffer} values differ from 0 threads, dead ${trap.pool[5]}`);
  console.log(`a trapped pool thread: the batch returned -20 after ${DEAD_TEST.toExponential(2)} polls, the pool taken for dead, the 19 batches after it bit for bit on the calling thread (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}
{
  // the pool's timer (stack #487) is a count of the calling thread's polls without a completed row, not wall time.
  // 32,768 SGP4 rows (64 chunks) on 4 pool threads:
  // - a trapped pool thread: the time to the -20 gives the poll rate here, and the default count is at least 30 s of it;
  // - every chunk slowed by 0.4 of the count before its rows, so the batch lasts longer than the count while chunks keep
  //   completing: the batch completes, bit for bit against the same rows unslowed;
  // - only the pool threads' rows slowed, each by 0.05 of the count (a slowing loop's step is faster than a poll): the
  //   calling thread finishes its own chunks and then waits for the four chunks the pool threads hold (512 rows each)
  //   while their rows keep completing. The batch completes, bit for bit, and the wait outlasts twice the count. A wait
  //   that counts chunks only takes the pool for dead here (-20: a diagnostic build whose wait resets on chunks only,
  //   0.6.33's pull request);
  // - the rate of the yields start's own wait counts, and its default at least 30 s of them.
  const rows = Array.from({ length: 32768 }, (_, k) => ({ epochWhole: 2461328.5, epochFrac: 0, meanMotion: 15.2, ecc: 0.001, inc: 51.6,
    raan: (7.3 * k) % 360, argp: 0, ma: (11.9 * k) % 360, bstar: 1e-4, norad: k + 1, theory: THEORY.SGP4 }));
  const fly = async (setup) => {
    const m = await open(testBuild, 4);
    const ps = m.x.sdnap_alloc(96);
    m.x.sdnap_pool_stats(ps);
    const defaults = Array.from(new Float64Array(m.h.memory.buffer, ps, 10));
    setup(m.x);
    const bytes = elementRows(rows), n = rows.length;
    const p = m.x.sdnap_alloc(bytes.length);
    new Uint8Array(m.h.memory.buffer, p, bytes.length).set(bytes);
    check(m.x.sdnap_init_elements(p, n) === n, `the timer: the row store took ${n} rows`);
    const out = m.x.sdnap_alloc(48 * n), status = m.x.sdnap_alloc(4 * n);
    const t0 = performance.now();
    const rc = m.x.sdnap_propagate_soa(2461328.5, 0.5, 0, n, 0, out, status);
    const seconds = (performance.now() - t0) / 1000;
    return { m, rc, seconds, defaults, planes: [...new Float64Array(m.h.memory.buffer, out, 6 * n)] };
  };
  const trapped = await fly((x) => x.sdnap_test_pool(1, DEAD_RATE, 0, 0));
  const rate = DEAD_RATE / trapped.seconds, defaultPolls = trapped.defaults[6];
  check(trapped.rc === -20, `the timer: a trapped pool thread's batch returned ${trapped.rc} (-20 expected)`);
  check(defaultPolls / rate >= 30, `the timer: the default count, ${defaultPolls.toExponential(2)} polls, is ${(defaultPolls / rate).toFixed(1)} s at this machine's ${rate.toExponential(2)} polls/s (at least 30 s expected)`);
  const plain = await fly(() => {}), slowed = await fly((x) => x.sdnap_test_pool(2, DEAD_TEST, 0, 0.4 * DEAD_TEST));
  const slowedDiffer = slowed.planes.filter((v, k) => !Object.is(v, plain.planes[k])).length;
  check(slowed.rc === 0 && slowedDiffer === 0, `the timer: a batch slowed on purpose returned ${slowed.rc} (0 expected), ${slowedDiffer} values differ from the same unslowed`);
  check(slowed.seconds > DEAD_TEST / rate, `the timer: the slowed batch lasted ${slowed.seconds.toFixed(2)} s, not longer than the count (${(DEAD_TEST / rate).toFixed(2)} s at this rate), so it shows nothing`);
  // the calling thread's own chunks are unslowed: the batch's time is about one pool thread's chunk, almost all of it the
  // calling thread's wait
  const rowSlowed = await fly((x) => x.sdnap_test_pool(3, DEAD_TEST, 0, 0.05 * DEAD_TEST));
  const rowSlowedDiffer = rowSlowed.planes.filter((v, k) => !Object.is(v, plain.planes[k])).length;
  check(rowSlowed.rc === 0 && rowSlowedDiffer === 0, `the timer: a batch whose pool threads' rows were slowed on purpose returned ${rowSlowed.rc} (0 expected), ${rowSlowedDiffer} values differ from the same unslowed`);
  check(rowSlowed.seconds - plain.seconds > 2 * DEAD_TEST / rate, `the timer: with the pool threads' rows slowed the batch lasted ${rowSlowed.seconds.toFixed(2)} s (${plain.seconds.toFixed(2)} s unslowed), not twice the count (${(DEAD_TEST / rate).toFixed(2)} s at this rate) longer, so it shows nothing`);
  const YIELDS = 2e6, ty = performance.now();
  plain.m.x.sdnap_test_yields(YIELDS);
  const yieldRate = YIELDS / ((performance.now() - ty) / 1000);
  const DEAD_YIELDS_DEFAULT = plain.m.x.sdnap_test_dead_yields();
  check(DEAD_YIELDS_DEFAULT / yieldRate >= 30, `the timer: start's default, ${DEAD_YIELDS_DEFAULT.toExponential(2)} yields, is ${(DEAD_YIELDS_DEFAULT / yieldRate).toFixed(1)} s at this machine's ${yieldRate.toExponential(2)} yields/s (at least 30 s expected)`);
  console.log(`the timer: ${rate.toExponential(2)} polls/s here, the default ${defaultPolls.toExponential(2)} polls = ${(defaultPolls / rate).toFixed(0)} s; a batch slowed past the count (${slowed.seconds.toFixed(2)} s against ${(DEAD_TEST / rate).toFixed(2)} s) completed bit for bit; a batch whose pool threads' rows were slowed, the calling thread waiting ${(rowSlowed.seconds - plain.seconds).toFixed(2)} s for their chunks while their rows kept completing, completed bit for bit; ${yieldRate.toExponential(2)} yields/s, start's default ${(DEAD_YIELDS_DEFAULT / yieldRate).toFixed(0)} s`);
}
{
  // the radiation term Y0 (SPEC 16.13) is part of a set's identity, as BTERM and AGOM are: two records of one
  // Galileo-like orbit equal but for ECOM2_Y0, in one store and asked in turn, each bit for bit as it flies alone; and
  // 200 rows of it carrying Y0 (the test build's row entry) on 0 and 4 pool threads, bit for bit
  const o = { n: 1.7085, e: 0.0003, i: 56 };
  const withY0 = (norad, y0) => repackOcm(seedOcm({ epoch: iso(EPOCH), n: o.n, e: o.e, i: o.i, raan: 40, argp: 30, ma: 20, bterm: 0.001, agom: 0.02,
    norad, name: `G${norad}`, msis: true, records: true, rows: rowsThrough(ROWS), tesseral: 31, zonal: 20 }), (t) => {
    t.ORBIT_DETERMINATION ??= new OrbitDeterminationT();
    t.ORBIT_DETERMINATION.OD_DYNAMIC_PARAMETERS = [Object.assign(new OCMDynamicParameterT(), {
      NAME: prwDynamicParameter[prwDynamicParameter.ECOM2_Y0], VALUE: y0, UNITS: "m/s**2", SOLVED_FOR: false, PARAMETER: prwDynamicParameter.ECOM2_Y0 })];
  });
  const a = withY0(81000, 2e-9), b = withY0(81001, -3e-9);
  const span = times.slice(0, 288);
  await load([a]);
  const aloneA = span.map((ms) => at(0, ms));
  await load([b]);
  const aloneB = span.map((ms) => at(0, ms));
  await load([a, b]);
  let differ = 0, apart = 0;
  span.forEach((ms, k) => {
    const sa = at(0, ms), sb = at(1, ms);
    if (!same(sa, aloneA[k]) || !same(sb, aloneB[k])) ++differ;
    if (!same(sa, sb)) ++apart;
  });
  check(apart === span.length, `Y0: the two records fly apart at ${apart} of ${span.length} instants (all expected)`);
  check(differ === 0, `Y0: two records equal but for ECOM2_Y0, asked in turn, against each alone: ${differ} of ${span.length} instants differ`);
  const rows = Array.from({ length: 200 }, (_, k) => ({ epochWhole: 2461328.5, epochFrac: 0, meanMotion: o.n, ecc: o.e, inc: o.i, raan: (40 + 1.7 * k) % 360,
    argp: 30, ma: (20 + 3.1 * k) % 360, ndot: (k % 2 ? 2e-9 : -3e-9), bterm: 0.001, agom: 0.02, norad: 82000 + k, theory: THEORY.SGP4XP }));
  const flyRows = async (threads) => {
    const m = await open(testBuild, threads);
    m.x.sdnap_test_select_ap(31, 20);
    const bytes = elementRows(rows), n = rows.length;
    const p = m.x.sdnap_alloc(bytes.length);
    new Uint8Array(m.h.memory.buffer, p, bytes.length).set(bytes);
    check(m.x.sdnap_test_init_rows(p, n) === n, `Y0 rows, ${threads} threads: the row store took ${n} rows`);
    const out = m.x.sdnap_alloc(48 * n), status = m.x.sdnap_alloc(4 * n), all = [];
    for (let k = 0; k < 20; ++k) {
      check(m.x.sdnap_propagate_soa(2461328.5, 0.5 + 0.25 * k, 0, n, 0, out, status) === 0, `Y0 rows, ${threads} threads: sdnap_propagate_soa`);
      all.push(...new Float64Array(m.h.memory.buffer, out, 6 * n), ...new Int32Array(m.h.memory.buffer, status, n));
    }
    return all;
  };
  const y0zero = await flyRows(0), y0four = await flyRows(4);
  const y0differ = y0zero.filter((v, k) => !Object.is(v, y0four[k])).length;
  check(y0differ === 0, `Y0 rows: ${y0differ} of ${y0zero.length} values differ between 0 and 4 threads`);
  console.log(`Y0: two records equal but for ECOM2_Y0 bit for bit as each alone; 200 rows with Y0 on 0 and 4 threads bit for bit`);
}
{
  // AP's Sun and Moon (SPEC 16.17): nodes on an absolute 8 h grid in each thread's store of 256 nodes by index, so times
  // 85 1/3 days apart (256 nodes) share a slot. 64 medium-orbit rows in the row store (AP's terms selected), every other
  // one with its epoch 2,048 h after the rest, each row at the same minutes from its own epoch (a read of one row's node
  // takes the slot of the other's): on 0 and on 4 pool threads against each epoch's rows in a store of their own (no
  // slot shared), bit for bit; and a batch at one instant (sdnap_propagate_soa, whose shared bodies are SGP4XP's: an AP
  // set reads its own) against the minutes call at the same instants, bit for bit.
  const e0 = 2461328.5, shift = 2048 / 24;
  const rows = Array.from({ length: 64 }, (_, k) => {
    const ep = k % 2 ? e0 : e0 + shift, whole = Math.floor(ep - 0.5) + 0.5;
    return { epochWhole: whole, epochFrac: ep - whole, meanMotion: 2.0056, ecc: 0.005, inc: 55, raan: (40 + 5.3 * k) % 360, argp: 40,
      ma: (10 + 11.7 * k) % 360, bterm: 0.001, agom: 0.01, norad: 83000 + k, theory: THEORY.SGP4XP };
  });
  const minutes = Array.from({ length: 40 }, (_, k) => 1440 + 180 * k);
  // every row an AP set, or (apFrom) the rows before apFrom SGP4XP's
  const rowStore = async (set, threads, apFrom = null) => {
    const m = await open(testBuild, threads);
    if (apFrom === null) m.x.sdnap_test_select_ap(31, 20);
    const bytes = elementRows(set), n = set.length, p = m.x.sdnap_alloc(bytes.length);
    new Uint8Array(m.h.memory.buffer, p, bytes.length).set(bytes);
    const held = apFrom === null ? m.x.sdnap_init_elements(p, n) : m.x.sdnap_test_init_mixed(p, n, apFrom);
    check(held === n, `bodies, ${threads} threads: the row store took ${held} of ${n} rows`);
    return { m, n, mins: m.x.sdnap_alloc(8 * n), out: m.x.sdnap_alloc(48 * n), status: m.x.sdnap_alloc(4 * n) };
  };
  const flyMinutes = async (set, threads) => {
    const s = await rowStore(set, threads), all = [];
    for (const t of minutes) {
      new Float64Array(s.m.h.memory.buffer, s.mins, s.n).fill(t);
      check(s.m.x.sdnap_propagate_minutes_soa(s.mins, 0, s.n, s.out, s.status) === 0, `bodies, ${threads} threads: sdnap_propagate_minutes_soa`);
      const v = new Float64Array(s.m.h.memory.buffer, s.out, 6 * s.n);
      all.push(Array.from({ length: s.n }, (_, i) => [0, 1, 2, 3, 4, 5].map((c) => v[c * s.n + i])));
    }
    return all;
  };
  const mixed0 = await flyMinutes(rows, 0), mixed4 = await flyMinutes(rows, 4);
  const evens = await flyMinutes(rows.filter((_, k) => k % 2 === 0), 0), odds = await flyMinutes(rows.filter((_, k) => k % 2 === 1), 0);
  let differ = 0;
  minutes.forEach((_, q) => rows.forEach((_, k) => {
    const alone = (k % 2 ? odds : evens)[q][k >> 1];
    if (!same(mixed0[q][k], alone) || !same(mixed4[q][k], alone)) ++differ;
  }));
  check(differ === 0, `bodies: rows 85 1/3 days apart (store slots shared) on 0 and 4 threads against each epoch's rows alone: ${differ} of ${rows.length * minutes.length} states differ`);
  // the rows whose epochs are at 0 h, at quarter days: a batch at one instant against the minutes call, all AP sets and
  // half SGP4XP's (a batch mixing the two at one time: the SGP4XP rows take the batch's shared bodies, the AP rows not)
  const set = rows.filter((_, k) => k % 2 === 1);
  const batchAgainstMinutes = async (s) => {
    let differ = 0;
    for (let q = 0; q < 20; ++q) {
      const whole = e0 + 1 + Math.floor(q / 4), frac = (q % 4) / 4;
      check(s.m.x.sdnap_propagate_soa(whole, frac, 0, s.n, 0, s.out, s.status) === 0, "bodies: sdnap_propagate_soa");
      const batch = Array.from(new Float64Array(s.m.h.memory.buffer, s.out, 6 * s.n));
      new Float64Array(s.m.h.memory.buffer, s.mins, s.n).set(set.map((r) => ((whole - r.epochWhole) + (frac - r.epochFrac)) * 1440));
      check(s.m.x.sdnap_propagate_minutes_soa(s.mins, 0, s.n, s.out, s.status) === 0, "bodies: sdnap_propagate_minutes_soa");
      const call = Array.from(new Float64Array(s.m.h.memory.buffer, s.out, 6 * s.n));
      differ += batch.filter((v, k) => !Object.is(v, call[k])).length;
    }
    return differ;
  };
  const batchDiffer = await batchAgainstMinutes(await rowStore(set, 0)), mixedDiffer = await batchAgainstMinutes(await rowStore(set, 0, set.length >> 1));
  check(batchDiffer === 0 && mixedDiffer === 0, `bodies: a batch at one instant against the minutes call at the same instants: ${batchDiffer} (AP sets) and ${mixedDiffer} (half SGP4XP's) of ${20 * 6 * set.length} values differ`);
  console.log(`AP's Sun and Moon: 64 rows 85 1/3 days apart (store slots shared) on 0 and 4 threads bit for bit as each epoch's rows alone; a batch at one instant bit for bit as the minutes call, of AP sets and of AP and SGP4XP sets mixed`);
}
{
  // through propagate (#420): a time alone against the same time in one call
  const pcfBytes = (epochs) => { const c = new PCFT(); c.OUTPUT = Object.assign(new PCFOutputT(), { FRAME: pcfOutputFrame.TEME, EPOCHS: epochs.map(iso), MAXIMUM_STATES: 3000 });
    const b = new flatbuffers.Builder(1 << 16); b.finish(c.pack(b), "$PCF"); return b.asUint8Array().slice(); };
  const lines = (bytes) => OEM.getRootAsOEM(new flatbuffers.ByteBuffer(bytes)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES;
  const fly = async (ocm, epochs) => {
    const r = await h.invoke({ methodId: "propagate", inputs: [{ portId: "ocm", typeRef: T("OCM"), payload: ocm }, { portId: "configuration", typeRef: T("PCF"), payload: pcfBytes(epochs) }] });
    if (r.statusCode !== 0) throw new Error(`propagate ${r.errorCode}: ${r.errorMessage}`);
    return lines(new Uint8Array(r.outputs.find((p) => p.portId === "ephemeris").payload));
  };
  for (const [name, o] of Object.entries(ORBITS)) {
    const ocm = record(o, 0);
    const all = await fly(ocm, times);
    let differ = 0;
    for (let q = 0; q < 12; ++q) {
      const i = (q * 337 + 11) % times.length;
      const a = (await fly(ocm, [times[i]]))[0], b = all[i];
      if (!(Object.is(a.X, b.X) && Object.is(a.Y, b.Y) && Object.is(a.Z, b.Z) && Object.is(a.X_DOT, b.X_DOT))) ++differ;
    }
    check(differ === 0, `${name}: propagate, a time alone against the same time in one call: ${differ} of 12 differ`);
  }
  console.log("propagate: a time alone against the same time in one call, bit for bit on every orbit");
}
{
  // the covariance's rule (stack #491, SPEC 12.3) with the third body's bracket tables (stack #475): a record's state and
  // covariance are functions of the record and the time alone. Thirteen AP records with covariance, each fitted to 72 h
  // of its own SGP4 flight: ten orbits of a catalog mix, and three whose mean motion sits where the third body's bracket
  // builder changes (0.006, 0.015 and 0.035 rad/min). Each is asked at leads of 1, 2, 24, 72 and 168 h:
  // - alone in a fresh instance (the reference);
  // - in turn with the others, in reverse turn, and in a shuffled order of every record and lead;
  // - in turn on 4 pool threads.
  // Every state and covariance value must match the reference bit for bit.
  const T0 = Date.parse("2026-10-08T00:00:00Z"), jdn0 = T0 / DAY + 2440587.5;
  const gmst0 = (((280.46061837 + 360.98564736629 * (jdn0 - 2451545.0)) % 360) + 360) % 360;
  const RAD_MIN = 1440 / (2 * Math.PI);  // rev/day per rad/min
  const MIX = [
    ["leo500", { n: revPerDay(RE + 500), e: 0.001, i: 97.4, raan: 30, argp: 90, ma: 0, bstar: 3e-4 }],
    ["leo815", { n: revPerDay(RE + 815), e: 0.0011, i: 98.65, raan: 40, argp: 90, ma: 0, bstar: 1e-4 }],
    ["leo1200", { n: revPerDay(RE + 1200), e: 0.002, i: 87.9, raan: 120, argp: 45, ma: 30, bstar: 2e-5 }],
    ["meo12h", { n: 2.0056, e: 0.005, i: 55, raan: 200, argp: 30, ma: 60, bstar: 0 }],
    ["galileo", { n: 1.7085, e: 0.0003, i: 56, raan: 80, argp: 30, ma: 20, bstar: 0 }],
    ["geo0.05", { n: 1.0027379, e: 0.0002, i: 0.05, raan: gmst0, argp: 0, ma: 0, bstar: 0 }],
    ["geo2", { n: 1.0027379, e: 0.0002, i: 2, raan: (gmst0 + 90) % 360, argp: 0, ma: 0, bstar: 0 }],
    ["igso55", { n: 1.0027379, e: 0.003, i: 55, raan: (gmst0 + 120) % 360, argp: 270, ma: 0, bstar: 0 }],
    ["n0.9", { n: 0.9, e: 0.001, i: 30, raan: 10, argp: 10, ma: 10, bstar: 0 }],
    ["transfer", { n: 2.26, e: 0.72, i: 27, raan: 50, argp: 180, ma: 0, bstar: 1e-4 }],
  ];
  // the thresholds and the relative offset where stack #475 measured the largest move between orders
  const AT = [["n 0.006", 0.006, 0], ["n 0.015", 0.015, 1e-7], ["n 0.035", 0.035, 1e-7]];
  for (const [name, n, off] of AT) MIX.push([name, { n: n * (1 + off) * RAD_MIN, e: 0.001, i: 55, raan: 60, argp: 90, ma: 0, bstar: 0, exactN: true }]);
  const wx = [];
  for (let ms = T0 - 100 * DAY; ms <= T0 + 45 * DAY; ms += DAY)
    wx.push({ DATE: new Date(ms).toISOString().slice(0, 10), F107_OBS: 150, F107_OBS_CENTER81: 150, AP_AVG: 15, F107_DATA_TYPE: F107DataType.OBS });
  const spw = spwStream(rowsThrough(wx));
  const maker = await createStandaloneHarness("browser", wasmPath, { surface: "command" });
  const call = async (hh, methodId, inputs) => {
    const r = await hh.invoke({ methodId, inputs });
    if (r.statusCode !== 0) throw new Error(`${methodId}: ${r.errorCode} ${r.errorMessage}`);
    return r.outputs;
  };
  const arc = Array.from({ length: (3 * DAY) / 300000 + 1 }, (_, k) => iso(T0 + k * 300000));
  const fitConfig = configuration({ theory: "AP", forces: { ...AP_FORCES, SOLID_TIDES: pcfSolidTideModel.IERS_2010 }, fit: { WEATHER_HORIZON_DAYS: 30 } });
  // the 72 h arc a record is fitted to: its SGP4 flight in GCRF every 5 min
  const arcOf = async (o, norad) => {
    const t = Object.assign(new OMMT(), { CCSDS_OMM_VERS: 3.0, CREATION_DATE: "", ORIGINATOR: "local", OBJECT_NAME: `MADE-UP ${norad}`, OBJECT_ID: `${norad}`,
      CENTER_NAME: "EARTH", TIME_SYSTEM: ommTiming.UTC, MEAN_ELEMENT_THEORY: meanElementSource.SGP4, EPOCH: iso(T0), MEAN_MOTION: o.n, ECCENTRICITY: o.e,
      INCLINATION: o.i, RA_OF_ASC_NODE: o.raan, ARG_OF_PERICENTER: o.argp, MEAN_ANOMALY: o.ma, NORAD_CAT_ID: norad, BSTAR: o.bstar, MEAN_MOTION_DOT: 0, MEAN_MOTION_DDOT: 0 });
    const ob = new flatbuffers.Builder(512);
    OMM.finishSizePrefixedOMMBuffer(ob, t.pack(ob));
    const sgp4 = new Uint8Array((await call(maker, "ingest_omm", [{ portId: "omm", typeRef: T("OMM"), payload: ob.asUint8Array().slice() }])).find((x) => x.portId === "ocm").payload);
    const flown = new Uint8Array((await call(maker, "propagate", flight([sgp4], { output: { EPOCHS: arc, FRAME: pcfOutputFrame.GCRF } }))).find((x) => x.portId === "ephemeris").payload);
    const ls = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(flown)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES;
    const blk = Object.assign(new EphemerisBlockT(), { OBJECT: Object.assign(new CATT(), { NORAD_CAT_ID: norad, OBJECT_NAME: `MADE-UP ${norad}` }), CENTER_NAME: "EARTH",
      REFERENCE_FRAME: rfm("GCRF"), TIME_SYSTEM: oemTiming.UTC, START_TIME: ls[0].EPOCH, STOP_TIME: ls.at(-1).EPOCH, USEABLE_START_TIME: ls[0].EPOCH,
      USEABLE_STOP_TIME: ls.at(-1).EPOCH, EPHEMERIS_DATA_LINES: ls });
    return packOem(Object.assign(new OEMT(), { EPHEMERIS_DATA_BLOCK: [blk] }));
  };
  const fitOf = async (hh, oem) => new Uint8Array((await call(hh, "fit", [fitConfig, { portId: "ephemeris", typeRef: T("OEM"), payload: oem },
    { portId: "space_weather", typeRef: T("SPW"), payload: spw }])).find((x) => x.portId === "elements").payload);
  const arcs = [], recs = [];
  for (const [k, [name, o]] of MIX.entries()) {
    arcs.push(await arcOf(o, 99901 + k));
    let rec = await fitOf(maker, arcs[k]);
    // a threshold record: its fitted elements and covariance, its mean motion set where the builder changes
    if (o.exactN) rec = repackOcm(rec, (t) => { t.MEAN_ELEMENTS.MEAN_MOTION = o.n; });
    check(ocmOf(rec).COV_SIZE >= 6, `covariance rule: ${name}'s fit has a covariance (COV_SIZE ${ocmOf(rec).COV_SIZE})`);
    recs.push(rec);
  }
  const LEADS = [1, 2, 24, 72, 168];
  const t0s = recs.map((u) => Date.parse(`${ocmOf(u).MEAN_ELEMENTS.EPOCH.replace(/Z$/, "")}Z`));
  // an instance holding `list` (indices into recs), on `threads` pool threads; ask(k, lead) gives record k's state and
  // covariance at its epoch + lead hours (TEME), 42 values
  const store = async (list, threads = 0) => {
    const m = await open(wasmPath, threads);
    await m.load(list.map((k) => recs[k]));
    const meta = m.x.sdnap_alloc(64), seriesOf = new Map();
    for (let s = 0; s < list.length; ++s) {
      m.x.sdnap_epochs_series(s, meta, 0, 0);
      seriesOf.set(new Float64Array(m.h.memory.buffer, meta, 1)[0], s);
    }
    const out = m.x.sdnap_alloc(48), st = m.x.sdnap_alloc(4), cov = m.x.sdnap_alloc(288);
    return (k, lead) => {
      const s = seriesOf.get(ocmOf(recs[k]).METADATA.NORAD_CAT_ID), ms = t0s[k] + lead * 3600000, [w, f] = jd(ms);
      if (m.x.sdnap_epochs_at(w, f, s, 1, 0, out, st, cov) !== 0 || new Int32Array(m.h.memory.buffer, st, 1)[0] !== 0) throw new Error(`${MIX[k][0]} at ${lead} h`);
      return [...new Float64Array(m.h.memory.buffer, out, 6), ...new Float64Array(m.h.memory.buffer, cov, 36)];
    };
  };
  const all = [...recs.keys()];
  const ref = [];
  for (const k of all) {
    const ask = await store([k]);
    ref[k] = LEADS.map((L) => ask(k, L));
  }
  const compare = (label, got) => {
    let differ = 0, worst = "";
    for (const k of all)
      LEADS.forEach((L, j) => {
        if (!same(got[k][j], ref[k][j])) { ++differ; worst ||= `${MIX[k][0]} at ${L} h`; }
      });
    check(differ === 0, `covariance rule, ${label}: ${differ} of ${all.length * LEADS.length} states with covariance differ from each record alone (first: ${worst})`);
  };
  for (const [label, order, threads] of [["in turn", all, 0], ["in reverse turn", [...all].reverse(), 0], ["in turn on 4 threads", all, 4]]) {
    const ask = await store(all, threads), got = all.map(() => []);
    LEADS.forEach((L, j) => { for (const k of order) got[k][j] = ask(k, L); });
    compare(label, got);
  }
  {
    let s = 20261111;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    const pairs = all.flatMap((k) => LEADS.map((_, j) => [k, j]));
    for (let q = pairs.length - 1; q > 0; --q) { const p = Math.floor(rnd() * (q + 1)); [pairs[q], pairs[p]] = [pairs[p], pairs[q]]; }
    const ask = await store(all), got = all.map(() => []);
    for (const [k, j] of pairs) got[k][j] = ask(k, LEADS[j]);
    compare("shuffled", got);
  }
  // the smallest case of stack #491: the 815 km record's covariance asked at lead 2 h, then the 500 km record's
  {
    const ask = await store([1, 0]);
    ask(1, 2);
    const got = ask(0, 1), want = ref[0][0];
    const sig = (v) => 1000 * Math.sqrt(v[6] + v[13] + v[20]);
    check(same(got, want), `covariance rule: the 500 km record's covariance after the 815 km record's flown at lead 2 h: position sigma ${sig(got)} m against ${sig(want)} m alone`);
  }
  // fits too: two arcs fitted in either order, each in a fresh instance's sequence, each record byte for byte
  {
    const hx = await createStandaloneHarness("browser", wasmPath, { surface: "command" });
    const hy = await createStandaloneHarness("browser", wasmPath, { surface: "command" });
    const [i, j] = [1, 8];  // the 815 km record and the one-day class at 0.9 rev/day
    const xi = await fitOf(hx, arcs[i]), xj = await fitOf(hx, arcs[j]);
    const yj = await fitOf(hy, arcs[j]), yi = await fitOf(hy, arcs[i]);
    const eq = (p, q) => Buffer.compare(Buffer.from(p), Buffer.from(q)) === 0;
    check(eq(xi, yi) && eq(xj, yj), `fit order: the ${MIX[i][0]} and ${MIX[j][0]} fits in either order give ${eq(xi, yi) ? "the same" : "different"} and ${eq(xj, yj) ? "the same" : "different"} records`);
  }
  console.log(`covariance rule: ${all.length} records with covariance (the catalog mix and three at the third body's builder thresholds) at ${LEADS.length} leads, alone, in turn, in reverse turn, shuffled and on 4 threads, bit for bit; the 500 km record after the 815 km one bit for bit`);
}

if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  console.log(`SET-CACHES FAIL: ${failures.length} failure(s)`);
  process.exit(1);
}
console.log("SET-CACHES PASS: an AP state and its covariance are functions of the set and the time alone");
process.exit(0);

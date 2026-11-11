#!/usr/bin/env node
// E2E (sdn-ap 0.6.14, stack issues #398 and #420): an AP state is a function of its set and its time alone.
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
// and on 4 threads, bit for bit (the transfer and Molniya orbits left out: stack #424).
// Through `propagate` (#420): a time asked alone against the same time inside one call of 2,016 states, bit for bit.
// JS moves bytes and compares numbers the module produced.
//   node test/set-caches.e2e.mjs
import * as flatbuffers from "flatbuffers";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { F107DataType } from "spacedatastandards.org/lib/js/OCM/F107DataType.js";
import { OEM } from "spacedatastandards.org/lib/js/OEM/OEM.js";
import { PCFT } from "spacedatastandards.org/lib/js/PCF/PCF.js";
import { PCFOutputT } from "spacedatastandards.org/lib/js/PCF/PCFOutput.js";
import { pcfOutputFrame } from "spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js";
import { ensureBuilt, wasmPath, elementRows, THEORY } from "./lib/module.mjs";
import { buildDiagnostic } from "./lib/ap-diagnostic.mjs";
import { T, seedOcm, rowsThrough, repackOcm } from "./lib/ocm.mjs";
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
  'SDNAP_EXPORT("sdnap_test_init_rows") int32_t sdnap_test_init_rows(const sdnap::ElementRow* rows, uint32_t count) { return sdnap::store_init(rows, count); }');
const tiny = await open(testBuild);
tiny.x.sdnap_test_cache_budget(1);
check(tiny.stats()[0] === 2 ** 20 && shipped.stats()[0] === 256 * 2 ** 20, `budgets: the test build ${tiny.stats()[0]}, the shipped default ${shipped.stats()[0]}`);
check(shipped.x.sdnap_test_cache_budget === undefined && shipped.x.sdnap_cache_budget === undefined, "the shipped build exports a budget setter");

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
  const fly = async (threads) => {
    const m = await open(testBuild, threads);
    m.x.sdnap_test_select_ap(31, 20);
    const bytes = elementRows(rows), n = rows.length;
    const p = m.x.sdnap_alloc(bytes.length);
    new Uint8Array(m.h.memory.buffer, p, bytes.length).set(bytes);
    check(m.x.sdnap_init_elements(p, n) === n, `${threads} threads: the row store took ${n} rows`);
    const out = m.x.sdnap_alloc(48 * n), status = m.x.sdnap_alloc(4 * n), all = [];
    for (let k = 0; k < 20; ++k) {
      check(m.x.sdnap_propagate_soa(2461328.5, 0.5 + 0.25 * k, 0, n, 0, out, status) === 0, `${threads} threads: sdnap_propagate_soa`);
      all.push(...new Float64Array(m.h.memory.buffer, out, 6 * n), ...new Int32Array(m.h.memory.buffer, status, n));
    }
    return all;
  };
  const zero = await fly(0), four = await fly(4);
  const differ = zero.filter((v, k) => !Object.is(v, four[k])).length;
  check(zero.length === four.length && differ === 0, `the pool's threads: ${differ} of ${zero.length} values differ between 0 and 4 threads`);
  console.log(`1,000 AP rows of the catalog mix through sdnap_propagate_soa: 0 and 4 pool threads bit for bit (${zero.length} values)`);
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

if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  console.log(`SET-CACHES FAIL: ${failures.length} failure(s)`);
  process.exit(1);
}
console.log("SET-CACHES PASS: an AP state is a function of its set and its time alone");
process.exit(0);

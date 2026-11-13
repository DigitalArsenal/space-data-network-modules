#!/usr/bin/env node
// E2E: an AP state is a function of its set and its time alone, whatever the set was asked before and wherever its caches
// live. The reference is a COLD set asked exactly once: a fresh module instance, the record loaded, one state (so no cache,
// set's or thread's, holds anything of an earlier ask); every reference is asserted to be a state (status 0, finite
// numbers). The same states are then asked on a fresh instance of the set after other asks, and every double and status
// compared with Object.is:
// - this checkout's sources built here (the set's own caches) and a test build at a 1 MB cache budget with forty other sets flown first
//   (the set has no room: it flies on the thread's caches), the sets of the pool-less epoch store (sdnap_epochs_set_at);
// - orders: ascending, descending, two shuffles, the negative side then the positive, the positive then the negative;
// - mirrored pairs at fractions q of the first bracket on both sides of the epoch (-qH then +qH, +qH then -qH), at node
//   times (+-H, +-2H), at the epoch and one millisecond either side of it;
// - the store's blend of two sets of one series (sdnap_epochs_at), asked in orders, against the same asked once cold;
// - the decaying set past its decay crossing: refused with status 4 (decayed), cold and after other asks;
// - the two mechanisms of the defect this test was written for, each put back in a build of this checkout's sources: the
//   bracket's id and the drag-pass segment's key. Each build must fail the mirrored pairs, and the id build must give the
//   two first brackets one id where this checkout's sources give two.
// Sets: 500 and 830 km, half-day class at e 0.005 and 0.02, the 8 h and 16 h classes, geosynchronous with and without
// tesseral 31, e 0.1 and 0.25, a transfer orbit, a Molniya orbit, a decaying set. H is the first bracket's length on
// each side of the epoch (a test-build probe reads it). The caches' purity is a property of the module's sources, so
// the builds are made from this checkout. The test-build probe also counts the calls of drag_pass_rates whose window did
// not hold the time just bracketed (one thread flies a set at a time, so it is 0).
// A full run builds 4 modules (about 12 s each) and opens about 1,850 module instances (a fresh instance takes
// milliseconds); it measured 72 s on one busy core.
//   node test/state-purity.e2e.mjs
// STATE_PURITY_AS_0_6_56=1 runs it on this checkout's sources with the two mechanisms put back (it fails, printing for each
// set how far the second state of a pair is from the cold set: the sizes by class of the defect); STATE_PURITY_DECAY_BTERM=b
// sets the decaying set's BTERM (its size follows the drag).
// Control and partial runs: STATE_PURITY_PATCH names a module whose default export maps source file names to text
// transforms (a control build: one mechanism changed at a time), applied to every build; STATE_PURITY_SETS=a,b limits the
// sets to those names (a substring each); STATE_PURITY_QUICK=1 asks fewer fractions. Such a run is partial: it says so and
// exits 1 unless STATE_PURITY_PARTIAL=1 is set.
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { F107DataType } from "spacedatastandards.org/lib/js/OCM/F107DataType.js";
import { buildDiagnostic } from "./lib/ap-diagnostic.mjs";
import { T, seedOcm, rowsThrough } from "./lib/ocm.mjs";
import { pathToFileURL } from "node:url";
import path from "node:path";

const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };
// STATE_PURITY_JSON=file: every run's outcome (set, mode, what was asked, states differing, of how many, the largest in meters)
const runs = [];
const note = (set, mode, label, differ, of, maxM) => runs.push({ set, mode, label, differ, of, maxM: maxM === Infinity ? "status" : maxM });
const DAY = 86400000, MIN = 60000, EPOCH = Date.parse("2026-06-15T00:00:00Z"), MU = 398600.4418, RE = 6378.137;
const iso = (ms) => new Date(ms).toISOString().replace("Z", "");
const revPerDay = (a) => (Math.sqrt(MU / a ** 3) * 86400) / (2 * Math.PI);
const ROWS = Array.from({ length: 60 }, (_, k) => ({ DATE: iso(EPOCH + (k - 5) * DAY).slice(0, 10), F107_OBS: 70, F107_OBS_CENTER81: 72, AP_AVG: 4, F107_DATA_TYPE: F107DataType.OBS }));
const QUICK = !!process.env.STATE_PURITY_QUICK;
const ORBITS = {
  "500 km": { n: revPerDay(RE + 500), e: 0.001, i: 97.4, bterm: 3.8e-3, tesseral: 31 },
  "830 km": { n: revPerDay(RE + 830), e: 0.001, i: 98.7, bterm: 1.27e-3, tesseral: 31 },
  "half-day e 0.005": { n: 2.0056, e: 0.005, i: 55, bterm: 0.001, tesseral: 31 },
  "half-day e 0.02": { n: 2.0056, e: 0.02, i: 55, bterm: 0.001, tesseral: 31 },
  "8 h class": { n: 3.0, e: 0.01, i: 55, bterm: 0.001, tesseral: 31 },
  "16 h class": { n: 1.5, e: 0.01, i: 55, bterm: 0.001, tesseral: 31 },
  "GEO, tesseral 31": { n: 1.0027, e: 0.0003, i: 0.05, bterm: 0.001, tesseral: 31 },
  "GEO, no tesseral": { n: 1.0027, e: 0.0003, i: 0.05, bterm: 0.001, tesseral: 0 },
  "e 0.1": { n: revPerDay((RE + 600) / 0.9), e: 0.1, i: 65, bterm: 1.27e-3, tesseral: 31 },
  "e 0.25": { n: revPerDay((RE + 600) / 0.75), e: 0.25, i: 65, bterm: 1.27e-3, tesseral: 31 },
  "transfer orbit": { n: 2.26, e: 0.72, i: 27, bterm: 1.27e-3, tesseral: 31 },
  Molniya: { n: 2.006, e: 0.74, i: 63.4, bterm: 1.27e-3, tesseral: 0 },
  // perigee 200 km, BTERM 0.01: its crossing is days out; the asks here are hours either side of the epoch
  "decaying set": { n: revPerDay((RE + 200) / (1 - 0.001)), e: 0.001, i: 55, bterm: Number(process.env.STATE_PURITY_DECAY_BTERM ?? 0.01), tesseral: 31 },
};
const recordOf = (o, k, opts) => seedOcm({ epoch: iso(opts?.epochMs ?? EPOCH), n: o.n, e: o.e, i: o.i, raan: (60 + 3.3 * k) % 360, argp: 90, ma: (10 + 7.1 * k) % 360,
  bterm: o.bterm, agom: 0.01, norad: opts?.norad ?? 80000 + k, name: `P${opts?.norad ?? 80000 + k}`, msis: o.jxx !== true, records: o.jxx !== true, rows: rowsThrough(ROWS), tesseral: o.tesseral, zonal: o.zonal ?? 20 });
const prefixed = (u) => { const b = Buffer.alloc(4 + u.length); b.writeUInt32LE(u.length, 0); Buffer.from(u).copy(b, 4); return b; };
const jd = (ms) => { const d = ms / DAY; return [Math.floor(d) + 2440587.5, d - Math.floor(d)]; };
const same = (a, b) => a.length === b.length && a.every((v, q) => Object.is(v, b[q]));
let seed = 20261113;
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const shuffle = (a) => { const s = a.slice(); for (let i = s.length - 1; i > 0; --i) { const j = Math.floor(rand() * (i + 1)); [s[i], s[j]] = [s[j], s[i]]; } return s; };

const swap = (from, to) => (t) => { const at = t.indexOf(from); if (at < 0 || t.indexOf(from, at + 1) >= 0) throw new Error(`patch: not exactly once: ${from.slice(0, 80)}`); return t.replace(from, () => to); };
// the two mechanisms as they were before the fix: the bracket's id from the lower node's index alone, and the drag-pass segment
// found by the lower node's time alone
const OLD_ID = swap("static_cast<uint32_t>(std::min(lo.index, hi.index));", "static_cast<uint32_t>(lo.index);");
const OLD_DRAG_KEY = swap("c.node_t[q] == lo.t && c.hi_t[q] == hi.t &&", "c.node_t[q] == lo.t &&");
// STATE_PURITY_AS_0_6_56=1: this checkout's sources with both put back (the module of release 0.6.56 in behavior): the test then fails
// and prints, per set, how far a state asked after another on the other side of the epoch is from the cold set
const PATCH = process.env.STATE_PURITY_AS_0_6_56 ? { "xp_theory.inc": (t) => OLD_DRAG_KEY(OLD_ID(t)) }
  : process.env.STATE_PURITY_PATCH ? (await import(pathToFileURL(path.resolve(process.env.STATE_PURITY_PATCH)).href)).default : {};
const patchTheory = PATCH["xp_theory.inc"] ?? ((s) => s);
const patchOthers = Object.fromEntries(Object.entries(PATCH).filter(([f]) => f !== "xp_theory.inc"));
// the module as it ships (the checkout's dist, or this checkout's sources with the patch) and a test build that adds the
// cache budget setter and a read-only probe of the tesseral anchor
// (always built here: the checkout's dist is the last release's artifact, which a source change does not rebuild)
const shippedFile = buildDiagnostic("state-purity-ship", "", patchTheory, patchOthers);
// the probe: the last bracket the module anchored the tesseral caches on (its nodes' indexes and times), as set_sp_anchor
// is called with it (the state's own output scope restores the anchor before the call returns)
// ([5] is the low 32 bits of the id the build computed for the bracket: the set's context is the high part, the same for both)
const probeSeam = (text) => {
  const head = "inline void set_sp_anchor(const XpSat& s, const Node& lo, const Node& hi) {\n";
  if (!text.includes(head)) throw new Error("set_sp_anchor not found for the test probe");
  const withHead = text.replace(head, `inline thread_local double g_test_anchor[6] = {};\n${head}  g_test_anchor[0] = 1; g_test_anchor[1] = lo.index; g_test_anchor[2] = hi.index; g_test_anchor[3] = lo.t; g_test_anchor[4] = hi.t;\n`);
  const idLine = /(  const uint64_t id = [^;]*;\n)/;
  if (!idLine.test(withHead)) throw new Error("the anchor's id line not found for the test probe");
  return withHead.replace(idLine, "$1  g_test_anchor[5] = static_cast<double>(static_cast<uint32_t>(id));\n");
};
const PROBE_EXPORTS =
  'SDNAP_EXPORT("sdnap_test_cache_budget") uint32_t sdnap_test_cache_budget(uint32_t mb) { return sdnap::xpt::cache_budget_mb(mb); }\n' +
  'SDNAP_EXPORT("sdnap_test_anchor") void sdnap_test_anchor(double* o) { for (int k = 0; k < 6; ++k) o[k] = sdnap::xpt::g_test_anchor[k]; }\n' +
  'SDNAP_EXPORT("sdnap_test_drag_pass_misses") double sdnap_test_drag_pass_misses() { return static_cast<double>(sdnap::xpt::g_drag_pass_window_misses); }\n';
const probeFile = buildDiagnostic("state-purity-probe", PROBE_EXPORTS, (s) => probeSeam(patchTheory(s)), patchOthers);
let instances = 0;
const startedAt = Date.now();

async function open(file, { budgetMb = 0 } = {}) {
  ++instances;
  const h = await createStandaloneHarness("browser", file, { surface: "direct", maxThreads: 1, enableBrowserWasiThreads: false });
  const x = h.instance.exports;
  const out = x.sdnap_alloc(48 * 4), probe = x.sdnap_alloc(48);
  const mem = () => new Float64Array((h.memory ?? x.memory).buffer);
  if (budgetMb > 0) x.sdnap_test_cache_budget(budgetMb);
  return {
    h, x,
    load: async (records) => {
      const r = await h.invoke({ methodId: "load_epochs", inputs: [{ portId: "ocm", typeRef: T("OCM"), payload: Buffer.concat(records.map(prefixed)) }] });
      if (r.statusCode !== 0) throw new Error(`load_epochs ${r.errorCode}: ${r.errorMessage}`);
    },
    // a state of set k of series i: the status then the six doubles
    at: (i, k, ms) => { const [w, f] = jd(ms); const rc = x.sdnap_epochs_set_at(i, k, w, f, out); return [rc, ...Array.from(mem().subarray(out / 8, out / 8 + 6))]; },
    // the store's selection and blend of series i
    blend: (i, ms) => { const [w, f] = jd(ms); const st = x.sdnap_alloc(4); const rc = x.sdnap_epochs_at(w, f, i, 1, 0, out, st, 0); const s = new Int32Array((h.memory ?? x.memory).buffer, st, 1)[0]; x.sdnap_free(st);
      const o = mem(); return [rc, s, ...[0, 1, 2, 3, 4, 5].map((c) => o[out / 8 + c])]; },
    // sdnap_cache_stats: [0] budget, [1] bytes held, [2] sets with caches, [3] with tesseral caches, [4] reclaimed, [5] and [6] asks refused room (flown on the thread's)
    stats: () => { const p = x.sdnap_alloc(64); x.sdnap_cache_stats(p); const o = Array.from(mem().subarray(p / 8, p / 8 + 8)); x.sdnap_free(p); return o; },
    anchor: () => { x.sdnap_test_anchor?.(probe); return Array.from(mem().subarray(probe / 8, probe / 8 + 6)); },
    misses: () => (x.sdnap_test_drag_pass_misses ? x.sdnap_test_drag_pass_misses() : null),
    series: (i) => { const p = x.sdnap_alloc(24); x.sdnap_epochs_series(i, p, 0, 0); const o = Array.from(mem().subarray(p / 8, p / 8 + 3)); x.sdnap_free(p); return o; },
  };
}
const asked = async (file, records, fn, opts) => { const m = await open(file, opts); await m.load(records); return fn(m); };
const cold = (file, records, i, k, ms) => asked(file, records, (m) => m.at(i, k, ms));
const coldBlend = (file, records, i, ms) => asked(file, records, (m) => m.blend(i, ms));
// a reference is a state: set_at's status 0 and six finite doubles; the blend's call status 0 and series status 0 and six finite doubles
const isState = (a) => a[0] === 0 && a.slice(1).every(Number.isFinite);
const isBlend = (a) => a[0] === 0 && a[1] === 0 && a.slice(2).every(Number.isFinite);
const sizeM = (a, b) => (a[0] !== b[0] ? Infinity : Math.max(...[1, 2, 3].map((c) => Math.abs(a[c] - b[c]))) * 1000);
const fmt = (m) => (m === Infinity ? "status" : m >= 1 ? `${m.toFixed(1)} m` : `${(m * 1e6).toFixed(1)} um`);

const filter = (process.env.STATE_PURITY_SETS ?? "").split(",").filter(Boolean);
const names = Object.keys(ORBITS).filter((n) => !filter.length || filter.some((f) => n.includes(f)));
const FRACTIONS = QUICK ? [0.1, 0.5, 0.9] : [0.02, 0.1, 0.25, 0.5, 0.75, 0.98];
const summary = [];
const kept = new Map();
const compared = new Map();  // per set, the states compared with their cold reference

for (const name of names) {
  const o = ORBITS[name];
  const rec = recordOf(o, 0);
  // the first bracket on each side of the epoch (minutes), by the anchor the module leaves after a state a minute out
  // (the nodes of the first bracket start at the epoch: asked at a few minutes, then farther out, until the module's
  // anchor names a bracket whose first time is the epoch's)
  const pm = await asked(probeFile, [rec], (m) => {
    const side = (dir) => { for (const min of [10, 30, 60, 120, 300, 600, 1200, 2400]) { m.at(0, 0, EPOCH + dir * min * MIN); const a = m.anchor(); if (a[0] === 1 && a[3] === 0) return a; } return [0, 0, 0, 0, 0]; };
    return { f: side(1), b: side(-1) };
  });
  const Hf = Math.abs(pm.f[4] - pm.f[3]), Hb = Math.abs(pm.b[4] - pm.b[3]);
  // the bracket before and the bracket after the epoch have the epoch as their lower node (index 0 both); the ids this build
  // computes for them (low 32 bits): two on the fixed sources, one in the control build that puts the lower node's index back
  const idAfter = pm.f[5], idBefore = pm.b[5];
  check(pm.f[1] === 0 && pm.b[1] === 0, `${name}: the first brackets' lower nodes are not the epoch (indexes ${pm.f[1]} and ${pm.b[1]})`);
  if (!Object.keys(PATCH).length) check(idAfter !== idBefore, `${name}: the brackets after and before the epoch have one id (${idAfter})`);
  const ms = (min) => EPOCH + Math.round(min * MIN);
  const times = [];
  const pairs = [];
  for (const q of FRACTIONS) { times.push(ms(-q * Hb), ms(q * Hf)); pairs.push([ms(-q * Hb), ms(q * Hf)]); }
  for (const k of QUICK ? [1] : [1, 2]) { times.push(ms(-k * Hb), ms(k * Hf)); pairs.push([ms(-k * Hb), ms(k * Hf)]); }
  times.push(EPOCH, EPOCH + 1, EPOCH - 1); pairs.push([EPOCH - 1, EPOCH + 1], [EPOCH, EPOCH + 1], [EPOCH + 1, EPOCH]);
  const uniq = [...new Set(times)];
  // the reference: each time asked once on a cold instance
  const ref = new Map();
  for (const t of uniq) ref.set(t, await cold(shippedFile, [rec], 0, 0, t));
  check([...ref.values()].every(isState), `${name}: a cold reference is not a state (status 0 and six finite numbers)`);
  check(Hf > 0 && Hb > 0, `${name}: the probe found no first bracket on one side of the epoch (${Hf} min after, ${Hb} min before)`);
  check(uniq.length >= 10, `${name}: ${uniq.length} distinct times asked`);
  kept.set(name, { rec, ref, probeMin: Math.min(Hf, Hb) / 2, mirrored: FRACTIONS.filter((q) => q === 0.1 || q === 0.5).flatMap((q) => [ms(-q * Hb), ms(q * Hf)]).concat([EPOCH - 1, EPOCH + 1]) });
  // a time-ordered flight across the epoch (what a catalog set asked at a clock time before and then past its epoch does): 300 states
  // from one first bracket before the epoch to one after it, in time order; every 12th state after the crossing is compared with its cold state
  const flight = Array.from({ length: 300 }, (_, k) => ms(-Hb + (k + 0.5) * (Hb + Hf) / 300));
  const flightSamples = flight.filter((t, k) => t > EPOCH && k % 12 === 0);
  for (const t of flightSamples) if (!ref.has(t)) { ref.set(t, await cold(shippedFile, [rec], 0, 0, t)); check(isState(ref.get(t)), `${name}: a cold reference of the flight is not a state`); }
  check(flightSamples.length >= 10, `${name}: ${flightSamples.length} states of the flight compared after the crossing`);
  const orders = {
    "flight across the epoch, every state in time order": flight,
    ascending: [...uniq].sort((p, q) => p - q), descending: [...uniq].sort((p, q) => q - p), "shuffled 1": shuffle(uniq), "shuffled 2": shuffle(uniq),
    "negative side then positive": [...uniq].sort((p, q) => (p < EPOCH) !== (q < EPOCH) ? (p < EPOCH ? -1 : 1) : p - q),
    "positive side then negative": [...uniq].sort((p, q) => (p < EPOCH) !== (q < EPOCH) ? (p < EPOCH ? 1 : -1) : q - p),
  };
  const report = { shipped: {}, thread: {} };
  const worst = { shipped: 0, thread: 0 };
  // the thread's caches: a 1 MB budget with forty other sets flown first, which hold all the room; set 0 is asked after
  const fillers = Array.from({ length: 40 }, (_, k) => recordOf(ORBITS["500 km"], 100 + k));
  const modes = [["shipped", shippedFile, 0, []], ["thread", probeFile, 1, fillers]];
  for (const [mode, file, budgetMb, others] of modes) {
    const run = async (label, times_) => {
      const m = await open(file, { budgetMb });
      await m.load([rec, ...others]);
      // the target is the series with the smallest NORAD (80000); the fillers' NORADs are 80100 and up
      let idx = 0;
      for (let i = 0; i < others.length + 1; ++i) if (m.series(i)[0] === 80000) idx = i;
      for (let j = 0; j < others.length + 1; ++j) if (j !== idx) m.at(j, 0, EPOCH + DAY);
      let differ = 0, maxM = 0;
      let nCompared = 0;
      for (const t of times_) { const got = m.at(idx, 0, t), r = ref.get(t); check(isState(got), `${name}, ${mode} caches, ${label}: a state asked is not a state (status ${got[0]})`); if (r === undefined) continue; ++nCompared; if (!same(got, r)) { ++differ; maxM = Math.max(maxM, sizeM(got, r)); } }
      compared.set(name, (compared.get(name) ?? 0) + nCompared);
      const missed = m.misses();
      if (missed !== null) check(missed === 0, `${name}, ${mode} caches, ${label}: ${missed} calls of drag_pass_rates whose window did not hold the time just bracketed (one thread flies a set at a time: 0 expected)`);
      report[mode][label] = { differ, of: times_.length, maxM };
      // the mode is what it says: with room the set's asks use its own caches (none refused), at 1 MB behind forty other sets some are on the thread's
      const refused = m.stats()[5] + m.stats()[6];
      check(mode === "thread" ? refused > 0 : refused === 0, `${name}, ${mode} caches, ${label}: ${refused} asks on the thread's caches (${mode === "thread" ? "some" : "none"} expected)`);
      note(name, mode, label, differ, times_.length, maxM);
      worst[mode] = Math.max(worst[mode], maxM);
      check(differ === 0, `${name}, ${mode} caches, ${label}: ${differ} of ${times_.length} states differ from the cold set asked once (largest ${fmt(maxM)})`);
    };
    for (const [label, order] of Object.entries(orders)) await run(label, order);
    for (const [a, b] of pairs) {
      const rel = (t) => ((t - EPOCH) / MIN).toFixed(3);
      await run(`pair ${rel(a)} then ${rel(b)} min`, [a, b]);
      await run(`pair ${rel(b)} then ${rel(a)} min`, [b, a]);
    }
  }
  // the store's blend of two sets of one series: the second set is one day later, so its switch (the midpoint of the epochs) is
  // twelve hours out and the blend, half an hour either side of it, asks the later set twelve hours before its own epoch
  const second = recordOf({ ...o }, 1, { epochMs: EPOCH + DAY, norad: 80000 });
  const blendTimes = [11.5, 11.9, 12, 12.1, 12.5, 18, 24, 24.2, 30, 35].map((h) => EPOCH + Math.round(h * 60 * MIN));
  const blendRef = new Map();
  for (const t of blendTimes) blendRef.set(t, await coldBlend(shippedFile, [rec, second], 0, t));
  check([...blendRef.values()].every(isBlend), `${name}: a cold blend reference is not a state (call and series status 0, six finite numbers)`);
  const blendOrders = { ascending: [...blendTimes].sort((p, q) => p - q), descending: [...blendTimes].sort((p, q) => q - p), shuffled: shuffle(blendTimes) };
  let blendWorst = 0;
  for (const [mode, file, budgetMb, others] of modes) {
    for (const [label, order] of Object.entries(blendOrders)) {
      const m = await open(file, { budgetMb });
      await m.load([rec, second, ...others]);
      let idx = 0;
      for (let i = 0; i < others.length + 1; ++i) if (m.series(i)[0] === 80000) idx = i;
      for (let j = 0; j < others.length + 1; ++j) if (j !== idx) m.at(j, 0, EPOCH + DAY);
      let differ = 0, maxM = 0;
      for (const t of order) { const got = m.blend(idx, t), r = blendRef.get(t); check(isBlend(got), `${name}, ${mode} caches, blend ${label}: a state asked is not a state`); compared.set(name, (compared.get(name) ?? 0) + 1); if (!same(got, r)) { ++differ; maxM = Math.max(maxM, got[0] !== r[0] || got[1] !== r[1] ? Infinity : Math.max(...[2, 3, 4].map((c) => Math.abs(got[c] - r[c]))) * 1000); } }
      blendWorst = Math.max(blendWorst, maxM);
      note(name, mode, `blend ${label}`, differ, order.length, maxM);
      check(differ === 0, `${name}, ${mode} caches, the store's blend of two sets, ${label}: ${differ} of ${order.length} states differ from the cold store asked once (largest ${fmt(maxM)})`);
    }
  }
  const fails = (mode) => Object.values(report[mode]).filter((r) => r.differ > 0).length, total = (mode) => Object.keys(report[mode]).length;
  summary.push({ name, Hf, Hb, idAfter, idBefore, shipped: `${fails("shipped")}/${total("shipped")} runs differ, largest ${fmt(worst.shipped)}`, thread: `${fails("thread")}/${total("thread")} runs differ, largest ${fmt(worst.thread)}`, blend: fmt(blendWorst) });
  console.log(`${name}: first bracket ${Hf.toFixed(1)} min after the epoch and ${Hb.toFixed(1)} min before (both start at the epoch; ids ${idAfter} and ${idBefore}); ${compared.get(name)} states compared; own caches ${summary.at(-1).shipped}; thread caches ${summary.at(-1).thread}; blend largest ${summary.at(-1).blend}`);
}

if (names.includes("decaying set")) {
  // a set past its decay crossing is refused by name (status 4, decayed), cold and after other asks, on both kinds of caches
  const rec = recordOf(ORBITS["decaying set"], 0), late = EPOCH + 200 * 60 * MIN;
  const coldLate = await cold(shippedFile, [rec], 0, 0, late);
  check(coldLate[0] === 4, `decaying set at 200 h, cold: status ${coldLate[0]}, expected 4 (decayed)`);
  for (const [mode, file, budgetMb, others] of [["own", shippedFile, 0, []], ["thread", probeFile, 1, Array.from({ length: 40 }, (_, k) => recordOf(ORBITS["500 km"], 100 + k))]]) {
    const m = await open(file, { budgetMb }); await m.load([rec, ...others]);
    let idx = 0; for (let i = 0; i < others.length + 1; ++i) if (m.series(i)[0] === 80000) idx = i;
    const before = m.at(idx, 0, EPOCH + 2 * 60 * MIN), refused = m.at(idx, 0, late), after = m.at(idx, 0, EPOCH - 2 * 60 * MIN);
    check(isState(before) && isState(after), `decaying set, ${mode} caches: the states before and after the crossing's ask are not states`);
    check(refused[0] === 4, `decaying set at 200 h after other asks, ${mode} caches: status ${refused[0]}, expected 4 (decayed)`);
    check(same(before, await cold(shippedFile, [rec], 0, 0, EPOCH + 2 * 60 * MIN)) && same(after, await cold(shippedFile, [rec], 0, 0, EPOCH - 2 * 60 * MIN)), `decaying set, ${mode} caches: a state asked around the refused ask differs from the cold state`);
  }
  console.log("decaying set past its crossing: refused with status 4 cold and after other asks, own and thread caches; the states asked around the refusal equal their cold states");
}
if (!Object.keys(PATCH).length) {
  // the control builds: each of the two mechanisms of the fix put back as it was in 0.6.56, one at a time, in a build of this
  // checkout's sources. Each must fail this test where it is the cause: the mirrored pairs (the first bracket's 0.1 and 0.5 on both sides,
  // either order) of the sets named, against the cold references made on the fixed build above
  const controls = [
    ["the bracket id of 0.6.56 (the lower node's index: one id for the brackets before and after the epoch)", OLD_ID, ["500 km", "half-day e 0.005", "e 0.1", "transfer orbit"]],
    ["the drag-pass key of 0.6.56 (the lower node's time alone)", OLD_DRAG_KEY, ["Molniya", "transfer orbit"]],
  ];
  let controlRuns = 0;
  for (const [what, transform, setNames] of controls) {
    const file = buildDiagnostic("state-purity-control", PROBE_EXPORTS, (s) => probeSeam(transform(s)));
    for (const name of setNames) {
      const k = kept.get(name);
      if (!k) continue;
      ++controlRuns;
      let differ = 0;
      if (what.startsWith("the bracket id")) {
        // the control build gives the two first brackets one id (the fixed sources gave two: asserted above)
        const ids = await asked(file, [k.rec], (m) => { const side = (dir) => { m.at(0, 0, EPOCH + dir * k.probeMin * MIN); return m.anchor()[5]; }; return [side(1), side(-1)]; });
        check(ids[0] === ids[1], `control build, ${what}: ${name}: the brackets after and before the epoch have ids ${ids[0]} and ${ids[1]}, expected one`);
      }
      const [a, b, c, d, e, f] = k.mirrored;
      for (const order of [[a, b], [b, a], [c, d], [d, c], [e, f], [f, e]]) {
        const m = await open(file); await m.load([k.rec]);
        for (const t of order) if (!same(m.at(0, 0, t), k.ref.get(t))) ++differ;
      }
      check(differ > 0, `control build, ${what}: ${name}'s mirrored pairs all equal the cold set, so this test does not see the mechanism`);
      console.log(`control, ${what}: ${name}: ${differ} of 12 states of the mirrored pairs differ from the cold set`);
    }
  }
  check(controlRuns === 6, `${controlRuns} control runs, expected 6 (four sets on the id build, two on the drag-pass build)`);
}
{
  // the cache budget (a measurement once reported medium-orbit series moving at 18 h and 30 h at a 1 MB budget): a hundred series of two sets
  // of the half-day class, 36 hours apart (the switch is 18 h out, the blend's midpoint), asked at 18 h then 30 h, series by series, in a
  // store at the default budget and in one at 1 MB; each against the other and against the series alone in a cold store
  const N = QUICK ? 24 : 100;
  let bs = 20261113;
  const br = () => ((bs = (bs * 1664525 + 1013904223) >>> 0) / 4294967296);
  const shapes = Array.from({ length: N }, () => ({ n: 1.9 + 0.35 * br(), e: 0.001 + 0.05 * br() ** 2, i: 30 + 50 * br(), bterm: 0.001, tesseral: 31 }));
  const orbit = (k) => shapes[k];
  const first = (k) => recordOf(orbit(k), k, { norad: 90000 + k }), later = (k) => recordOf(orbit(k), k + 1, { epochMs: EPOCH + 36 * 60 * MIN, norad: 90000 + k });
  const records = Array.from({ length: N }, (_, k) => [first(k), later(k)]).flat();
  const asks = [EPOCH + 18 * 60 * MIN, EPOCH + 30 * 60 * MIN];
  const flyAll = async (file, budgetMb) => {
    const m = await open(file, { budgetMb });
    await m.load(records);
    const index = new Map(); for (let i = 0; i < N; ++i) index.set(m.series(i)[0], i);
    const out = [];
    for (let k = 0; k < N; ++k) out.push(asks.map((t) => m.blend(index.get(90000 + k), t)));
    return out;
  };
  const wide = await flyAll(shippedFile, 0), narrow = await flyAll(probeFile, 1);
  let budgetDiffer = 0, wideCold = 0, narrowCold = 0, worstBudget = 0, worstCold = 0;
  for (let k = 0; k < N; ++k) {
    const coldSeries = asks.map((t) => null);
    for (let a = 0; a < asks.length; ++a) {
      const m = await open(shippedFile); await m.load([first(k), later(k)]);
      coldSeries[a] = m.blend(0, asks[a]);
      check(isBlend(coldSeries[a]) && isBlend(wide[k][a]) && isBlend(narrow[k][a]), `two-set series ${k} at ask ${a}: a state asked is not a state`);
      if (!same(wide[k][a], narrow[k][a])) { ++budgetDiffer; worstBudget = Math.max(worstBudget, Math.max(...[2, 3, 4].map((c) => Math.abs(wide[k][a][c] - narrow[k][a][c]))) * 1000); }
      if (!same(wide[k][a], coldSeries[a])) { ++wideCold; worstCold = Math.max(worstCold, Math.max(...[2, 3, 4].map((c) => Math.abs(wide[k][a][c] - coldSeries[a][c]))) * 1000); }
      if (!same(narrow[k][a], coldSeries[a])) ++narrowCold;
    }
  }
  check(budgetDiffer === 0, `${N} two-set half-day series at 18 h and 30 h: ${budgetDiffer} of ${2 * N} states differ between a 1 MB budget and the default (largest ${fmt(worstBudget)})`);
  check(wideCold === 0 && narrowCold === 0, `${N} two-set half-day series at 18 h and 30 h: ${wideCold} (default budget) and ${narrowCold} (1 MB) of ${2 * N} states differ from the series alone in a cold store (largest at the default ${fmt(worstCold)})`);
  note("budget series", "both", "18 h and 30 h", budgetDiffer, 2 * N, worstBudget);
  console.log(`budget: ${N} two-set half-day series, ${budgetDiffer} of ${2 * N} states differ between 1 MB and the default budget (largest ${fmt(worstBudget)}); against the series alone: ${wideCold} at the default, ${narrowCold} at 1 MB`);
}
{
  // the same, as the issue states it: two hundred single-set series of one medium-orbit shape (n 2.0056 rev/day, e 0.005, 55 degrees, the
  // phases and the mean motion varying a little), each asked at 18 h and 30 h from its epoch, series by series and then time by time
  // (every series at 18 h, then every series at 30 h); the default budget and 1 MB; each against the set alone in a cold store
  const N = QUICK ? 40 : 200;
  let bs = 20261114;
  const br = () => ((bs = (bs * 1664525 + 1013904223) >>> 0) / 4294967296);
  const variant = process.env.STATE_PURITY_VARIANT ? JSON.parse(process.env.STATE_PURITY_VARIANT) : {};
  const shapes = Array.from({ length: N }, () => ({ n: 2.0056 + 0.002 * (br() - 0.5), e: 0.005 + 0.002 * (br() - 0.5), i: 55 + 2 * (br() - 0.5), bterm: 0.001, tesseral: 31, ...variant }));
  const records = shapes.map((o, k) => recordOf(o, k, { norad: 91000 + k }));
  const asks = [EPOCH + 18 * 60 * MIN, EPOCH + 30 * 60 * MIN];
  const fly = async (file, budgetMb, timeMajor) => {
    const m = await open(file, { budgetMb });
    await m.load(records);
    const index = new Map(); for (let i = 0; i < N; ++i) index.set(m.series(i)[0], i);
    const out = Array.from({ length: N }, () => []);
    if (timeMajor) for (const t of asks) for (let k = 0; k < N; ++k) out[k].push(m.at(index.get(91000 + k), 0, t));
    else for (let k = 0; k < N; ++k) for (const t of asks) out[k].push(m.at(index.get(91000 + k), 0, t));
    return out;
  };
  const cold = [];
  for (let k = 0; k < N; ++k) { cold.push([]); for (const t of asks) cold[k].push(await asked(shippedFile, [records[k]], (m) => m.at(0, 0, t))); }
  check(cold.flat().every(isState), "a cold single-set reference of the medium-orbit series is not a state");
  for (const [label, file, mb] of [["default budget", shippedFile, 0], ["1 MB", probeFile, 1]]) for (const timeMajor of [false, true]) {
    const got = await fly(file, mb, timeMajor);
    check(got.flat().every(isState), `${label}: a state asked of the medium-orbit series is not a state`);
    let differ = 0, series = 0, worst = 0;
    for (let k = 0; k < N; ++k) { let any = false; got[k].forEach((g, a) => { if (!same(g, cold[k][a])) { ++differ; any = true; worst = Math.max(worst, sizeM(g, cold[k][a])); } }); if (any) ++series; }
    check(differ === 0, `${N} medium-orbit series at ${label}, asked ${timeMajor ? "time by time" : "series by series"} at 18 h and 30 h: ${differ} states of ${series} series differ from the set alone in a cold store (largest ${fmt(worst)})`);
    note("medium-orbit series", label, timeMajor ? "time by time" : "series by series", differ, 2 * N, worst);
    console.log(`${N} medium-orbit series, ${label}, ${timeMajor ? "time by time" : "series by series"}: ${differ} states of ${series} series differ from the set alone (largest ${fmt(worst)})`);
  }
}
// every set was flown and compared; a partial run (a set filter, a patched build, the quick fractions) says so
const partial = filter.length > 0 || Object.keys(PATCH).length > 0 || QUICK;
if (!partial) {
  check(names.length === Object.keys(ORBITS).length && summary.length === names.length, `${summary.length} of ${Object.keys(ORBITS).length} sets flown`);
  for (const n of names) check((compared.get(n) ?? 0) >= 200, `${n}: ${compared.get(n) ?? 0} states compared, at least 200 expected`);
}
if (process.env.STATE_PURITY_JSON) (await import("node:fs")).writeFileSync(process.env.STATE_PURITY_JSON, JSON.stringify({ sets: summary, runs }, null, 1));
if (failures.length) {
  console.error(`STATE PURITY: ${failures.length} failing checks`);
  const shown = process.env.STATE_PURITY_ALL ? failures.length : 60;
  for (const f of failures.slice(0, shown)) console.error(`  ${f}`);
  if (failures.length > shown) console.error(`  ... and ${failures.length - shown} more (STATE_PURITY_ALL=1 lists them all)`);
  process.exit(1);
}
const total = [...compared.values()].reduce((s, n) => s + n, 0);
const tail = `${names.length} sets, ${total} states (each equal to the cold set asked once, bit for bit) over orders, pairs, node times, thread caches and blend; ${instances} module instances, ${Math.round((Date.now() - startedAt) / 1000)} s`;
if (partial) {
  console.log(`STATE PURITY (PARTIAL RUN: set filter, patched build or quick fractions): ${tail}`);
  process.exit(process.env.STATE_PURITY_PARTIAL === "1" ? 0 : 1);
}
console.log(`STATE PURITY: ${tail}`);

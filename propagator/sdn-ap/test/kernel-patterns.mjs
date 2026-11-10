#!/usr/bin/env node
// AP's cost against SGP4's and stock SGP4XP's under the request patterns of review 0's cost findings (stack issue #317;
// C2-1 to C2-5), on made-up orbits: AP seeded with the headline forces (zonal 20, tesseral 31 at e 0.048 and below,
// NRLMSISE-00 on made-up quiet rows), SGP4 through ingest_omm and SGP4XP with its own forces, the same elements.
// Microseconds of process CPU per state (wall for single calls), the three interleaved, median [min, max] over --rounds; a
// ratio taken round by round also carries the 95 % bootstrap interval of its median. The load average before and after
// goes to the output.
//   catalog   N records of one orbit (RAAN and mean anomaly spread) in one store, every record at each instant (time-major,
//             sdnap_epochs_at, 60 s instants over a day from a day after the epochs, fresh store each round) and the same
//             states record-major (sdnap_epochs_set_at); N from --counts (default 1,2,100,10000). Regime "mix": the
//             first N sets of the carrier lane's catalog mix (mixElements)
//   first     the first state of a record at 0, 1 and 7 days: in a fresh instance (what a process pays once and the
//             record pays), in a warmed instance (what each record pays), and the record's load with it
//   order     one record, 7 days at 300 s: ascending, a fixed random order, alternating between the ends
//   ecc       a low orbit (perigee 600 km, i 65) at e 0 to 0.3 across 0.05, 300 s ascending over 7 days, and its first state
//   call      the public `propagate`: TEME START/STOP/STEP and GCRF explicit EPOCHS, 7 days at 300 s, $OEM bytes; the AP
//             record seeded (no covariance) and fitted to the SGP4 track (carrying COVARIANCE_DATA)
//   node test/kernel-patterns.mjs <catalog|first|order|ecc|call|all> [--wasm FILE] [--rounds 7] [--counts 1,2,100,10000]
//     [--regimes leo500,leo830,meo,geo,gto,mix] [--json FILE]
import fs from "node:fs";
import os from "node:os";
import * as flatbuffers from "flatbuffers";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { OMM } from "spacedatastandards.org/lib/js/OMM/OMM.js";
import { F107DataType } from "spacedatastandards.org/lib/js/OCM/F107DataType.js";
import { wasmPath as defaultWasm } from "./lib/module.mjs";
import { T, seedOcm, rowsThrough, spwStream } from "./lib/ocm.mjs";
import { configuration, MSIS_FORCES } from "./lib/pcf.mjs";
import { pcfWeatherSource } from "spacedatastandards.org/lib/js/PCF/pcfWeatherSource.js";

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const MODE = process.argv[2] ?? "all";
const WASM = arg("--wasm", defaultWasm);
const ROUNDS = Number(arg("--rounds", 7));
const COUNTS = arg("--counts", "1,2,100,10000").split(",").map(Number);
const JSON_OUT = arg("--json", null);
const DAY = 86400000, EPOCH = Date.parse("2026-06-15T00:00:00Z"), MU = 398600.4418, RE = 6378.137;
const iso = (ms) => new Date(ms).toISOString().replace("Z", "");
const revPerDay = (a) => (Math.sqrt(MU / a ** 3) * 86400) / (2 * Math.PI);
const ORBITS = {
  leo500: { n: revPerDay(RE + 500), e: 0.001, i: 97.4, raan: 120, argp: 90, ma: 10, bterm: 3.8e-3, agom: 0.01 },
  leo830: { n: revPerDay(RE + 830), e: 0.001, i: 98.7, raan: 120, argp: 90, ma: 10, bterm: 1.27e-3, agom: 0.01 },
  meo: { n: 2.0056, e: 0.005, i: 55, raan: 60, argp: 40, ma: 10, bterm: 0.001, agom: 0.01 },
  geo: { n: 1.0027, e: 0.0003, i: 0.05, raan: 80, argp: 10, ma: 10, bterm: 0.001, agom: 0.01 },
  gto: { n: 2.26, e: 0.72, i: 27, raan: 60, argp: 180, ma: 10, bterm: 1.27e-3, agom: 0.01 },
};
// "mix" (catalog only): the carrier lane's catalog mix (mixElements)
const PICK = arg("--regimes", "leo500,leo830,meo,geo,gto,mix").split(",");
const ROWS = Array.from({ length: 46 }, (_, k) => ({ DATE: iso(EPOCH + (k - 5) * DAY).slice(0, 10), F107_OBS: 70, F107_OBS_CENTER81: 72, AP_AVG: 4, F107_DATA_TYPE: F107DataType.OBS }));
const cpuUs = () => { const u = process.cpuUsage(); return u.user + u.system; };
const wallUs = () => Number(process.hrtime.bigint()) / 1e3;
const median = (a) => { const v = a.toSorted((x, y) => x - y), i = v.length >> 1; return v.length % 2 ? v[i] : (v[i - 1] + v[i]) / 2; };
const spread = (a) => ({ median: median(a), min: Math.min(...a), max: Math.max(...a) });
// a ratio taken round by round: its median, spread and the 95 % percentile-bootstrap interval of the median (2,000
// resamples, fixed seed)
function ratioSpread(a) {
  let s = 12345;
  const r = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const meds = Array.from({ length: 2000 }, () => median(a.map(() => a[Math.floor(r() * a.length)]))).sort((x, y) => x - y);
  return { ...spread(a), ci95: [meds[49], meds[1949]], rounds: a.length };
}
// the 1-minute load average when a row was taken, marked above 30 (such a row is flown again on a quieter machine)
const loadMark = (row) => ` | load ${row.load1.toFixed(0)}${row.load1 > 30 ? " (above 30)" : ""}`;
const fmt = (s, d = 2) => `${s.median.toFixed(d)}${s.ci95 ? ` (95 % ${s.ci95[0].toFixed(d)} to ${s.ci95[1].toFixed(d)})` : ""} [${s.min.toFixed(d)}, ${s.max.toFixed(d)}]`;
const prefixed = (u) => { const b = Buffer.alloc(4 + u.length); b.writeUInt32LE(u.length, 0); Buffer.from(u).copy(b, 4); return b; };
const jd = (ms) => { const d = ms / DAY; return [Math.floor(d) + 2440587.5, d - Math.floor(d)]; };
const grid = (msList) => { const W = new Float64Array(msList.length), F = new Float64Array(msList.length); msList.forEach((ms, k) => { [W[k], F[k]] = jd(ms); }); return { W, F, n: msList.length }; };

function apSet(r, k = 0, tesseral = undefined, norad = 80000 + k) {
  return seedOcm({ epoch: iso(EPOCH), n: r.n, e: r.e, i: r.i, raan: (r.raan + 3.3 * k) % 360, argp: r.argp, ma: (r.ma + 7.1 * k) % 360, bterm: r.bterm, agom: r.agom,
    norad, name: `P${norad - 80000}`, msis: true, records: true, rows: rowsThrough(ROWS), tesseral: tesseral ?? (r.e > 0.048 ? 0 : 31), zonal: 20 });
}
// stock SGP4XP: the same elements, BTERM and AGOM, the theory's own forces
const xpSet = (r, k = 0, norad = 80000 + k) => seedOcm({ epoch: iso(EPOCH), n: r.n, e: r.e, i: r.i, raan: (r.raan + 3.3 * k) % 360, argp: r.argp, ma: (r.ma + 7.1 * k) % 360,
  bterm: r.bterm, agom: r.agom, norad, name: `P${norad - 80000}` });
// the carrier lane's catalog mix (test/segments-bench.mjs on segments-display-prototype, 7cafcc7b): the first N of the same
// seeded sequence: 70 % low orbit (300 to 1,500 km), 10 % MEO, 8 % geosynchronous, 7 % transfer orbits at e 0.5 to 0.75,
// 5 % Molniya, its B; here AP with the headline forces (tesseral 31 at e 0.048 and below), stock SGP4XP and SGP4
function mixElements(N) {
  let seed = 20261110;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const out = [];
  for (let k = 0; k < N; k++) {
    const u = rnd();
    let a, e, i;
    if (u < 0.70) { a = RE + 300 + 1200 * rnd() ** 1.5; e = 0.02 * rnd() ** 2; i = 100 * rnd(); }
    else if (u < 0.80) { a = 26560 + 200 * (rnd() - 0.5); e = 0.02 * rnd(); i = 50 + 10 * rnd(); }
    else if (u < 0.88) { a = 42164 + 50 * (rnd() - 0.5); e = 0.001 * rnd(); i = 15 * rnd(); }
    else if (u < 0.95) { const rp = RE + 250 + 350 * rnd(); e = 0.5 + 0.25 * rnd(); a = rp / (1 - e); i = 7 + 50 * rnd(); }
    else { a = 26560; e = 0.70 + 0.04 * rnd(); i = 63.4; }
    out.push({ n: revPerDay(a), e, i, raan: 360 * rnd(), argp: 360 * rnd(), ma: 360 * rnd(), bterm: a < RE + 2000 ? 0.005 + 0.05 * rnd() : 0.01, agom: 0.01 });
  }
  return out;
}
const THEORIES = ["AP", "XP", "SGP4"];
const turn = (q) => THEORIES.map((_, i) => THEORIES[(i + q) % THEORIES.length]);
const per = () => Object.fromEntries(THEORIES.map((t) => [t, []]));
// AP's cost over SGP4's and over SGP4XP's, round by round
const ratios = (v) => ({ ratio: ratioSpread(v.AP.map((x, i) => x / v.SGP4[i])), ratioXp: ratioSpread(v.AP.map((x, i) => x / v.XP[i])) });
const spreads = (v) => Object.fromEntries(THEORIES.map((t) => [t, spread(v[t])]));
function sgp4Omm(r, k = 0, norad = 80000 + k) {
  const b = new flatbuffers.Builder(256);
  const e = b.createString(iso(EPOCH)), id = b.createString(`2026-${String((norad - 80000) % 1000).padStart(3, "0")}A`), orig = b.createString("SDN");
  OMM.startOMM(b); OMM.addEpoch(b, e); OMM.addObjectId(b, id); OMM.addOriginator(b, orig);
  OMM.addMeanMotion(b, r.n); OMM.addEccentricity(b, r.e); OMM.addInclination(b, r.i); OMM.addRaOfAscNode(b, (r.raan + 3.3 * k) % 360);
  OMM.addArgOfPericenter(b, r.argp); OMM.addMeanAnomaly(b, (r.ma + 7.1 * k) % 360); OMM.addBstar(b, r.bterm / 12.741621); OMM.addNoradCatId(b, norad); OMM.addMeanElementTheory(b, 0);
  OMM.finishOMMBuffer(b, OMM.endOMM(b));
  return b.asUint8Array().slice();
}
async function open() {
  const h = await createStandaloneHarness("browser", WASM, { surface: "direct", maxThreads: 1, enableBrowserWasiThreads: false });
  const x = h.instance.exports;
  const load = async (records) => { const r = await h.invoke({ methodId: "load_epochs", inputs: [{ portId: "ocm", typeRef: T("OCM"), payload: Buffer.concat(records.map(prefixed)) }] }); if (r.statusCode !== 0) throw new Error(`load_epochs ${r.errorCode}: ${r.errorMessage}`); };
  return { h, x, load };
}
/// SGP4 records of `count` sets: of one orbit r (RAAN and mean anomaly spread), or of a list of orbits (the mix).
async function sgp4Sets(helper, r, count) {
  const out = [];
  const omm = (k) => (Array.isArray(r) ? sgp4Omm(r[k], 0, 80000 + k) : sgp4Omm(r, k));
  for (let k = 0; k < count; k += 2000) {
    const omms = Array.from({ length: Math.min(2000, count - k) }, (_, j) => omm(k + j));
    const res = await helper.h.invoke({ methodId: "ingest_omm", inputs: omms.map((payload) => ({ portId: "omm", typeRef: T("OMM"), payload })) });
    if (res.statusCode !== 0) throw new Error(`ingest_omm ${res.errorCode}`);
    out.push(...res.outputs.map((o) => new Uint8Array(o.payload)));
  }
  return out;
}
const result = { wasm: WASM, rounds: ROUNDS };

// ---- catalog: time-major against record-major -----------------------------------------------------------------------
async function catalog(helper) {
  const rows = [];
  const instants = grid(Array.from({ length: 40 }, (_, k) => EPOCH + DAY + k * 60000));
  for (const name of PICK.filter((p) => p !== "gto")) {
    const r = ORBITS[name];
    for (const N of COUNTS) {
      // the mix: set k its own orbit (sgp4Sets takes the list)
      const els = name === "mix" ? mixElements(N) : null;
      const sets = name === "mix"
        ? { AP: els.map((el, k) => apSet(el, 0, undefined, 80000 + k)), XP: els.map((el, k) => xpSet(el, 0, 80000 + k)), SGP4: await sgp4Sets(helper, els, N) }
        : { AP: Array.from({ length: N }, (_, k) => apSet(r, k)), XP: Array.from({ length: N }, (_, k) => xpSet(r, k)), SGP4: await sgp4Sets(helper, r, N) };
      const arms = {};
      for (const theory of THEORIES) arms[theory] = { m: await open(), sets: sets[theory] };
      for (const a of Object.values(arms)) { a.out = a.m.x.sdnap_alloc(48 * N); a.status = a.m.x.sdnap_alloc(4 * N); a.one = a.m.x.sdnap_alloc(48); }
      // time-major: one call per instant over every series, instants 2..40 (the first leaves out each record's start)
      const timeMajor = async (a) => {
        await a.m.load(a.sets);
        a.m.x.sdnap_epochs_at(instants.W[0], instants.F[0], 0, N, 0, a.out, a.status, 0);
        const c0 = cpuUs();
        for (let k = 1; k < 40; ++k) if (a.m.x.sdnap_epochs_at(instants.W[k], instants.F[k], 0, N, 0, a.out, a.status, 0) !== 0) throw new Error("sdnap_epochs_at");
        return (cpuUs() - c0) / (39 * N);
      };
      // record-major: every record over instants 2..40, then the next
      const recordMajor = async (a) => {
        await a.m.load(a.sets);
        for (let i = 0; i < N; ++i) a.m.x.sdnap_epochs_set_at(i, 0, instants.W[0], instants.F[0], a.one);
        const c0 = cpuUs();
        for (let i = 0; i < N; ++i) for (let k = 1; k < 40; ++k) if (a.m.x.sdnap_epochs_set_at(i, 0, instants.W[k], instants.F[k], a.one) !== 0) throw new Error("set_at");
        return (cpuUs() - c0) / (39 * N);
      };
      const rounds = N >= 10000 ? Math.max(3, Math.floor(ROUNDS / 2)) : ROUNDS;
      for (const a of Object.values(arms)) { await timeMajor(a); await recordMajor(a); }
      const t = per(), rm = per();
      for (let q = 0; q < rounds; ++q) for (const theory of turn(q)) { t[theory].push(await timeMajor(arms[theory])); rm[theory].push(await recordMajor(arms[theory])); }
      const row = { orbit: name, records: N, timeMajor: { ...spreads(t), ...ratios(t) }, recordMajor: { ...spreads(rm), ...ratios(rm) } };
      row.load1 = os.loadavg()[0];
      rows.push(row);
      const line = (c) => `AP ${fmt(c.AP, 3)} XP ${fmt(c.XP, 3)} SGP4 ${fmt(c.SGP4, 3)} us/state, AP/SGP4 ${fmt(c.ratio, 1)}, AP/XP ${fmt(c.ratioXp, 1)}`;
      console.log(`catalog ${name} N=${N} | time-major: ${line(row.timeMajor)} | record-major: ${line(row.recordMajor)}${loadMark(row)}`);
    }
  }
  return rows;
}

// ---- first: per process and per record ------------------------------------------------------------------------------
async function first(helper) {
  const rows = [];
  for (const name of PICK.filter((p) => p !== "mix")) {
    const r = ORBITS[name], sets = { AP: [apSet(r)], XP: [xpSet(r)], SGP4: await sgp4Sets(helper, r, 1) };
    for (const days of [0, 1, 7]) {
      const at = jd(EPOCH + days * DAY + (days === 0 ? 60000 : 0));
      const fresh = per(), warm = per(), loaded = per();
      for (let q = 0; q < ROUNDS; ++q)
        for (const theory of turn(q)) {
          const m = await open(), out = m.x.sdnap_alloc(48);
          await m.load(sets[theory]);
          let t0 = wallUs();
          if (m.x.sdnap_epochs_set_at(0, 0, at[0], at[1], out) !== 0) throw new Error("rc");
          fresh[theory].push(wallUs() - t0);
          // the same instance warmed: ten fresh loads flown, then the timed one
          for (let k = 0; k < 10; ++k) { await m.load(sets[theory]); m.x.sdnap_epochs_set_at(0, 0, at[0], at[1], out); }
          await m.load(sets[theory]);
          t0 = wallUs();
          m.x.sdnap_epochs_set_at(0, 0, at[0], at[1], out);
          warm[theory].push(wallUs() - t0);
          // the record's load (load_epochs through the harness) and its first state together
          t0 = wallUs();
          await m.load(sets[theory]);
          m.x.sdnap_epochs_set_at(0, 0, at[0], at[1], out);
          loaded[theory].push(wallUs() - t0);
        }
      const row = { orbit: name, days, freshInstance: spreads(fresh), perRecord: spreads(warm), perRecordWithLoad: spreads(loaded) };
      row.perProcess = Object.fromEntries(THEORIES.map((t) => [t, row.freshInstance[t].median - row.perRecord[t].median]));
      row.perRecordRatio = row.perRecord.AP.median / row.perRecord.SGP4.median;
      row.perRecordRatioXp = row.perRecord.AP.median / row.perRecord.XP.median;
      row.load1 = os.loadavg()[0];
      rows.push(row);
      console.log(`first ${name} at ${days} d | fresh instance: AP ${fmt(row.freshInstance.AP, 1)} XP ${fmt(row.freshInstance.XP, 1)} SGP4 ${fmt(row.freshInstance.SGP4, 1)} us | per record (warm instance): AP ${fmt(row.perRecord.AP, 1)} XP ${fmt(row.perRecord.XP, 1)} SGP4 ${fmt(row.perRecord.SGP4, 2)} us, AP/SGP4 ${row.perRecordRatio.toFixed(0)}, AP/XP ${row.perRecordRatioXp.toFixed(1)} | load and first state: AP ${fmt(row.perRecordWithLoad.AP, 0)} XP ${fmt(row.perRecordWithLoad.XP, 0)} SGP4 ${fmt(row.perRecordWithLoad.SGP4, 0)} us | once per process: AP ${row.perProcess.AP.toFixed(0)} XP ${row.perProcess.XP.toFixed(0)} SGP4 ${row.perProcess.SGP4.toFixed(0)} us${loadMark(row)}`);
    }
  }
  return rows;
}

// ---- order: ascending, random, alternating ends ---------------------------------------------------------------------
async function order(helper) {
  const rows = [];
  const seq = Array.from({ length: 2016 }, (_, k) => EPOCH + (k + 1) * 300000);
  let seed = 20261110;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const random = seq.slice();
  for (let k = random.length - 1; k > 0; --k) { const j = Math.floor(rand() * (k + 1)); [random[k], random[j]] = [random[j], random[k]]; }
  const far = [];
  for (let i = 0, j = seq.length - 1; i <= j; ++i, --j) { far.push(seq[i]); if (i !== j) far.push(seq[j]); }
  for (const name of PICK.filter((p) => p !== "mix")) {
    const r = ORBITS[name], arms = {};
    for (const [theory, set] of [["AP", apSet(r)], ["XP", xpSet(r)], ["SGP4", (await sgp4Sets(helper, r, 1))[0]]]) { const m = await open(); await m.load([set]); arms[theory] = { m, out: m.x.sdnap_alloc(48) }; }
    for (const [label, list] of [["ascending", seq], ["random", random], ["ends", far]]) {
      const g = grid(list);
      const sweep = (a) => { const c0 = cpuUs(); for (let k = 0; k < g.n; ++k) if (a.m.x.sdnap_epochs_set_at(0, 0, g.W[k], g.F[k], a.out) !== 0) throw new Error("rc"); return (cpuUs() - c0) / g.n; };
      for (const a of Object.values(arms)) sweep(a);
      const v = per();
      const rounds = name === "gto" && label !== "ascending" ? 3 : ROUNDS;
      for (let q = 0; q < rounds; ++q) for (const theory of turn(q)) v[theory].push(sweep(arms[theory]));
      const row = { orbit: name, order: label, ...spreads(v), ...ratios(v) };
      row.load1 = os.loadavg()[0];
      rows.push(row);
      console.log(`order ${name} ${label} | AP ${fmt(row.AP, 3)} XP ${fmt(row.XP, 3)} SGP4 ${fmt(row.SGP4, 3)} us/state, AP/SGP4 ${fmt(row.ratio, 1)}, AP/XP ${fmt(row.ratioXp, 1)}${loadMark(row)}`);
    }
  }
  return rows;
}

// ---- ecc: across e 0.05 -----------------------------------------------------------------------------------------------
async function ecc(helper) {
  const rows = [];
  const g = grid(Array.from({ length: 2016 }, (_, k) => EPOCH + (k + 1) * 300000));
  for (const e of [0, 0.02, 0.04, 0.048, 0.05, 0.052, 0.06, 0.08, 0.1, 0.15, 0.2, 0.25, 0.3]) {
    const r = { n: revPerDay((RE + 600) / (1 - e)), e, i: 65, raan: 60, argp: 180, ma: 10, bterm: 1.27e-3, agom: 0.01 };  // perigee 600 km
    for (const tesseral of [31, 0]) {
      const arms = {};
      for (const [theory, set] of [["AP", apSet(r, 0, tesseral)], ["XP", xpSet(r)], ["SGP4", (await sgp4Sets(helper, r, 1))[0]]]) { const m = await open(); await m.load([set]); arms[theory] = { m, out: m.x.sdnap_alloc(48), set }; }
      const sweep = (a) => { const c0 = cpuUs(); for (let k = 0; k < g.n; ++k) if (a.m.x.sdnap_epochs_set_at(0, 0, g.W[k], g.F[k], a.out) !== 0) throw new Error("rc"); return (cpuUs() - c0) / g.n; };
      for (const a of Object.values(arms)) sweep(a);
      const v = per();
      for (let q = 0; q < ROUNDS; ++q) for (const theory of turn(q)) v[theory].push(sweep(arms[theory]));
      const firstUs = [];
      const at = jd(EPOCH + DAY);
      for (let q = 0; q < 5; ++q) { await arms.AP.m.load([arms.AP.set]); const t0 = wallUs(); arms.AP.m.x.sdnap_epochs_set_at(0, 0, at[0], at[1], arms.AP.out); firstUs.push(wallUs() - t0); }
      const row = { e, tesseral, ...spreads(v), ...ratios(v), apFirstAt1dUs: spread(firstUs) };
      row.load1 = os.loadavg()[0];
      rows.push(row);
      console.log(`ecc perigee 600 km e ${e} tesseral ${tesseral} | AP ${fmt(row.AP, 3)} XP ${fmt(row.XP, 3)} SGP4 ${fmt(row.SGP4, 3)} us/state, AP/SGP4 ${fmt(row.ratio, 1)}, AP/XP ${fmt(row.ratioXp, 1)} | AP first state at 1 d ${fmt(row.apFirstAt1dUs, 0)} us${loadMark(row)}`);
    }
  }
  return rows;
}

// ---- call: the public propagate ---------------------------------------------------------------------------------------
async function call(helper) {
  const { PCFT } = await import("spacedatastandards.org/lib/js/PCF/PCF.js");
  const { PCFOutputT } = await import("spacedatastandards.org/lib/js/PCF/PCFOutput.js");
  const { pcfOutputFrame } = await import("spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js");
  const pcfBytes = (output) => { const c = new PCFT(); c.OUTPUT = Object.assign(new PCFOutputT(), output); const b = new flatbuffers.Builder(1 << 16); b.finish(c.pack(b), "$PCF"); return b.asUint8Array().slice(); };
  const times = Array.from({ length: 2016 }, (_, k) => iso(EPOCH + (k + 1) * 300000));
  const PCFS = {
    "teme step": pcfBytes({ FRAME: pcfOutputFrame.TEME, START_TIME: times[0], STOP_TIME: times.at(-1), STEP_SECONDS: 300, MAXIMUM_STATES: 3000 }),
    "teme epochs": pcfBytes({ FRAME: pcfOutputFrame.TEME, EPOCHS: times, MAXIMUM_STATES: 3000 }),
    "gcrf step": pcfBytes({ FRAME: pcfOutputFrame.GCRF, START_TIME: times[0], STOP_TIME: times.at(-1), STEP_SECONDS: 300, MAXIMUM_STATES: 3000 }),
    "gcrf epochs": pcfBytes({ FRAME: pcfOutputFrame.GCRF, EPOCHS: times, MAXIMUM_STATES: 3000 }),
  };
  const rows = [];
  for (const name of PICK.filter((p) => p !== "gto" && p !== "mix")) {
    const r = ORBITS[name];
    const sgp4 = (await sgp4Sets(helper, r, 1))[0], seeded = apSet(r);
    // AP fitted to the SGP4 set's own 3-day track at 300 s (GCRF), as the review's harness makes its AP records; the arc
    // ends at the set's epoch, so the fitted record's weather rows begin before the first instant flown
    const arc = await helper.h.invoke({ methodId: "propagate", inputs: [{ portId: "ocm", typeRef: T("OCM"), payload: sgp4 },
      { portId: "configuration", typeRef: T("PCF"), payload: pcfBytes({ FRAME: pcfOutputFrame.GCRF, EPOCHS: Array.from({ length: 865 }, (_, k) => iso(EPOCH - 3 * DAY + k * 300000)), MAXIMUM_STATES: 1000 }) }] });
    if (arc.statusCode !== 0) throw new Error(`arc ${arc.errorCode}`);
    const fit = await helper.h.invoke({ methodId: "fit", inputs: [{ portId: "ephemeris", typeRef: T("OEM"), payload: new Uint8Array(arc.outputs[0].payload) },
      configuration({ theory: "AP", forces: { ...MSIS_FORCES, WEATHER_SOURCE: pcfWeatherSource.RECORDS, HAS_MAXIMUM_TESSERAL_DEGREE: true, MAXIMUM_TESSERAL_DEGREE: 31, HAS_MAXIMUM_DEGREE: true, MAXIMUM_DEGREE: 20 } }),
      { portId: "space_weather", typeRef: T("SPW"), payload: spwStream(rowsThrough(ROWS)) }] });
    if (fit.statusCode !== 0) throw new Error(`fit ${fit.errorCode}: ${fit.errorMessage}`);
    const fitted = new Uint8Array(fit.outputs.find((o) => o.portId === "elements").payload);
    const records = { SGP4: sgp4, "AP seeded": seeded, "AP fitted": fitted };
    for (const [frame, pcf] of Object.entries(PCFS)) {
      const fly = async (ocm) => { const c0 = cpuUs(); const res = await helper.h.invoke({ methodId: "propagate", inputs: [{ portId: "ocm", typeRef: T("OCM"), payload: ocm }, { portId: "configuration", typeRef: T("PCF"), payload: pcf }] }); const us = cpuUs() - c0; if (res.statusCode !== 0) throw new Error(`propagate ${res.errorCode}: ${res.errorMessage}`); return { us: us / 2016, bytes: res.outputs.find((o) => o.portId === "ephemeris").payload.byteLength }; };
      for (const ocm of Object.values(records)) await fly(ocm);
      const v = {}, bytes = {};
      for (let q = 0; q < ROUNDS; ++q) for (const [label, ocm] of Object.entries(records)) { const f = await fly(ocm); (v[label] ??= []).push(f.us); bytes[label] = f.bytes; }
      const row = { orbit: name, frame, usPerState: Object.fromEntries(Object.entries(v).map(([k, a]) => [k, spread(a)])), oemBytes: bytes,
        seededOverSgp4: ratioSpread(v["AP seeded"].map((x, i) => x / v.SGP4[i])), fittedOverSgp4: ratioSpread(v["AP fitted"].map((x, i) => x / v.SGP4[i])) };
      row.load1 = os.loadavg()[0];
      rows.push(row);
      console.log(`call ${name} ${frame} | SGP4 ${fmt(row.usPerState.SGP4, 2)}, AP seeded ${fmt(row.usPerState["AP seeded"], 2)}, AP fitted ${fmt(row.usPerState["AP fitted"], 2)} us/state | AP/SGP4 seeded ${fmt(row.seededOverSgp4, 1)}, fitted ${fmt(row.fittedOverSgp4, 1)} | $OEM bytes SGP4 ${bytes.SGP4}, AP seeded ${bytes["AP seeded"]}, AP fitted ${bytes["AP fitted"]}${loadMark(row)}`);
    }
  }
  return rows;
}

const helper = await open();
result.loadAverage = { before: os.loadavg(), cores: os.cpus().length };
for (const [name, fn] of [["catalog", catalog], ["first", first], ["order", order], ["ecc", ecc], ["call", call]])
  if (MODE === "all" || MODE === name) result[name] = await fn(helper);
result.loadAverage.after = os.loadavg();
console.log(`load average (1, 5, 15 min) before ${result.loadAverage.before.map((x) => x.toFixed(1)).join(", ")}, after ${result.loadAverage.after.map((x) => x.toFixed(1)).join(", ")} on ${result.loadAverage.cores} cores`);
if (JSON_OUT) fs.writeFileSync(JSON_OUT, `${JSON.stringify(result, null, 1)}\n`);
process.exit(0);

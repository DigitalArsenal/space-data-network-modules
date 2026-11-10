#!/usr/bin/env node
// Benchmark (issue 316, SPEC 18): the cost of flying a record that carries its forecast, against an SGP4 record and,
// for reference, the theory (AP: zonal 20, tesseral 31, NRLMSISE-00 on the record's rows), through the same calls of one
// module instance, the kinds alternating round by round. Process CPU per call (user + system), medians over the rounds
// and the 95 % interval of the ratio (2.5th to 97.5th percentile over rounds).
//
// Workloads (load and first state included; each round loads its records fresh into a warm instance):
//   W1  one object, 7 days at 60 s (10,080 states, sdnap_epochs_set_at in order)
//   W2  one object-day at 300 s from a fresh record (288 states)
//   W3  N objects stepped together (default 1,000), 1,440 instants at 60 s (sdnap_epochs_at, time-major)
//   W4  N fresh records, one state each a day from its epoch
// Patterns (per state, the record loaded and warm): in order at 60 s and 300 s; 2, 100 and --many (10,000) records
// interleaved; times in random order; the public call `propagate` in TEME and GCRF; the first state of a fresh record
// (per record in a warm instance, and once per process: a new instance's first load and state).
// Orbits: 500 km, 830 km, 20,200 km, geosynchronous, e 0.1 in low orbit, e 0.72 (perigee 250 km), and the
// eccentricities 0, 0.05, 0.1, 0.3, 0.72, 0.82 at a 600 km perigee for the steady-state row.
// The carried records carry 8 days of a forecast made by the module (a stock SGP4XP set flown at 60 s, 30 s from e 0.3,
// so this script needs nothing else); --records <dir> takes carried records made elsewhere instead (<orbit>.ocm, e.g.
// fitted to FFM's flights: their size, and so the load, is FFM's).
//   node test/carried-cost.mjs [--rounds 15] [--n 1000] [--many 10000] [--orbits leo500,...] [--records dir] [--json out]
//                              [--workloads] [--no-theory]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as flatbuffers from "flatbuffers";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { OCM, OCMT } from "spacedatastandards.org/lib/js/OCM/OCM.js";
import { HeaderT } from "spacedatastandards.org/lib/js/OCM/Header.js";
import { MetadataT } from "spacedatastandards.org/lib/js/OCM/Metadata.js";
import { OCMMeanElementsT } from "spacedatastandards.org/lib/js/OCM/OCMMeanElements.js";
import { PerturbationsT } from "spacedatastandards.org/lib/js/OCM/Perturbations.js";
import { RFMT } from "spacedatastandards.org/lib/js/OCM/RFM.js";
import { RFMUnion } from "spacedatastandards.org/lib/js/OCM/RFMUnion.js";
import { CelestialFrameWrapperT } from "spacedatastandards.org/lib/js/OCM/CelestialFrameWrapper.js";
import { CelestialFrame } from "spacedatastandards.org/lib/js/OCM/CelestialFrame.js";
import { pcfWeatherSource } from "spacedatastandards.org/lib/js/PCF/pcfWeatherSource.js";
import { pcfOutputFrame } from "spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js";
import { wasmPath } from "./lib/module.mjs";
import { seedOcm, rowsThrough, flight, T, repackOcm } from "./lib/ocm.mjs";
import { spwRows } from "./lib/fixture-inputs.mjs";
import { configuration } from "./lib/pcf.mjs";
import { jdOf } from "./lib/frames.mjs";
import { EPOCH, isoAt, revPerDay, fly, forecastOem, fitCarried, harness } from "./lib/carried.mjs";

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const ROUNDS = Number(arg("--rounds", 15)), N = Number(arg("--n", 1000)), MANY = Number(arg("--many", 10000));
const RECORDS = arg("--records", null), JSON_OUT = arg("--json", null);
// --workloads: W1 to W4 only (the patterns, the eccentricity row and the once-per-process costs left out); --no-theory:
// without the theory beside them (its W3 takes minutes a round on eccentric orbits)
const WORKLOADS_ONLY = process.argv.includes("--workloads"), NO_THEORY = process.argv.includes("--no-theory");
const ORBITS = {
  leo500: { a: 6878.137, e: 0.001, i: 97.4 },
  leo830: { a: 7208.137, e: 0.001, i: 98.7 },
  meo: { a: 26560, e: 0.005, i: 55 },
  geo: { a: 42164.2, e: 0.0002, i: 0.05 },
  leoE01: { a: 6978.137 / 0.9, e: 0.1, i: 65 },
  gto: { a: 6628.137 / 0.28, e: 0.72, i: 27 },
};
const ECC = [0, 0.05, 0.1, 0.3, 0.72, 0.82].map((e) => ({ name: `e${e}`, a: 6978.137 / (1 - e), e: e || 0.0005, i: 63 }));
const only = arg("--orbits", null)?.split(",");
const DAY = 86400;
const cpu = () => { const u = process.cpuUsage(); return u.user + u.system; };

// ---- records --------------------------------------------------------------------------------------------------------
const rows = rowsThrough(spwRows({ first: "2026-10-10", days: 60 }).values);
const pack = (t) => { const b = new flatbuffers.Builder(1 << 16); OCM.finishOCMBuffer(b, t.pack(b)); return b.asUint8Array().slice(); };
function sgp4Ocm(o, norad = 90001) {
  const t = new OCMT();
  t.HEADER = Object.assign(new HeaderT(), { CCSDS_OCM_VERS: "3.0", ORIGINATOR: "SDN" });
  t.METADATA = Object.assign(new MetadataT(), { NORAD_CAT_ID: norad, TIME_SYSTEM: "UTC" });
  t.CENTER_NAME = "EARTH";
  t.TRAJ_REF_FRAME = new RFMT(RFMUnion.CelestialFrameWrapper, new CelestialFrameWrapperT(CelestialFrame.TEMEOFDATE), 0, "TEMEOFDATE");
  t.ORB_AVERAGING = "KOZAI";
  t.MEAN_ELEMENTS = Object.assign(new OCMMeanElementsT(), { MEAN_ELEMENT_THEORY: 0, EPOCH, MEAN_MOTION: revPerDay(o.a), ECCENTRICITY: o.e, INCLINATION: o.i,
    RA_OF_ASC_NODE: 40, ARG_OF_PERICENTER: 30, MEAN_ANOMALY: 0, BSTAR: 1e-4 });
  t.PERTURBATIONS = Object.assign(new PerturbationsT(), { GRAVITY_MODEL: "WGS-72", WEATHER_SOURCE: pcfWeatherSource.NONE });
  return pack(t);
}
const apOcm = (o, norad = 90002) => seedOcm({ epoch: EPOCH, n: revPerDay(o.a), e: o.e, i: o.i, raan: 40, argp: 30, ma: 0, bterm: 0.01, agom: 0.01, norad,
  msis: true, records: true, tesseral: 31, zonal: 20, rows });
async function carriedOcm(h, name, o, days = 8) {
  if (days === 8 && RECORDS && fs.existsSync(path.join(RECORDS, `${name}.ocm`))) return new Uint8Array(fs.readFileSync(path.join(RECORDS, `${name}.ocm`)));
  // a stock SGP4XP set's flight over `days` (in TEME; 60 s, 30 s from e 0.3), carried by an SGP4XP fit of it
  const seed = seedOcm({ epoch: EPOCH, n: revPerDay(o.a), e: o.e, i: o.i, raan: 40, argp: 30, ma: 0, bterm: 0.002, agom: 0.01, norad: 90003 });
  const step = o.e >= 0.3 ? 30 : 60;
  const grid = Array.from({ length: (days * DAY) / step + 9 }, (_, k) => (k - 4) * step);
  const states = await fly(h, seed, grid, pcfOutputFrame.TEME);
  return (await fitCarried(h, { ap: false }, forecastOem(states, 12, { norad: 90003, name }), [0, days * DAY])).ocm;
}
/** `count` copies of a record, each its own object (NORAD_CAT_ID 100000 + k), as one frame of size-prefixed records. */
function catalog(bytes, count) {
  const t = OCM.getRootAsOCM(new flatbuffers.ByteBuffer(bytes)).unpack();
  const parts = [];
  for (let k = 0; k < count; k++) {
    t.METADATA.NORAD_CAT_ID = 100000 + k;
    const b = new flatbuffers.Builder(bytes.length + 1024);
    OCM.finishSizePrefixedOCMBuffer(b, t.pack(b));
    parts.push(b.asUint8Array().slice());
  }
  return Buffer.concat(parts);
}

// ---- timing ---------------------------------------------------------------------------------------------------------
const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]; };
const med = (a) => pct(a, 0.5);
function summary(times, kinds, states) {
  const out = {};
  for (const k of kinds) out[k] = { usPerState: +(med(times[k]) / states).toFixed(4), spread: [+(pct(times[k], 0.025) / states).toFixed(4), +(pct(times[k], 0.975) / states).toFixed(4)] };
  for (const k of kinds.filter((q) => q !== "sgp4")) {
    const ratios = times[k].map((v, r) => v / times.sgp4[r]);
    out[`${k}/sgp4`] = { median: +med(ratios).toFixed(3), interval95: [+pct(ratios, 0.025).toFixed(3), +pct(ratios, 0.975).toFixed(3)] };
  }
  return out;
}
/** Rounds of `work(kind)` (CPU microseconds), the kinds alternating, rotating which goes first. */
async function rounds(kinds, work, count = ROUNDS) {
  const times = Object.fromEntries(kinds.map((k) => [k, []]));
  for (let r = 0; r < count; r++) {
    const order = kinds.map((_, j) => kinds[(j + r) % kinds.length]);
    for (const k of order) times[k].push(await work(k));
  }
  return times;
}

const d = await createStandaloneHarness("browser", wasmPath, { surface: "direct" });
const x = d.instance.exports;
const mem = () => d.memory.buffer;
const out = x.sdnap_alloc(48 * Math.max(MANY, N) + 64), status = x.sdnap_alloc(4 * Math.max(MANY, N) + 64);
const load = async (frames) => {
  const r = await d.invoke({ methodId: "load_epochs", inputs: frames.map((payload) => ({ portId: "ocm", typeRef: T("OCM"), payload })) });
  if (r.statusCode !== 0) throw new Error(`load_epochs: ${r.errorCode} ${r.errorMessage}`);
};
const jd0 = jdOf(EPOCH);
const at = (i, s) => x.sdnap_epochs_set_at(i, 0, jd0.whole, jd0.frac + s / DAY, out);
let sink = 0;
const read = () => { sink += new Float64Array(mem(), out, 1)[0]; };

const build = await harness();
// the load average before and after: timings on a busy machine read high and noisy (trust the ratios of kinds that
// alternate in one process, not the microseconds)
const report = { build: wasmPath, rounds: ROUNDS, n: N, machine: `${os.cpus()[0]?.model} x${os.cpus().length}`, loadBefore: os.loadavg().map((v) => +v.toFixed(1)), orbits: {} };
const kinds = NO_THEORY ? ["sgp4", "carried"] : ["sgp4", "carried", "theory"];
for (const [name, o] of Object.entries(ORBITS)) {
  if (only && !only.includes(name)) continue;
  const rec = { sgp4: sgp4Ocm(o), theory: apOcm(o), carried: await carriedOcm(build, name, o) };
  const row = { bytes: Object.fromEntries(kinds.map((k) => [k, rec[k].length])) };
  // W1, W2: one record, loaded fresh each round
  for (const [w, step, span] of [["W1", 60, 7 * DAY], ["W2", 300, DAY]]) {
    const n = Math.round(span / step);
    row[w] = summary(await rounds(kinds, async (k) => {
      const c0 = cpu();
      await load([rec[k]]);
      for (let j = 1; j <= n; j++) { at(0, j * step); read(); }
      return cpu() - c0;
    }), kinds, n);
  }
  // W3, W4: N records (each its own object), loaded fresh each round; the theory's W3 at a third of the rounds (it is slow)
  const cat = Object.fromEntries(kinds.map((k) => [k, catalog(rec[k], N)]));
  row.W4 = summary(await rounds(kinds, async (k) => {
    const c0 = cpu();
    await load([cat[k]]);
    for (let i = 0; i < N; i++) { at(i, DAY); read(); }
    return cpu() - c0;
  }), kinds, N);
  const w3 = async (k) => {
    const c0 = cpu();
    await load([cat[k]]);
    for (let j = 1; j <= 1440; j++) { x.sdnap_epochs_at(jd0.whole, jd0.frac + (j * 60) / DAY, 0, N, 0, out, status, 0); read(); }
    return cpu() - c0;
  };
  row.W3 = summary(await rounds(["sgp4", "carried"], w3), ["sgp4", "carried"], N * 1440);
  if (!NO_THEORY) {
    const t3 = await rounds(["sgp4", "theory"], w3, Math.max(3, Math.round(ROUNDS / 5)));
    row.W3.theory = summary(t3, ["sgp4", "theory"], N * 1440).theory;
    row.W3["theory/sgp4"] = summary(t3, ["sgp4", "theory"], N * 1440)["theory/sgp4"];
  }
  if (WORKLOADS_ONLY) {
    report.orbits[name] = row;
    console.log(JSON.stringify({ orbit: name, ...row }));
    continue;
  }
  // patterns, the record loaded and its first state taken before timing
  const steady = async (k, times) => { await load([rec[k]]); at(0, times[0]); const c0 = cpu(); for (const s of times) { at(0, s); read(); } return cpu() - c0; };
  for (const step of [60, 300]) {
    const times = Array.from({ length: Math.round((7 * DAY) / step) }, (_, j) => (j + 1) * step);
    row[`inOrder${step}`] = summary(await rounds(kinds, (k) => steady(k, times)), kinds, times.length);
  }
  {
    const times = Array.from({ length: 2016 }, (_, j) => (j + 1) * 300);
    let s = 12345;
    for (let j = times.length - 1; j > 0; j--) { s = (s * 1103515245 + 12345) % 2147483648; const q = s % (j + 1); [times[j], times[q]] = [times[q], times[j]]; }
    row.randomOrder = summary(await rounds(kinds, (k) => steady(k, times)), kinds, times.length);
  }
  for (const m of [2, 100]) {
    const cm = Object.fromEntries(kinds.map((k) => [k, catalog(rec[k], m)]));
    row[`interleaved${m}`] = summary(await rounds(kinds, async (k) => {
      await load([cm[k]]);
      x.sdnap_epochs_at(jd0.whole, jd0.frac + 60 / DAY, 0, m, 0, out, status, 0);
      const c0 = cpu();
      for (let j = 2; j <= 1440; j++) { x.sdnap_epochs_at(jd0.whole, jd0.frac + (j * 60) / DAY, 0, m, 0, out, status, 0); read(); }
      return cpu() - c0;
    }, Math.max(5, Math.round(ROUNDS / 3))), kinds, m * 1439);
  }
  // the public call: 2,016 states (7 days at 300 s), TEME and GCRF; the fitted record writes the theory's covariance
  // beside each state (SPEC 12, version 1 of SPEC 18), so the same record without COVARIANCE_DATA is timed beside it
  rec.carriedNoCov = repackOcm(rec.carried, (t) => { Object.assign(t, { COVARIANCE_DATA: [], COV_PROPAGATION: null, COV_PARAMETERS: [], COV_UNITS: [],
    COV_PARAMETER_KINDS: [], COV_REALISM: [], COV_REF_FRAME: null, COV_TYPE: null, COV_SIZE: 6 }); });
  const publicKinds = ["sgp4", "carried", "carriedNoCov", ...(NO_THEORY ? [] : ["theory"])];
  for (const [label, frame] of [["publicTEME", pcfOutputFrame.TEME], ["publicGCRF", pcfOutputFrame.GCRF]]) {
    const req = (k) => flight([rec[k]], { output: { START_TIME: isoAt(300), STOP_TIME: isoAt(7 * DAY), STEP_SECONDS: 300, FRAME: frame } });
    row[label] = summary(await rounds(publicKinds, async (k) => {
      const c0 = cpu();
      const r = await d.invoke({ methodId: "propagate", inputs: req(k) });
      if (r.statusCode !== 0) throw new Error(`propagate ${k}: ${r.errorCode} ${r.errorMessage}`);
      return cpu() - c0;
    }), kinds, 2016);
  }
  // the first state of a fresh record, per record (warm instance): load and one state at 1 and 7 days
  for (const lead of [1, 7]) {
    row[`firstState${lead}d`] = summary(await rounds(kinds, async (k) => { const c0 = cpu(); await load([rec[k]]); at(0, lead * DAY); read(); return cpu() - c0; }), kinds, 1);
  }
  report.orbits[name] = row;
  console.log(JSON.stringify({ orbit: name, ...row }));
}
if (!WORKLOADS_ONLY) {
// interleaved --many records (carried and SGP4: the theory takes minutes per round here), each carrying one day (8 days
// of 10,000 low-orbit records would not fit the module's 4 GiB)
{
  const o = ORBITS.leo500, many = { sgp4: catalog(sgp4Ocm(o), MANY), carried: catalog(await carriedOcm(build, "leo500-1d", o, 1), MANY) };
  const t = await rounds(["sgp4", "carried"], async (k) => {
    await load([many[k]]);
    x.sdnap_epochs_at(jd0.whole, jd0.frac + 60 / DAY, 0, MANY, 0, out, status, 0);
    const c0 = cpu();
    for (let j = 2; j <= 61; j++) { x.sdnap_epochs_at(jd0.whole, jd0.frac + (j * 60) / DAY, 0, MANY, 0, out, status, 0); read(); }
    return cpu() - c0;
  }, Math.max(5, Math.round(ROUNDS / 3)));
  report.interleavedMany = { records: MANY, orbit: "leo500", ...summary(t, ["sgp4", "carried"], MANY * 60) };
  console.log(JSON.stringify({ interleavedMany: report.interleavedMany }));
}
// steady state in order at 60 s by eccentricity (600 km perigee)
report.eccentricity = {};
for (const o of ECC) {
  const rec = { sgp4: sgp4Ocm(o), theory: apOcm(o), carried: await carriedOcm(build, o.name, o) };
  const times = Array.from({ length: 1440 }, (_, j) => (j + 1) * 60);
  const t = await rounds(kinds, async (k) => { await load([rec[k]]); at(0, times[0]); const c0 = cpu(); for (const s of times) { at(0, s); read(); } return cpu() - c0; }, Math.max(5, Math.round(ROUNDS / 3)));
  report.eccentricity[o.name] = summary(t, kinds, times.length);
  console.log(JSON.stringify({ eccentricity: o.name, ...report.eccentricity[o.name] }));
}
// once per process: a new instance's first load and first state (each kind in its own instance)
report.oncePerProcess = {};
for (const k of kinds) {
  const o = ORBITS.leo500, bytes = k === "sgp4" ? sgp4Ocm(o) : k === "theory" ? apOcm(o) : await carriedOcm(build, "leo500", o);
  const c0 = cpu();
  const h = await createStandaloneHarness("browser", wasmPath, { surface: "direct" });
  const c1 = cpu();
  const r = await h.invoke({ methodId: "load_epochs", inputs: [{ portId: "ocm", typeRef: T("OCM"), payload: bytes }] });
  const p = h.instance.exports.sdnap_alloc(64);
  const c2 = cpu();
  h.instance.exports.sdnap_epochs_set_at(0, 0, jd0.whole, jd0.frac + 1, p);
  const c3 = cpu();
  report.oncePerProcess[k] = { instantiateUs: c1 - c0, firstLoadUs: c2 - c1, firstStateUs: c3 - c2, status: r.statusCode };
}
console.log(JSON.stringify({ oncePerProcess: report.oncePerProcess }));
}
report.sink = sink;
report.loadAfter = os.loadavg().map((v) => +v.toFixed(1));
if (JSON_OUT) fs.writeFileSync(JSON_OUT, `${JSON.stringify(report, null, 1)}\n`);
process.exit(0);

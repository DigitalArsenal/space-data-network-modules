#!/usr/bin/env node
// AP's cost per state against SGP4's (stack issues #316, #317), and the output of two builds compared.
//
// Cost: the bare kernel of the resident epoch store. One made-up orbit's AP, SGP4 and SGP4XP sets, each loaded by
// load_epochs into its own instance of the module in this process, sdnap_epochs_set_at called once per state (TEME)
// over a 7-day grid from the epoch at 300 s and at 60 s. The three sweeps are timed interleaved, R repeats, CPU time of
// the process per sweep (a sweep repeated until a block takes 40 ms); the median and the spread (min, max) of the cost
// per state, and of AP / SGP4 taken repeat by repeat. Random access: one cold call (the set freshly loaded) at 1 and 7
// days from the epoch, wall time, median and spread of R loads.
// The sets: AP with the forces of the headline fits (zonal degree 20, tesseral degree 31 up to e 0.048 and none above,
// unless a regime names its tesseral degree; NRLMSISE-00 on $SPW rows the record carries: made-up quiet or active rows),
// SGP4 through ingest_omm (B* = BTERM /
// 12.741621), stock SGP4XP; the same elements, BTERM and AGOM. Made-up orbits only: no catalog data.
//   node test/kernel-cost.mjs [--wasm FILE] [--repeats 5] [--steps 300,60] [--regimes name,...] [--json FILE]
// Output: the largest position and velocity difference between two builds at every state of every regime's AP, SGP4XP
// and SGP4 set over --days (30) at --step (60 s), each build flown in time order; the second build also in reverse
// order and in a shuffled order over --sample (1500) of those states spread over the span (a cache must not make the
// output depend on the order of requests).
//   node test/kernel-cost.mjs --diff BEFORE.wasm [--wasm AFTER.wasm] [--days 30] [--step 60] [--sample 1500] [--json FILE]
//     [--bound M,MPS]: exit 1 when a state in time order differs by more than M meters or MPS m/s, or changes status
import fs from "node:fs";
import * as flatbuffers from "flatbuffers";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { OMM } from "spacedatastandards.org/lib/js/OMM/OMM.js";
import { F107DataType } from "spacedatastandards.org/lib/js/OCM/F107DataType.js";
import { wasmPath as defaultWasm } from "./lib/module.mjs";
import { T, seedOcm, rowsThrough } from "./lib/ocm.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const WASM = arg("--wasm", defaultWasm);
const DIFF = arg("--diff", null);
const REPEATS = Number(arg("--repeats", 5));
const STEPS = arg("--steps", "300,60").split(",").map(Number);
const PICK = arg("--regimes", null)?.split(",");
const JSON_OUT = arg("--json", null);
const DIFF_DAYS = Number(arg("--days", 30));
const DIFF_STEP = Number(arg("--step", 60));
const SAMPLE = Number(arg("--sample", 1500));
const BOUND = arg("--bound", null)?.split(",").map(Number);  // m, m/s: --diff fails when a time-order difference exceeds them

const DAY = 86400000;
const EPOCH = Date.parse("2026-06-15T00:00:00Z");
const iso = (ms) => new Date(ms).toISOString().replace("Z", "");
const MU = 398600.4418, RE = 6378.137;
/** Mean motion (rev/day) of a two-body orbit of semi-major axis a (km). */
const revPerDay = (a) => (Math.sqrt(MU / a ** 3) * 86400) / (2 * Math.PI);
/** Semi-major axis (km) of a period (hours). */
const aOfPeriod = (hours) => Math.cbrt(MU * ((hours * 3600) / (2 * Math.PI)) ** 2);
const circular = (h) => revPerDay(RE + h);

// Made-up orbits. bterm in m^2/kg (B* = bterm / 12.741621), agom in m^2/kg.
const LOW = { low: 2.5e-4, high: 6.4e-3 };
const REGIMES = [];
for (const [h, inc] of [[300, 51.6], [400, 51.6], [500, 97.4], [830, 98.7], [1400, 53.0]])
  for (const drag of ["low", "high"])
    for (const weather of ["quiet", "active"])
      REGIMES.push({ name: `leo-${h}-${drag}-${weather}`, n: circular(h), e: 0.001, i: inc, raan: 120, argp: 90, ma: 10, bterm: LOW[drag], agom: 0.01, weather });
REGIMES.push(
  { name: "meo", n: 2.0056, e: 0.005, i: 55, raan: 60, argp: 40, ma: 10, bterm: 0.001, agom: 0.01, weather: "quiet" },
  { name: "geo", n: 1.0027, e: 0.0003, i: 0.05, raan: 80, argp: 10, ma: 10, bterm: 0.001, agom: 0.01, weather: "quiet" },
  { name: "igso", n: 1.0027, e: 0.002, i: 55, raan: 80, argp: 10, ma: 10, bterm: 0.001, agom: 0.01, weather: "quiet" },
  { name: "gto", n: 2.26, e: 0.72, i: 27, raan: 60, argp: 180, ma: 10, bterm: 1.27e-3, agom: 0.01, weather: "quiet" },
  { name: "gto-active", n: 2.26, e: 0.72, i: 27, raan: 60, argp: 180, ma: 10, bterm: 1.27e-3, agom: 0.01, weather: "active" },
  // the heaviest drag of the set: perigee 250 km, a high drag term, active weather
  { name: "gto-250-high-active", n: 2.26, e: 1 - (RE + 250) / Math.cbrt(MU / ((2.26 * 2 * Math.PI) / 86400) ** 2), i: 27, raan: 60, argp: 180, ma: 10,
    bterm: 0.01, agom: 0.01, weather: "active" },
  { name: "molniya", n: 2.006, e: 0.74, i: 63.4, raan: 300, argp: 270, ma: 10, bterm: 1.27e-3, agom: 0.01, weather: "quiet" },
  // THEMIS-like: period 22.9 h, perigee 900 km
  { name: "themis", n: 24 / 22.9, e: 1 - (RE + 900) / aOfPeriod(22.9), i: 10, raan: 30, argp: 300, ma: 10, bterm: 1.27e-4, agom: 0.01, weather: "quiet" },
  // TESS-like: period 13.7 days, e 0.55
  { name: "tess", n: 1 / 13.7, e: 0.55, i: 40, raan: 30, argp: 120, ma: 10, bterm: 0.001, agom: 0.01, weather: "quiet" },
);
// Low orbits between near-circular and eccentric: perigee 500 km at e 0.05, 0.1 and 0.2, with the headline forces (no
// tesseral terms above e 0.048) and with the tesseral terms to degree 31 (their grid in the eccentric anomaly).
for (const e of [0.05, 0.1, 0.2])
  for (const tesseral of [0, 31])
    REGIMES.push({ name: `leo-e${e}${tesseral ? "-t31" : ""}`, n: revPerDay((RE + 500) / (1 - e)), e, i: 63, raan: 40, argp: 60, ma: 10, bterm: 0.001,
      agom: 0.01, weather: "quiet", tesseral });
const regimes = PICK ? REGIMES.filter((r) => PICK.includes(r.name)) : REGIMES;
if (!regimes.length) throw new Error(`no regime among ${PICK}`);

// Made-up daily $SPW rows from 5 days before the epoch through 40 days after it.
const WEATHER = { quiet: { F107_OBS: 70, F107_OBS_CENTER81: 72, AP_AVG: 4 }, active: { F107_OBS: 210, F107_OBS_CENTER81: 180, AP_AVG: 40 } };
const rowsOf = (weather) => Array.from({ length: 46 }, (_, k) => ({ DATE: iso(EPOCH + (k - 5) * DAY).slice(0, 10), ...WEATHER[weather], F107_DATA_TYPE: F107DataType.OBS }));

function sgp4Omm(r, norad) {
  const b = new flatbuffers.Builder(256);
  const e = b.createString(iso(EPOCH)), id = b.createString("2026-999A"), orig = b.createString("SDN");
  OMM.startOMM(b); OMM.addEpoch(b, e); OMM.addObjectId(b, id); OMM.addOriginator(b, orig);
  OMM.addMeanMotion(b, r.n); OMM.addEccentricity(b, r.e); OMM.addInclination(b, r.i); OMM.addRaOfAscNode(b, r.raan);
  OMM.addArgOfPericenter(b, r.argp); OMM.addMeanAnomaly(b, r.ma); OMM.addBstar(b, r.bterm / 12.741621); OMM.addNoradCatId(b, norad); OMM.addMeanElementTheory(b, 0);
  OMM.finishOMMBuffer(b, OMM.endOMM(b));
  return b.asUint8Array().slice();
}

/** The module at `file` (browser host, direct exports and invoke). */
async function open(file) {
  const h = await createStandaloneHarness("browser", file, { surface: "direct", maxThreads: 1, enableBrowserWasiThreads: false });
  return { h, x: h.instance.exports };
}

/** The three sets of a regime: AP, SGP4XP (seeded) and SGP4 (ingest_omm through `m`). */
async function setsOf(m, r, norad) {
  const epoch = iso(EPOCH);
  const el = { epoch, n: r.n, e: r.e, i: r.i, raan: r.raan, argp: r.argp, ma: r.ma, bterm: r.bterm, agom: r.agom, norad, name: r.name };
  const ap = seedOcm({ ...el, msis: true, records: true, rows: rowsThrough(rowsOf(r.weather)), tesseral: r.tesseral ?? (r.e > 0.048 ? 0 : 31), zonal: 20 });
  const xp = seedOcm(el);
  const ing = await m.h.invoke({ methodId: "ingest_omm", inputs: [{ portId: "omm", typeRef: T("OMM"), payload: sgp4Omm(r, norad) }] });
  if (ing.statusCode !== 0) throw new Error(`ingest_omm ${ing.errorCode}: ${ing.errorMessage}`);
  return { ap, xp, sgp4: new Uint8Array(ing.outputs[0].payload) };
}

/** A loaded set: `at(k)` the state at grid time k (rc), `load()` loads it again (every slot cold). */
async function loaded(file, ocm) {
  const m = await open(file);
  const out = m.x.sdnap_alloc(48);
  const load = async () => {
    const r = await m.h.invoke({ methodId: "load_epochs", inputs: [{ portId: "ocm", typeRef: T("OCM"), payload: ocm }] });
    if (r.statusCode !== 0) throw new Error(`load_epochs ${r.errorCode}: ${r.errorMessage}`);
  };
  await load();
  const set = m.x.sdnap_epochs_set_at;
  return {
    load,
    sweep(W, F) {
      for (let k = 0; k < W.length; ++k) {
        const rc = set(0, 0, W[k], F[k], out);
        if (rc !== 0) throw new Error(`sdnap_epochs_set_at rc ${rc} at state ${k}`);
      }
    },
    state(w, f) {
      const rc = set(0, 0, w, f, out);
      return rc === 0 ? Array.from(new Float64Array(m.h.memory.buffer, out, 6)) : rc;
    },
  };
}

/** The grid: `count` times `step` s apart from one step after the epoch, as split Julian dates. */
function grid(step, count) {
  const W = new Float64Array(count), F = new Float64Array(count);
  for (let k = 0; k < count; ++k) {
    const d = (EPOCH + (k + 1) * step * 1000) / DAY;
    W[k] = Math.floor(d) + 2440587.5;
    F[k] = d - Math.floor(d);
  }
  return { W, F };
}

const cpuUs = () => { const u = process.cpuUsage(); return u.user + u.system; };
const median = (a) => { const v = a.toSorted((x, y) => x - y), i = v.length >> 1; return v.length % 2 ? v[i] : (v[i - 1] + v[i]) / 2; };
const spread = (a) => ({ median: median(a), min: Math.min(...a), max: Math.max(...a) });

async function cost() {
  const helper = await open(WASM);
  const rows = [];
  for (const [q, r] of regimes.entries()) {
    const sets = await setsOf(helper, r, 99000 + q);
    const k = { ap: await loaded(WASM, sets.ap), sgp4: await loaded(WASM, sets.sgp4), xp: await loaded(WASM, sets.xp) };
    const row = { regime: r.name, elements: { n: r.n, e: r.e, i: r.i, bterm: r.bterm, agom: r.agom, weather: r.weather } };
    for (const step of STEPS) {
      const { W, F } = grid(step, (7 * 86400) / step);
      const inner = {};
      for (const [name, set] of Object.entries(k)) {  // a block of at least 40 ms
        set.sweep(W, F);
        let reps = 1;
        for (;;) {
          const c0 = cpuUs();
          for (let i = 0; i < reps; ++i) set.sweep(W, F);
          const us = cpuUs() - c0;
          if (us >= 40000) break;
          reps = Math.max(reps * 2, Math.ceil((reps * 45000) / Math.max(us, 50)));
        }
        inner[name] = reps;
      }
      const per = { ap: [], sgp4: [], xp: [] };
      for (let rep = 0; rep < REPEATS; ++rep)
        for (const [name, set] of Object.entries(k)) {
          const c0 = cpuUs();
          for (let i = 0; i < inner[name]; ++i) set.sweep(W, F);
          per[name].push((cpuUs() - c0) / inner[name] / W.length);  // us per state
        }
      row[`s${step}`] = {
        usPerState: { ap: spread(per.ap), sgp4: spread(per.sgp4), xp: spread(per.xp) },
        apOverSgp4: spread(per.ap.map((a, i) => a / per.sgp4[i])),
        xpOverSgp4: spread(per.xp.map((a, i) => a / per.sgp4[i])),
      };
    }
    row.cold = {};
    for (const lead of [1, 7]) {
      const d = (EPOCH + lead * DAY) / DAY, w = Math.floor(d) + 2440587.5, f = d - Math.floor(d);
      const per = { ap: [], sgp4: [], xp: [] };
      for (let rep = 0; rep < REPEATS; ++rep)
        for (const [name, set] of Object.entries(k)) {
          await set.load();
          const t0 = process.hrtime.bigint();
          const s = set.state(w, f);
          per[name].push(Number(process.hrtime.bigint() - t0) / 1000);
          if (!Array.isArray(s)) throw new Error(`${name} cold call at ${lead} d: rc ${s}`);
        }
      row.cold[`d${lead}`] = { us: { ap: spread(per.ap), sgp4: spread(per.sgp4), xp: spread(per.xp) }, apOverSgp4: median(per.ap) / median(per.sgp4) };
    }
    rows.push(row);
    const f2 = (x) => x.toFixed(2), f3 = (x) => x.toFixed(3);
    const cells = STEPS.map((s) => { const c = row[`s${s}`]; return `${s} s: AP ${f3(c.usPerState.ap.median)} SGP4 ${f3(c.usPerState.sgp4.median)} XP ${f3(c.usPerState.xp.median)} us, AP/SGP4 ${f2(c.apOverSgp4.median)} [${f2(c.apOverSgp4.min)}, ${f2(c.apOverSgp4.max)}]`; });
    const cold = [1, 7].map((d) => { const c = row.cold[`d${d}`]; return `cold ${d} d: AP ${c.us.ap.median.toFixed(0)} SGP4 ${c.us.sgp4.median.toFixed(1)} XP ${c.us.xp.median.toFixed(0)} us`; });
    console.log(`${r.name.padEnd(22)} ${cells.join(" | ")} | ${cold.join(" | ")}`);
  }
  return { mode: "cost", wasm: WASM, repeats: REPEATS, epoch: iso(EPOCH), rows };
}

async function diff() {
  const helper = await open(WASM);
  const count = Math.round((DIFF_DAYS * 86400) / DIFF_STEP);
  const { W, F } = grid(DIFF_STEP, count);
  // reverse and shuffled orders over SAMPLE states spread over the span (each request may integrate the mean elements
  // again from the nearest checkpoint: all of them would cost the square of the count)
  const every = Math.max(1, Math.floor(count / SAMPLE));
  const reversed = Array.from({ length: Math.ceil(count / every) }, (_, k) => k * every).reverse();
  let seed = 12345;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const shuffled = reversed.toReversed();
  for (let k = shuffled.length - 1; k > 0; --k) { const j = Math.floor(rand() * (k + 1)); [shuffled[k], shuffled[j]] = [shuffled[j], shuffled[k]]; }
  const rows = [];
  for (const [q, r] of regimes.entries()) {
    const sets = await setsOf(helper, r, 99000 + q);
    for (const theory of ["ap", "xp", "sgp4"]) {
      const before = await loaded(DIFF, sets[theory]), after = await loaded(WASM, sets[theory]);
      const ref = new Array(count);
      let refused = 0;
      for (let k = 0; k < count; ++k) { ref[k] = before.state(W[k], F[k]); if (!Array.isArray(ref[k])) ++refused; }
      const row = { regime: r.name, theory, states: count, refusedBefore: refused };
      for (const [order, ks] of [["time", null], ["reverse", reversed], ["shuffled", shuffled]]) {
        if (ks) await after.load();
        let dr = 0, dv = 0, mismatch = 0;
        for (let j = 0; j < (ks ? ks.length : count); ++j) {
          const k = ks ? ks[j] : j;
          const s = after.state(W[k], F[k]);
          if (!Array.isArray(s) || !Array.isArray(ref[k])) { if (Array.isArray(s) !== Array.isArray(ref[k]) || s !== ref[k]) ++mismatch; continue; }
          dr = Math.max(dr, Math.hypot(s[0] - ref[k][0], s[1] - ref[k][1], s[2] - ref[k][2]) * 1000);
          dv = Math.max(dv, Math.hypot(s[3] - ref[k][3], s[4] - ref[k][4], s[5] - ref[k][5]) * 1000);
        }
        row[order] = { maxPositionM: dr, maxVelocityMps: dv, statusMismatch: mismatch };
      }
      rows.push(row);
      const c = (o) => `${o} ${row[o].maxPositionM.toExponential(2)} m ${row[o].maxVelocityMps.toExponential(2)} m/s${row[o].statusMismatch ? ` (${row[o].statusMismatch} status differ)` : ""}`;
      console.log(`${r.name.padEnd(22)} ${theory.padEnd(5)} ${c("time")} | ${c("reverse")} | ${c("shuffled")}${refused ? ` | ${refused} refused` : ""}`);
    }
  }
  return { mode: "diff", before: DIFF, after: WASM, days: DIFF_DAYS, step: DIFF_STEP, epoch: iso(EPOCH), rows };
}

const result = DIFF ? await diff() : await cost();
if (JSON_OUT) fs.writeFileSync(JSON_OUT, `${JSON.stringify(result, null, 1)}\n`);
if (DIFF && BOUND) {
  const over = result.rows.filter((r) => r.time.maxPositionM > BOUND[0] || r.time.maxVelocityMps > BOUND[1] || r.time.statusMismatch > 0);
  for (const r of over) console.log(`OVER ${r.regime} ${r.theory}: ${r.time.maxPositionM} m, ${r.time.maxVelocityMps} m/s, ${r.time.statusMismatch} status`);
  console.log(over.length ? `KERNEL-COST DIFF FAIL: ${over.length} of ${result.rows.length} over ${BOUND[0]} m or ${BOUND[1]} m/s` : `KERNEL-COST DIFF PASS: every state of ${result.rows.length} flights within ${BOUND[0]} m and ${BOUND[1]} m/s in time order`);
  process.exit(over.length ? 1 : 0);
}
process.exit(0);

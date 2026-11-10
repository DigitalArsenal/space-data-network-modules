#!/usr/bin/env node
// The GCRF and EME2000 output of `propagate` (stack issue #317; review 0, C2-5): the cost of a state in each frame, and
// with --diff the largest difference between two builds' states in each frame.
// Made-up SGP4 sets (through ingest_omm) in low orbit, medium Earth orbit and at geosynchronous altitude, with epochs
// from 2020 to 2035, each flown 7 days at 60 s from its epoch (START/STOP/STEP) and at 500 random instants of those
// days (explicit EPOCHS), in TEME, GCRF and EME2000. SGP4 is the theory here because its TEME states are the same in
// both builds; the frame alone moves. Process CPU per state, median of --rounds; and per call of one state, each call
// 2 days after the last and past every instant flown before (TEME, and GCRF with its nodes not yet computed).
//   node test/output-frames.mjs [--wasm FILE] [--diff BEFORE.wasm] [--rounds 5] [--json FILE]
// With --diff: the TEME $OEM must be the same bytes in both builds; the largest GCRF and EME2000 position (mm) and
// velocity (mm/s) difference per orbit, and each build's GCRF positions against the reference below; with --bound MM:
// exit 1 when a position differs between the builds by more than MM millimeters.
import fs from "node:fs";
import os from "node:os";
import * as flatbuffers from "flatbuffers";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { OMM } from "spacedatastandards.org/lib/js/OMM/OMM.js";
import { OEM } from "spacedatastandards.org/lib/js/OEM/OEM.js";
import { PCFT } from "spacedatastandards.org/lib/js/PCF/PCF.js";
import { PCFOutputT } from "spacedatastandards.org/lib/js/PCF/PCFOutput.js";
import { pcfOutputFrame } from "spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js";
import { wasmPath as defaultWasm } from "./lib/module.mjs";
import { T } from "./lib/ocm.mjs";

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const WASM = arg("--wasm", defaultWasm);
const DIFF = arg("--diff", null);
const ROUNDS = Number(arg("--rounds", 5));
const JSON_OUT = arg("--json", null);
const BOUND = arg("--bound", null) === null ? null : Number(arg("--bound", null));
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString().replace("Z", "");
const ORBITS = [
  { name: "leo500", n: 15.22, e: 0.001, i: 97.4, raan: 120, argp: 90, ma: 10, bstar: 3e-4 },
  { name: "meo", n: 2.0056, e: 0.005, i: 55, raan: 60, argp: 40, ma: 10, bstar: 0 },
  { name: "geo", n: 1.0027, e: 0.0003, i: 0.05, raan: 80, argp: 10, ma: 10, bstar: 0 },
];
const EPOCHS = ["2020-01-01T00:00:00Z", "2024-06-15T07:30:00Z", "2026-06-15T00:00:00Z", "2030-03-01T13:00:00Z", "2035-09-09T21:45:00Z"].map(Date.parse);
const FRAMES = { TEME: pcfOutputFrame.TEME, GCRF: pcfOutputFrame.GCRF, EME2000: pcfOutputFrame.EME2000 };

function omm(o, epochMs, norad) {
  const b = new flatbuffers.Builder(256);
  const e = b.createString(iso(epochMs)), id = b.createString("2026-001A"), orig = b.createString("SDN");
  OMM.startOMM(b); OMM.addEpoch(b, e); OMM.addObjectId(b, id); OMM.addOriginator(b, orig);
  OMM.addMeanMotion(b, o.n); OMM.addEccentricity(b, o.e); OMM.addInclination(b, o.i); OMM.addRaOfAscNode(b, o.raan);
  OMM.addArgOfPericenter(b, o.argp); OMM.addMeanAnomaly(b, o.ma); OMM.addBstar(b, o.bstar); OMM.addNoradCatId(b, norad); OMM.addMeanElementTheory(b, 0);
  OMM.finishOMMBuffer(b, OMM.endOMM(b));
  return b.asUint8Array().slice();
}
const pcfBytes = (output) => { const c = new PCFT(); c.OUTPUT = Object.assign(new PCFOutputT(), output); const b = new flatbuffers.Builder(1 << 16); b.finish(c.pack(b), "$PCF"); return b.asUint8Array().slice(); };
const open = (file) => createStandaloneHarness("browser", file, { surface: "direct", maxThreads: 1, enableBrowserWasiThreads: false });
const cpuUs = () => { const u = process.cpuUsage(); return u.user + u.system; };
const median = (a) => { const v = a.toSorted((x, y) => x - y), i = v.length >> 1; return v.length % 2 ? v[i] : (v[i - 1] + v[i]) / 2; };
const states = (bytes) => OEM.getRootAsOEM(new flatbuffers.ByteBuffer(bytes)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES;

async function sgp4Set(h, o, epochMs, norad) {
  const r = await h.invoke({ methodId: "ingest_omm", inputs: [{ portId: "omm", typeRef: T("OMM"), payload: omm(o, epochMs, norad) }] });
  if (r.statusCode !== 0) throw new Error(`ingest_omm ${r.errorCode}`);
  return new Uint8Array(r.outputs[0].payload);
}
async function fly(h, ocm, pcf) {
  const c0 = cpuUs();
  const r = await h.invoke({ methodId: "propagate", inputs: [{ portId: "ocm", typeRef: T("OCM"), payload: ocm }, { portId: "configuration", typeRef: T("PCF"), payload: pcf }] });
  const us = cpuUs() - c0;
  if (r.statusCode !== 0) throw new Error(`propagate ${r.errorCode}: ${r.errorMessage}`);
  return { us, bytes: new Uint8Array(r.outputs.find((o) => o.portId === "ephemeris").payload) };
}

const loadBefore = os.loadavg();
const after = await open(WASM), before = DIFF ? await open(DIFF) : null;
// The reference: gcrf.inc's per-state chain, TEME = R3(GAST06 - GMST82) NPB06 GCRF through ERFA (sdnap_frame_probe
// mode 1, TEME -> GCRF), with GMST82 taken in exact rational arithmetic. The module's gmst() sums GMST82 in seconds of
// time near 8e8 s and turns that into radians near 6e4 rad: its angle carries up to about 3e-11 rad of rounding (1.3 mm
// at 42,164 km), with a mean of up to 1e-11 rad. The probe's matrix carries that angle; the reference turns the TEME
// state by R3 of the difference first (gmst() read back from the probe's mode 2, TEME -> Earth-fixed, on a unit vector).
const px = after.instance.exports, pin = px.sdnap_alloc(48), pout = px.sdnap_alloc(48);
const heap = () => new Float64Array((after.memory ?? px.memory).buffer);
function probe(whole, frac, v, mode) {
  const f = heap();
  v.forEach((x, q) => { f[pin / 8 + q] = x; });
  if (px.sdnap_frame_probe(whole, frac, pin, pout, mode) < 0) throw new Error("probe");
  return Array.from(heap().subarray(pout / 8, pout / 8 + 6));
}
const gcd = (a, b) => { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a; };
const Q = (n, d = 1n) => { if (d < 0n) { n = -n; d = -d; } const g = gcd(n, d) || 1n; return { n: n / g, d: d / g }; };
const qadd = (a, b) => Q(a.n * b.d + b.n * a.d, a.d * b.d), qmul = (a, b) => Q(a.n * b.n, a.d * b.d);
const qdec = (s) => { const [i, f = ""] = s.split("."); return Q(BigInt(i + f), 10n ** BigInt(f.length)); };
function qdouble(x) {
  const dv = new DataView(new ArrayBuffer(8)); dv.setFloat64(0, x);
  const bits = dv.getBigUint64(0), sign = bits >> 63n ? -1n : 1n, exp = Number((bits >> 52n) & 0x7ffn), man = bits & ((1n << 52n) - 1n);
  const m = exp === 0 ? man : man | (1n << 52n), e = (exp === 0 ? 1 : exp) - 1075;
  return e >= 0 ? Q(sign * m * (1n << BigInt(e))) : Q(sign * m, 1n << BigInt(-e));
}
// GMST82 (the polynomial of store.inc's gmst(), in seconds of time) at the Julian date whole + frac, exactly, as radians
function gmst82Exact(whole, frac) {
  const T = qmul(qadd(qadd(qdouble(whole), qdec("-2451545")), qdouble(frac)), Q(1n, 36525n));
  const sec = [qdec("67310.54841"), qmul(qdec("3164400184.812866"), T), qmul(qdec("0.093104"), qmul(T, T)), qmul(qdec("-0.0000062"), qmul(T, qmul(T, T)))].reduce(qadd);
  const turns = qmul(sec, Q(1n, 86400n));
  const fracTurns = (((turns.n % turns.d) + turns.d) % turns.d) * 10n ** 30n / turns.d;
  return 2 * Math.PI * (Number(fracTurns) / 1e30);
}
let gmstRounding = 0;  // the largest |gmst() - GMST82| seen, rad
function referenceGcrf(ms, s) {
  const d = ms / DAY, whole = Math.floor(d) + 2440587.5, frac = d - Math.floor(d);
  const e = probe(whole, frac, [1, 0, 0, 0, 0, 0], 2);
  let delta = Math.atan2(-e[1], e[0]) - gmst82Exact(whole, frac);  // gmst() - GMST82
  delta -= 2 * Math.PI * Math.round(delta / (2 * Math.PI));
  gmstRounding = Math.max(gmstRounding, Math.abs(delta));
  // TEME_true = R3(GAST06 - GMST82) NPB06 GCRF = R3(delta) TEME_probe: the probe's TEME is R3(-delta) of the state
  const c = Math.cos(delta), sn = Math.sin(delta);
  const turn = (x, y) => [c * x - sn * y, sn * x + c * y];
  const [x, y] = turn(s.X, s.Y), [vx, vy] = turn(s.X_DOT, s.Y_DOT);
  return probe(whole, frac, [x, y, s.Z, vx, vy, s.Z_DOT], 1);
}
let seed = 20261110;
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const rows = [];
let teme = 0, tested = 0;
for (const o of ORBITS) {
  const row = { orbit: o.name, usPerState: {}, ...(DIFF ? { maxMm: {}, maxMmPerS: {}, maxMmByEpoch: {}, referenceMaxMm: { before: 0, after: 0 } } : {}) };
  const temeStates = {};
  for (const [ei, epochMs] of EPOCHS.entries()) {
    const set = await sgp4Set(after, o, epochMs, 90100 + ei);
    // one state a call, each 2 days after the last and past every instant flown before (the GCRF nodes cold), 2026 epoch
    if (ei === 2)
      for (const frame of ["TEME", "GCRF"])
        for (const [build, h] of DIFF ? [["--wasm", after], ["--diff", before]] : [["--wasm", after]]) {
          const us = [];
          for (let q = 0; q < ROUNDS; ++q)
            us.push((await fly(h, set, pcfBytes({ FRAME: FRAMES[frame], EPOCHS: [iso(epochMs + (10 + 2 * q) * DAY + 1234)], MAXIMUM_STATES: 10 }))).us);
          (row.usOneStateCall ??= {})[`${frame} ${build}`] = median(us);
        }
    const step = Array.from({ length: 7 * 1440 }, (_, k) => iso(epochMs + (k + 1) * 60000));
    const random = [...new Set(Array.from({ length: 500 }, () => epochMs + Math.floor(rand() * 7 * DAY)))].sort((x, y) => x - y).map(iso);
    for (const [frame, f] of Object.entries(FRAMES)) {
      const pcfs = {
        step: pcfBytes({ FRAME: f, START_TIME: step[0], STOP_TIME: step.at(-1), STEP_SECONDS: 60, MAXIMUM_STATES: 20000 }),
        epochs: pcfBytes({ FRAME: f, EPOCHS: random, MAXIMUM_STATES: 20000 }),
      };
      for (const [kind, pcf] of Object.entries(pcfs)) {
        const label = `${frame} ${kind}`;
        if (ei === 2) {  // cost on the 2026 epoch
          await fly(after, set, pcf);
          const us = [];
          for (let q = 0; q < ROUNDS; ++q) us.push((await fly(after, set, pcf)).us / (kind === "step" ? step.length : random.length));
          row.usPerState[label] = median(us);
        }
        if (!DIFF) continue;
        const a = await fly(after, set, pcf), b = await fly(before, set, pcf);
        if (frame === "TEME") {
          ++tested;
          if (Buffer.compare(Buffer.from(a.bytes), Buffer.from(b.bytes)) !== 0) ++teme;
          temeStates[kind] = states(a.bytes);
          continue;
        }
        const sa = states(a.bytes), sb = states(b.bytes);
        let dp = 0, dv = 0;
        for (let k = 0; k < sa.length; ++k) {
          dp = Math.max(dp, Math.hypot(sa[k].X - sb[k].X, sa[k].Y - sb[k].Y, sa[k].Z - sb[k].Z) * 1e6);
          dv = Math.max(dv, Math.hypot(sa[k].X_DOT - sb[k].X_DOT, sa[k].Y_DOT - sb[k].Y_DOT, sa[k].Z_DOT - sb[k].Z_DOT) * 1e6);
        }
        row.maxMm[frame] = Math.max(row.maxMm[frame] ?? 0, dp);
        row.maxMmPerS[frame] = Math.max(row.maxMmPerS[frame] ?? 0, dv);
        const year = new Date(epochMs).getUTCFullYear();
        row.maxMmByEpoch[year] = Math.max(row.maxMmByEpoch[year] ?? 0, dp);
        // both builds against the reference, every 5th state of the GCRF grid flights and every state of the others
        if (frame === "GCRF")
          for (let k = 0; k < sa.length; k += kind === "step" ? 5 : 1) {
            const ref = referenceGcrf(Date.parse(`${temeStates[kind][k].EPOCH}Z`), temeStates[kind][k]);
            const d = (s) => Math.hypot(s.X - ref[0], s.Y - ref[1], s.Z - ref[2]) * 1e6;
            row.referenceMaxMm.after = Math.max(row.referenceMaxMm.after, d(sa[k]));
            row.referenceMaxMm.before = Math.max(row.referenceMaxMm.before, d(sb[k]));
          }
      }
    }
  }
  rows.push(row);
  const cost = Object.entries(row.usPerState).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(", ");
  const diff = DIFF ? ` | largest difference from --diff: GCRF ${row.maxMm.GCRF.toFixed(4)} mm ${row.maxMmPerS.GCRF.toFixed(6)} mm/s, EME2000 ${row.maxMm.EME2000.toFixed(4)} mm ${row.maxMmPerS.EME2000.toFixed(6)} mm/s` +
    ` (by epoch year: ${Object.entries(row.maxMmByEpoch).map(([y, v]) => `${y} ${v.toFixed(3)}`).join(", ")} mm) | GCRF against the reference (GMST82 exact): --diff build ${row.referenceMaxMm.before.toFixed(4)} mm, --wasm build ${row.referenceMaxMm.after.toFixed(4)} mm` : "";
  const one = Object.entries(row.usOneStateCall).map(([k, v]) => `${k} ${v.toFixed(0)}`).join(", ");
  console.log(`${o.name} | us per state: ${cost} | us per one-state call: ${one}${diff}`);
}
if (DIFF) console.log(`TEME $OEM bytes differ in ${teme} of ${tested} flights; gmst() against GMST82 in exact arithmetic at the states checked: up to ${gmstRounding.toExponential(2)} rad (${(gmstRounding * 42164e6).toFixed(3)} mm at 42,164 km)`);
const loadAverage = { before: loadBefore, after: os.loadavg(), cores: os.cpus().length };
console.log(`load average (1, 5, 15 min) before ${loadAverage.before.map((x) => x.toFixed(1)).join(", ")}, after ${loadAverage.after.map((x) => x.toFixed(1)).join(", ")} on ${loadAverage.cores} cores`);
if (JSON_OUT) fs.writeFileSync(JSON_OUT, `${JSON.stringify({ wasm: WASM, diff: DIFF, rounds: ROUNDS, loadAverage, rows, temeFlightsDiffering: DIFF ? teme : undefined, gmstRoundingMaxRad: DIFF ? gmstRounding : undefined }, null, 1)}\n`);
let fail = DIFF && teme > 0;
if (DIFF && BOUND !== null) {
  const worst = Math.max(...rows.flatMap((r) => [r.maxMm.GCRF, r.maxMm.EME2000]));
  console.log(worst > BOUND || teme > 0 ? `OUTPUT-FRAMES DIFF FAIL: ${worst.toFixed(4)} mm over ${BOUND} mm or TEME bytes moved` : `OUTPUT-FRAMES DIFF PASS: every GCRF and EME2000 state within ${BOUND} mm; TEME bytes unchanged`);
  fail = fail || worst > BOUND;
}
process.exit(fail ? 1 : 0);

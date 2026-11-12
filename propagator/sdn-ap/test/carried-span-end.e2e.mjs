#!/usr/bin/env node
// E2E (issue 316, SPEC 18.7): the carried record and its hand-over set. A numerical forecast made by propagator/ffm
// (EGM2008 70 x 70, Sun and Moon from DE440, solar radiation pressure, drag; GCRF every 30 s, 4 days) carries 3 days from
// 6 h after its start (record A: fit with OUTPUT.START_TIME and STOP_TIME); the hand-over set B is fit with
// OUTPUT.START_TIME alone at A's stop. In low orbit (500 km) and at geosynchronous altitude:
// - A's theory is anchored at the span's start, the observation cutoff: its EPOCH and its arc's first state within one
//   step of START_TIME, its arc ending by START_TIME plus 48 h; its covariance smaller at the span's start than at its
//   stop (it grows forward);
// - B is fitted to the forecast's last part: its EPOCH and its arc's last state within one step of the stop, the later
//   states held out; TRAJECTORY_BLOCKS[0] TRAJ_ID "HAND-OVER", USEABLE_START_TIME the stop, no segments; its covariance
//   smaller at the stop than a day later;
// - the steps fit states, theory minus forecast: A's at the start and B's at the stop under 0.1 km in low orbit and 0.02
//   km at geosynchronous altitude; in low orbit, over the forecast's held-out hours after the stop (18 h), B's largest
//   distance to the forecast under a lone A's;
// - A and B in one store: 1 h before the span the theory of A, inside the span the forecast, after the stop B's states
//   (to 1e-5 km of B flown alone); sdnap_epochs_source_at 0, 1, 1, 3, 3; propagate_epochs one block whose SOURCES
//   (SPEC 18.8's grammar) reads THEORY, CARRIED FORECAST, HAND-OVER; at split dates a double step apart about A's
//   stop, sdnap_epochs_at gives A's forecast where sdnap_epochs_source_at says CARRIED FORECAST and B where it says
//   HAND-OVER, switching once (one coverage decision per instant, SPEC 18.3);
// - alone: A after its stop flies its own theory, labeled THEORY; B before its start flies its theory, labeled
//   THEORY, and from its start HAND-OVER.
// Prints each case's steps and covariances.
// JS only moves bytes and compares numbers the modules produced.
//   node test/carried-span-end.e2e.mjs
import fs from "node:fs";
import * as flatbuffers from "flatbuffers";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { OEMT } from "spacedatastandards.org/lib/js/OEM/OEM.js";
import { OCM } from "spacedatastandards.org/lib/js/OCM/OCM.js";
import { CATT } from "spacedatastandards.org/lib/js/OEM/CAT.js";
import { ephemerisDataBlockT } from "spacedatastandards.org/lib/js/OEM/ephemerisDataBlock.js";
import { ephemerisDataLineT } from "spacedatastandards.org/lib/js/OEM/ephemerisDataLine.js";
import { timingStandard } from "spacedatastandards.org/lib/js/OEM/timingStandard.js";
import { pcfOutputFrame } from "spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js";
import { pcfAtmosphereFamily } from "spacedatastandards.org/lib/js/PCF/pcfAtmosphereFamily.js";
import { pcfWeatherSource } from "spacedatastandards.org/lib/js/PCF/pcfWeatherSource.js";
import { OEM } from "spacedatastandards.org/lib/js/OEM/OEM.js";
import { requestFor, decodeResult, decodePrw, encodePrw, makeTable, TYPE } from "../../ffm/tests/lib/prwCodec.mjs";
import { wasmPath } from "./lib/module.mjs";
import { configuration } from "./lib/pcf.mjs";
import { packOem, rfm, jdOf } from "./lib/frames.mjs";
import { T, rowsThrough, spwStream } from "./lib/ocm.mjs";
import { spwConstantText } from "./lib/spw-constant.mjs";
import { oemLines } from "./lib/carried.mjs";

const ffmPath = new URL("../../ffm/dist/isomorphic/module.wasm", import.meta.url).pathname;
const kernel = fs.readFileSync(new URL("../../../files/orbit-products/tests/fixtures/de440/de440-2026.bsp", import.meta.url));
const EPOCH_WHOLE = 2461328.5, BASE_MS = Date.UTC(2026, 9, 15), STEP = 30, DAY = 86400;
const START = 6 * 3600, STOP = START + 3 * DAY;
const REGIMES = [
  { name: "LEO 500 km", a: 6878.137, e: 0.001, i: 97.4, drag: true, stepKm: 0.1 },
  { name: "GEO", a: 42164.2, e: 0.0002, i: 0.05, drag: false, stepKm: 0.02 },
];
function iso(t) {
  const whole = Math.floor(t), ns = Math.round((t - whole) * 1e9);
  const w = ns === 1e9 ? whole + 1 : whole, n = ns === 1e9 ? 0 : ns;
  return `${new Date(BASE_MS + w * 1000).toISOString().slice(0, 19)}.${String(n).padStart(9, "0")}`;
}
const secondsOf = (text) => (Date.parse(`${text.slice(0, 19)}Z`) - BASE_MS) / 1000 + Number(`0${text.slice(19)}`);
const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };
const ap = await createStandaloneHarness("browser", wasmPath, { surface: "direct" });
const x = ap.instance.exports, p = x.sdnap_alloc(512);
const ffm = await createStandaloneHarness("browser", ffmPath, { surface: "command" });

/** FFM's forecast: [{ t, r, v }] GCRF every 30 s for `days`, t its own instants (s from the epoch). */
async function forecast(c, days) {
  new Float64Array(ap.memory.buffer, p, 6).set([c.a, c.e, c.i, 40, 30, 30]);
  if (x.sdnap_state_of_elements(EPOCH_WHOLE, 0, p, 1, p + 48) !== 0) throw new Error(`${c.name}: no state`);
  let state = Array.from(new Float64Array(ap.memory.buffer, p + 48, 6));
  const n = Math.round((days * DAY) / STEP), t0 = (EPOCH_WHOLE - 2440587.5) * 86400000, out = [];
  for (let k0 = 0; k0 < n; k0 += 8000) {  // FFM takes at most 10,000 samples a call
    const k1 = Math.min(n, k0 + 8000);
    const params = {
      epochJD: EPOCH_WHOLE + (k0 * STEP) / DAY, epochTimeScale: "UTC", targetJD: EPOCH_WHOLE + (k1 * STEP) / DAY, targetTimeScale: "UTC",
      position: state.slice(0, 3), velocity: state.slice(3), frame: "GCRF",
      sampleEpochsJD: Array.from({ length: k1 - k0 + 1 }, (_, j) => ({ jd: EPOCH_WHOLE + ((k0 + j) * STEP) / DAY, scale: "UTC" })),
      forces: { gravityMode: "EGM2008", maxDegree: 70, maxOrder: 70, thirdBody: true, srp: true, drag: c.drag, massKg: 1000, areaM2: 10, cd: 2.2 },
      weather: { epochUTCJD: EPOCH_WHOLE, F107: 150, F107a: 150, Ap: 15, Kp: 3 }, integrator: { tolerance: 1e-13, minStep: 0.01, maxStep: 120 },
      ephemerisSource: "JPL_SPK",
    };
    const r = requestFor("propagate", params, kernel);
    r.inputs.push({ portId: "earth_orientation", typeRef: TYPE, payload: encodePrw("EARTH_ORIENTATION", makeTable("PRWEarthOrientation", {
      ROWS: Array.from({ length: days + 5 }, (_, k) => makeTable("EOP", { DATE: new Date(t0 + (k - 2) * DAY * 1000).toISOString(), MJD: EPOCH_WHOLE - 2400000.5 + k - 2, TAI_MINUS_UTC_SECONDS: 37 })),
    })) });
    const res = await ffm.invoke(r);
    if (res.statusCode !== 0) throw new Error(`${c.name}: FFM ${res.errorCode} ${res.errorMessage}`);
    const got = decodeResult(res).samples;
    const labels = decodePrw(res.outputs.find((q) => q.portId === "response").payload).EXECUTION_RESULT.SAMPLES.map((s) => s.STATE.STATE.EPOCH);
    got.forEach((g, j) => { if (k0 === 0 || j > 0) out.push({ label: labels[j], r: g.position, v: g.velocity }); });
    state = [...got.at(-1).position, ...got.at(-1).velocity];
  }
  const split = (label) => { const m = /^(.*T\d\d:\d\d:\d\d)\.(\d+)$/.exec(label); return [Date.parse(`${m[1]}Z`) / 1000, Number(`0.${m[2]}`)]; };
  const [w0, f0] = split(out[0].label);
  return out.map((s) => { const [w, f] = split(s.label); return { t: (w - w0) + (f - f0), r: s.r, v: s.v }; });
}
// AP with zonal 20 and tesseral 31, NRLMSISE-00 on rows of the forecast's own constant weather
const forces = { EPHEMERIS_SOURCE: "", HAS_MAXIMUM_TESSERAL_DEGREE: true, MAXIMUM_TESSERAL_DEGREE: 31, HAS_MAXIMUM_DEGREE: true, MAXIMUM_DEGREE: 20,
  ATMOSPHERE_MODEL: pcfAtmosphereFamily.NRLMSISE00, WEATHER_SOURCE: pcfWeatherSource.RECORDS };
const weather = spwStream(rowsThrough(JSON.parse(spwConstantText("2026-10-20", 45))));
const step = (line) => { const m = /theory minus forecast ([\d.]+) km .*velocity ([\d.]+) mm\/s/.exec(line ?? ""); return m ? { km: Number(m[1]), mmS: Number(m[2]) } : null; };
const fly = async (rec, ts, cov = false) => {
  const r = await ap.invoke({ methodId: "propagate", inputs: [{ portId: "ocm", typeRef: T("OCM"), payload: rec }, configuration({ output: { EPOCHS: ts.map(iso), FRAME: pcfOutputFrame.GCRF } })] });
  if (r.statusCode !== 0) throw new Error(`propagate ${r.errorCode} ${r.errorMessage}`);
  const blocks = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(new Uint8Array(r.outputs[0].payload))).unpack().EPHEMERIS_DATA_BLOCK;
  check(blocks.length === 1, `propagate wrote ${blocks.length} blocks for one record`);
  const lines = oemLines(r.outputs[0].payload);
  return lines.map((l, k) => ({ r: [l.X, l.Y, l.Z], source: l.source, sigmaKm: cov ? Math.sqrt(blocks[0].COVARIANCE_MATRIX_LINES[k].CX_X + blocks[0].COVARIANCE_MATRIX_LINES[k].CY_Y + blocks[0].COVARIANCE_MATRIX_LINES[k].CZ_Z) : NaN }));
};
const hyp = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const rows = [];
for (const c of REGIMES) {
  const states = await forecast(c, 4);
  const lines = states.map((s) => Object.assign(new ephemerisDataLineT(), { EPOCH: iso(s.t), X: s.r[0], Y: s.r[1], Z: s.r[2], X_DOT: s.v[0], Y_DOT: s.v[1], Z_DOT: s.v[2] }));
  const block = Object.assign(new ephemerisDataBlockT(), { OBJECT: Object.assign(new CATT(), { NORAD_CAT_ID: 99410, OBJECT_NAME: c.name }), CENTER_NAME: "EARTH",
    REFERENCE_FRAME: rfm("GCRF"), TIME_SYSTEM: timingStandard.UTC, START_TIME: lines[0].EPOCH, STOP_TIME: lines.at(-1).EPOCH, EPHEMERIS_DATA_LINES: lines });
  const oem = packOem(Object.assign(new OEMT(), { EPHEMERIS_DATA_BLOCK: [block] }));
  const fit = async (output) => {
    const r = await ap.invoke({ methodId: "fit", inputs: [{ portId: "ephemeris", typeRef: T("OEM"), payload: oem }, { portId: "space_weather", typeRef: T("SPW"), payload: weather },
      configuration({ theory: "AP", forces, output })] });
    if (r.statusCode !== 0) throw new Error(`${c.name}: fit ${r.errorCode} ${r.errorMessage}`);
    const rec = new Uint8Array(r.outputs.find((q) => q.portId === "elements").payload);
    return { rec, u: OCM.getRootAsOCM(new flatbuffers.ByteBuffer(rec)).unpack() };
  };
  const A = await fit({ START_TIME: iso(START), STOP_TIME: iso(STOP) }), B = await fit({ START_TIME: iso(STOP) });
  // A: anchored at the start
  const sa = A.u.ORBIT_DETERMINATION.FIT_STATISTICS, sb = B.u.ORBIT_DETERMINATION.FIT_STATISTICS;
  check(Math.abs(secondsOf(A.u.MEAN_ELEMENTS.EPOCH) - START) <= STEP && Math.abs(secondsOf(sa.FIT_START) - START) <= STEP && secondsOf(sa.FIT_STOP) <= START + 2 * DAY + 1,
    `${c.name}: A's epoch ${A.u.MEAN_ELEMENTS.EPOCH} and arc ${sa.FIT_START} to ${sa.FIT_STOP} are not anchored at the span's start`);
  // B: fitted to the forecast's last part, its epoch at the stop
  const tb = B.u.TRAJECTORY_BLOCKS?.[0];
  check(Math.abs(secondsOf(B.u.MEAN_ELEMENTS.EPOCH) - STOP) <= STEP && Math.abs(secondsOf(sb.FIT_STOP) - STOP) <= STEP && sb.HELD_OUT_STATES === states.filter((s) => s.t > STOP + 1e-6).length,
    `${c.name}: B's epoch ${B.u.MEAN_ELEMENTS.EPOCH}, arc end ${sb.FIT_STOP}, ${sb.HELD_OUT_STATES} held out: not the forecast's last part ending at the stop`);
  check(tb && tb.TRAJ_ID === "HAND-OVER" && Math.abs(secondsOf(tb.USEABLE_START_TIME) - STOP) < 1e-5 && B.u.POLYNOMIAL_POSITION_RECORDS.length === 0,
    `${c.name}: B does not state itself a hand-over set from the stop`);
  // the steps
  const aStart = step(A.u.ORBIT_DETERMINATION.COMMENT.find((l) => l.startsWith("carried forecast start"))), aStop = step(A.u.ORBIT_DETERMINATION.COMMENT.find((l) => l.startsWith("carried forecast stop")));
  const bStop = step(B.u.ORBIT_DETERMINATION.COMMENT.find((l) => l.startsWith("hand-over set from")));
  check(aStart && aStart.km < c.stepKm, `${c.name}: A's step at the start ${aStart?.km} km, over ${c.stepKm}`);
  // in the drag B carries the hand-over better than a lone A (whose theory is a day and more past its arc there): over
  // the forecast's held-out hours after the stop B's largest distance to the forecast is under a lone A's; at
  // geosynchronous altitude the two are alike (the theory holds over the span).
  // History. Through 0.6.36 the check was B's step at the stop under a lone A's step there, one instant. 0.6.43 (the
  // zonal theory's constant radial term, SPEC 16.23) takes the theory's mean radial bias (about +9 m at 500 km and i
  // 97.4) off both: in low orbit B's step goes from 15.1 to 17.0 m and a lone A's from 22.3 to 15.8 m, so the
  // one-instant check failed although B still carries the hand-over better. Over the forecast's 18 held-out hours after
  // the stop (2,161 states, 30 s), measured on both builds (the term's positions are the same at either velocity form):
  // B's largest distance 101.9 m on 0.6.36 and 100.5 m on 0.6.43 (RMS 34.3 and 32.2 m), a lone A's 108.7 and 116.6 m
  // (RMS 39.7 and 40.0 m); at geosynchronous altitude B 1.43 and 1.50 m, a lone A 1.89 and 2.03 m. The check is that
  // held-out comparison from 0.6.43; B's step at the stop stays bounded by stepKm.
  const held = states.filter((s) => s.t > STOP + 1e-6), heldT = held.map((s) => s.t), heldB = await fly(B.rec, heldT), heldA = await fly(A.rec, heldT);
  const heldBKm = Math.max(...held.map((s, k) => hyp(s.r, heldB[k].r))), heldAKm = Math.max(...held.map((s, k) => hyp(s.r, heldA[k].r)));
  check(bStop && bStop.km < c.stepKm && (!c.drag || heldBKm < heldAKm),
    `${c.name}: B's step at the stop ${bStop?.km} km over ${c.stepKm}, or in the drag B's largest distance over the held-out hours ${heldBKm} km over a lone A's ${heldAKm} km`);
  // the covariance grows forward
  const covA = await fly(A.rec, [START, STOP], true), covB = await fly(B.rec, [STOP, STOP + DAY - 600], true);
  check(covA[0].sigmaKm < covA[1].sigmaKm, `${c.name}: A's covariance ${covA[0].sigmaKm} km at the start, ${covA[1].sigmaKm} km at the stop: it does not grow forward`);
  check(covB[0].sigmaKm < covB[1].sigmaKm, `${c.name}: B's covariance ${covB[0].sigmaKm} km at its start, ${covB[1].sigmaKm} km a day later: it does not grow forward`);
  // alone: A after its stop, B before its start
  const loneA = await fly(A.rec, [STOP - 60, STOP + 3600]), loneB = await fly(B.rec, [STOP - 3600, STOP, STOP + 3600]);
  check(loneA[0].source === "CARRIED FORECAST" && loneA[1].source === "THEORY", `${c.name}: a lone A's labels ${loneA.map((s) => s.source).join(", ")}`);
  check(loneB[0].source === "THEORY" && loneB[1].source === "HAND-OVER" && loneB[2].source === "HAND-OVER", `${c.name}: a lone B's labels ${loneB.map((s) => s.source).join(", ")}`);
  // A and B in one store
  const sizePrefixed = (bytes) => { const b = new Uint8Array(4 + bytes.length); new DataView(b.buffer).setUint32(0, bytes.length, true); b.set(bytes, 4); return b; };
  const both = new Uint8Array([...sizePrefixed(A.rec), ...sizePrefixed(B.rec)]);
  const loaded = await ap.invoke({ methodId: "load_epochs", inputs: [{ portId: "ocm", typeRef: T("OCM"), payload: both }] });
  check(loaded.statusCode === 0 && x.sdnap_epochs_count() === 1, `${c.name}: A and B do not load as one series (${loaded.errorCode ?? x.sdnap_epochs_count()})`);
  const times = [START - 3600, START + 3600, STOP - 3600, STOP + 3600, STOP + DAY - 600];
  const codes = times.map((t) => { const { whole, frac } = jdOf(iso(t)); x.sdnap_epochs_source_at(whole, frac, 0, 1, p); return new Int32Array(ap.memory.buffer, p, 1)[0]; });
  check(JSON.stringify(codes) === "[0,1,1,3,3]", `${c.name}: the store's sources ${codes.join(", ")}`);
  // after the stop the store's state is B's (TEME, B flown alone through propagate)
  const teme = async (rec, ts) => {
    const r = await ap.invoke({ methodId: "propagate", inputs: [{ portId: "ocm", typeRef: T("OCM"), payload: rec }, configuration({ output: { EPOCHS: ts.map(iso), FRAME: pcfOutputFrame.TEME } })] });
    return oemLines(r.outputs[0].payload).map((l) => [l.X, l.Y, l.Z]);
  };
  const bTeme = await teme(B.rec, times.slice(3));
  let worst = 0;
  times.slice(3).forEach((t, k) => {
    const { whole, frac } = jdOf(iso(t));
    x.sdnap_epochs_at(whole, frac, 0, 1, 0, p, 0, 0);
    worst = Math.max(worst, hyp(Array.from(new Float64Array(ap.memory.buffer, p, 3)), bTeme[k]));
  });
  // the store times the theory in minutes from J2000 (about 1e-7 s of rounding): 1e-5 km, as carried-epochs
  check(worst < 1e-5, `${c.name}: after the stop the store is ${worst} km from B`);
  // one decision at the span's stop (SPEC 18.3): split dates a double step apart about A's stop (its last segment's
  // EPOCH_MID plus EPOCH_HALF_SPAN), through the store: CARRIED FORECAST then HAND-OVER, switching once, and each
  // state bit for bit the state of the set its label names (A's forecast, or B), as sdnap_epochs_set_at flies that set
  {
    const last = A.u.POLYNOMIAL_POSITION_RECORDS.at(-1), j = jdOf(last.EPOCH_MID), stopFrac = j.frac + last.EPOCH_HALF_SPAN / 86400;
    const bump = (v, k) => { const b = new BigInt64Array(new Float64Array([v]).buffer); b[0] += BigInt(k); return new Float64Array(b.buffer)[0]; };
    const seq = [];
    let consistent = true;
    for (let k = -64; k <= 64; k++) {
      const f = bump(stopFrac, k);
      x.sdnap_epochs_source_at(j.whole, f, 0, 1, p);
      const code = new Int32Array(ap.memory.buffer, p, 1)[0];
      x.sdnap_epochs_at(j.whole, f, 0, 1, 0, p, 0, 0);
      const s = Array.from(new Float64Array(ap.memory.buffer, p, 6));
      x.sdnap_epochs_set_at(0, code === 1 ? 0 : 1, j.whole, f, p);
      const own = Array.from(new Float64Array(ap.memory.buffer, p, 6));
      seq.push(code);
      consistent = consistent && (code === 1 || code === 3) && s.every((v, q) => Object.is(v, own[q]));
    }
    const switches = seq.filter((q, k) => k > 0 && q !== seq[k - 1]).length;
    check(consistent && seq[0] === 1 && seq.at(-1) === 3 && switches === 1, `${c.name}: about A's stop the store's labels and states disagree or do not switch once: ${seq.join("")}`);
  }
  const pe = await ap.invoke({ methodId: "propagate_epochs", inputs: [{ portId: "ocm", typeRef: T("OCM"), payload: both }, configuration({ output: { EPOCHS: times.map(iso), FRAME: pcfOutputFrame.TEME } })] });
  const peLines = pe.statusCode === 0 ? oemLines(pe.outputs[0].payload) : [];
  check(JSON.stringify(peLines.map((l) => l.source)) === JSON.stringify(["THEORY", "CARRIED FORECAST", "CARRIED FORECAST", "HAND-OVER", "HAND-OVER"]),
    `${c.name}: propagate_epochs' sources ${peLines.map((l) => l.source).join(", ")} (${pe.errorCode ?? ""})`);
  rows.push({ regime: c.name, epochA: A.u.MEAN_ELEMENTS.EPOCH, epochB: B.u.MEAN_ELEMENTS.EPOCH, startKm: aStart?.km, startMmS: aStart?.mmS, stopLoneAKm: aStop?.km, stopBKm: bStop?.km, stopBMmS: bStop?.mmS, heldBKm: +heldBKm.toFixed(5), heldLoneAKm: +heldAKm.toFixed(5),
    sigmaAStartKm: +covA[0].sigmaKm.toFixed(5), sigmaAStopKm: +covA[1].sigmaKm.toFixed(5), sigmaBStopKm: +covB[0].sigmaKm.toFixed(5), sigmaBDayKm: +covB[1].sigmaKm.toFixed(5) });
}
console.table(rows);
if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  console.log(`CARRIED-SPAN-END FAIL: ${failures.length} failure(s)`);
  process.exit(1);
}
console.log("CARRIED-SPAN-END PASS: A anchored at the span's start, B at its stop, small steps at both ends, covariances growing forward, the store's sources THEORY, CARRIED FORECAST, HAND-OVER");
process.exit(0);

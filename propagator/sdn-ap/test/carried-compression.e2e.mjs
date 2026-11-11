#!/usr/bin/env node
// E2E (issue 316, SPEC 18.4): the record's compression against the forecast it carries. For each regime (low orbit at
// 300, 500, 830 and 1,336 km, medium, geosynchronous and inclined geosynchronous orbit, a transfer orbit at e 0.72,
// Molniya at e 0.74, a THEMIS-like orbit at e 0.82, an orbit at e 0.9 and a TESS-like orbit), a numerical forecast made by
// propagator/ffm (EGM2008 70 x 70, Sun and Moon from DE440, solar radiation pressure, drag where the orbit reaches it;
// GCRF every 10 s) is fitted with OUTPUT.START_TIME to
// STOP_TIME over its span from its states every 30 s (positions and velocities); then the record is flown by propagate:
// - at every 10-s time of the forecast not used in the build (not a multiple of 30 s), within 0.1 m and 0.1 mm/s of the
//   forecast (the record is held to 1 cm and 0.1 mm/s);
// - at the uniform 10-s grid, the second difference of the record's position less the forecast's (the output-continuity
//   residual less the forecast's own) at every triplet holding a segment joint, under 0.05 m;
// - one block per record, every state of the span labeled CARRIED FORECAST by its COMMENT (SPEC 18.8's grammar);
// - the record states its forecast (SPEC 18.6): METADATA START_TIME and STOP_TIME and TRAJECTORY_BLOCKS[0] USEABLE_START_TIME
//   and USEABLE_STOP_TIME the span, TRAJ_BASIS PREDICTED, and in its COMMENT the ephemeris block's own COMMENT (the force
//   model and the weather date), ORBIT_DETERMINATION (the initial state's source) and the tier it was built to.
// In low orbit at 300 and 500 km the forecast is also fitted from its states every 60 s (0.066 to 0.07 rad of arc, the
// common step of an operator's ephemeris; SPEC 18.4 item 2): off those times within 1 cm and 0.2 mm/s of the forecast,
// the record stating the 0.1 rad tier (carried-edges refuses 120 s).
// Prints, per regime, the bytes per object-day, the worst errors and the joint residuals.
// JS only moves bytes and compares numbers the modules produced.
//   node test/carried-compression.e2e.mjs [regime name filter ...]
import fs from "node:fs";
import * as flatbuffers from "flatbuffers";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { OEM, OEMT } from "spacedatastandards.org/lib/js/OEM/OEM.js";
import { OCM } from "spacedatastandards.org/lib/js/OCM/OCM.js";
import { CATT } from "spacedatastandards.org/lib/js/OEM/CAT.js";
import { ephemerisDataBlockT } from "spacedatastandards.org/lib/js/OEM/ephemerisDataBlock.js";
import { ephemerisDataLineT } from "spacedatastandards.org/lib/js/OEM/ephemerisDataLine.js";
import { OEMOrbitDeterminationT } from "spacedatastandards.org/lib/js/OEM/OEMOrbitDetermination.js";
import { timingStandard } from "spacedatastandards.org/lib/js/OEM/timingStandard.js";
import { pcfOutputFrame } from "spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js";
import { pcfAtmosphereFamily } from "spacedatastandards.org/lib/js/PCF/pcfAtmosphereFamily.js";
import { requestFor, decodeResult, decodePrw, encodePrw, makeTable, TYPE } from "../../ffm/tests/lib/prwCodec.mjs";
import { wasmPath } from "./lib/module.mjs";
import { configuration } from "./lib/pcf.mjs";
import { packOem, rfm } from "./lib/frames.mjs";
import { T } from "./lib/ocm.mjs";
import { oemLines } from "./lib/carried.mjs";

const ffmPath = new URL("../../ffm/dist/isomorphic/module.wasm", import.meta.url).pathname;
const EPOCH_WHOLE = 2461328.5;  // 2026-10-15T00:00:00Z
const BASE_MS = Date.UTC(2026, 9, 15);
const MU = 398600.4418, STEP = 10, BUILD = 30;
const FORCE_TEXT = "propagator/ffm: EGM2008 70 x 70, Sun and Moon (DE440), solar radiation pressure, drag (cd 2.2, 10 m2, 1000 kg) on constant weather issued 2026-10-15 (F10.7 150, Ap 15)";
const kernel = fs.readFileSync(new URL("../../../files/orbit-products/tests/fixtures/de440/de440-2026.bsp", import.meta.url));
const REGIMES = [
  { name: "LEO 300 km", a: 6678.137, e: 0.0005, i: 51.6, days: 1, drag: true },
  { name: "LEO 500 km", a: 6878.137, e: 0.001, i: 97.4, days: 1, drag: true },
  { name: "LEO 830 km", a: 7208.137, e: 0.0012, i: 98.7, days: 1, drag: true },
  { name: "LEO 1336 km", a: 7714.137, e: 0.0008, i: 66.04, days: 1, drag: true },
  { name: "MEO", a: 26560, e: 0.005, i: 55, days: 2, drag: false },
  { name: "GEO", a: 42164.2, e: 0.0002, i: 0.05, days: 2, drag: false },
  { name: "IGSO", a: 42164.2, e: 0.075, i: 55, days: 2, drag: false },
  { name: "GTO e 0.72", a: 6628.137 / 0.28, e: 0.72, i: 27, days: 1, drag: true },
  { name: "Molniya e 0.74", a: 26560, e: 0.74, i: 63.4, days: 1, drag: true },
  { name: "THEMIS-like e 0.82", a: 40940, e: 1 - 7278.137 / 40940, i: 10, days: 2, drag: true },
  { name: "HEO e 0.9", a: 6878.137 / 0.1, e: 0.9, i: 63.4, days: 2, drag: true },
  { name: "TESS-like e 0.55", a: 241800, e: 0.55, i: 37, days: 4, drag: false },
];

/** ISO UTC text of t seconds after the epoch, to the nanosecond. */
function iso(t) {
  const whole = Math.floor(t), ns = Math.round((t - whole) * 1e9);
  const w = ns === 1e9 ? whole + 1 : whole, n = ns === 1e9 ? 0 : ns;
  return `${new Date(BASE_MS + w * 1000).toISOString().slice(0, 19)}.${String(n).padStart(9, "0")}`;
}

const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };
const only = process.argv.slice(2);
const ap = await createStandaloneHarness("browser", wasmPath, { surface: "direct" });
const x = ap.instance.exports, p = x.sdnap_alloc(128);
const ffm = await createStandaloneHarness("browser", ffmPath, { surface: "command" });

/** FFM's forecast of regime c: [{ t, r, v }] GCRF every 10 s over its span, t its own instants (seconds from the epoch). */
async function forecast(c) {
  new Float64Array(ap.memory.buffer, p, 6).set([c.a, c.e, c.i, 40, c.e > 0.5 ? 270 : 30, c.e > 0.5 ? 250 : 30]);
  if (x.sdnap_state_of_elements(EPOCH_WHOLE, 0, p, 1, p + 48) !== 0) throw new Error(`${c.name}: no state`);
  let state = Array.from(new Float64Array(ap.memory.buffer, p + 48, 6));
  const n = Math.round((c.days * 86400) / STEP), out = [];
  const t0 = (EPOCH_WHOLE - 2440587.5) * 86400000;
  for (let k0 = 0; k0 < n; k0 += 8000) {  // FFM takes at most 10,000 samples a call
    const k1 = Math.min(n, k0 + 8000);
    const params = {
      epochJD: EPOCH_WHOLE + (k0 * STEP) / 86400, epochTimeScale: "UTC", targetJD: EPOCH_WHOLE + (k1 * STEP) / 86400, targetTimeScale: "UTC",
      position: state.slice(0, 3), velocity: state.slice(3), frame: "GCRF",
      sampleEpochsJD: Array.from({ length: k1 - k0 + 1 }, (_, j) => ({ jd: EPOCH_WHOLE + ((k0 + j) * STEP) / 86400, scale: "UTC" })),
      forces: { gravityMode: "EGM2008", maxDegree: 70, maxOrder: 70, thirdBody: true, srp: true, drag: c.drag, massKg: 1000, areaM2: 10, cd: 2.2 },
      weather: { epochUTCJD: EPOCH_WHOLE, F107: 150, F107a: 150, Ap: 15, Kp: 3 },
      integrator: { tolerance: 1e-13, minStep: 0.01, maxStep: 120 },
      ephemerisSource: "JPL_SPK",
    };
    const r = requestFor("propagate", params, kernel);
    r.inputs.push({ portId: "earth_orientation", typeRef: TYPE, payload: encodePrw("EARTH_ORIENTATION", makeTable("PRWEarthOrientation", {
      ROWS: Array.from({ length: c.days + 5 }, (_, k) => makeTable("EOP", { DATE: new Date(t0 + (k - 2) * 86400000).toISOString(), MJD: EPOCH_WHOLE - 2400000.5 + k - 2, TAI_MINUS_UTC_SECONDS: 37 })),
    })) });
    const res = await ffm.invoke(r);
    if (res.statusCode !== 0) throw new Error(`${c.name}: FFM ${res.errorCode} ${res.errorMessage}`);
    const got = decodeResult(res).samples;
    // the instants FFM integrated to are its labels (ns), not the JD grid (a JD double is 40 us coarse)
    const labels = decodePrw(res.outputs.find((q) => q.portId === "response").payload).EXECUTION_RESULT.SAMPLES.map((s) => s.STATE.STATE.EPOCH);
    got.forEach((g, j) => { if (k0 === 0 || j > 0) out.push({ label: labels[j], r: g.position, v: g.velocity }); });
    state = [...got.at(-1).position, ...got.at(-1).velocity];
  }
  const secondsOf = (label) => { const m = /^(.*T\d\d:\d\d:\d\d)\.(\d+)$/.exec(label); return [Date.parse(`${m[1]}Z`) / 1000, Number(`0.${m[2]}`)]; };
  const [w0, f0] = secondsOf(out[0].label);
  return out.map((s, k) => { const [w, f] = secondsOf(s.label); return { k, t: (w - w0) + (f - f0), r: s.r, v: s.v }; });
}

const rows = [];
// each regime from its states every 30 s; the two lowest also every 60 s (the 0.1 rad tier)
const runs = REGIMES.flatMap((c) => [{ c, build: BUILD }, ...(c.name === "LEO 300 km" || c.name === "LEO 500 km" ? [{ c, build: 60 }] : [])]);
let states = null, statesOf = null;
for (const { c, build: BUILD } of runs) {
  if (only.length && !only.some((q) => c.name.includes(q))) continue;
  if (statesOf !== c) { states = await forecast(c); statesOf = c; }
  const coarse = BUILD > 30, name = coarse ? `${c.name}, ${BUILD} s` : c.name;
  const built = states.filter((s) => s.k % (BUILD / STEP) === 0);
  const lines = built.map((s) => Object.assign(new ephemerisDataLineT(), { EPOCH: iso(s.t), X: s.r[0], Y: s.r[1], Z: s.r[2], X_DOT: s.v[0], Y_DOT: s.v[1], Z_DOT: s.v[2] }));
  const od = Object.assign(new OEMOrbitDeterminationT(), { OD_METHOD: "SYNTHETIC: an initial state from made-up elements", OD_ARC_START: lines[0].EPOCH, OD_ARC_STOP: lines[0].EPOCH, OD_OBSERVATIONS_USED: 0 });
  const block = Object.assign(new ephemerisDataBlockT(), { COMMENT: FORCE_TEXT, OBJECT: Object.assign(new CATT(), { NORAD_CAT_ID: 99400, OBJECT_NAME: c.name }), CENTER_NAME: "EARTH",
    REFERENCE_FRAME: rfm("GCRF"), TIME_SYSTEM: timingStandard.UTC, START_TIME: lines[0].EPOCH, STOP_TIME: lines.at(-1).EPOCH, EPHEMERIS_DATA_LINES: lines, ORBIT_DETERMINATION: od });
  const oem = packOem(Object.assign(new OEMT(), { EPHEMERIS_DATA_BLOCK: [block] }));
  const forces = { EPHEMERIS_SOURCE: "", ATMOSPHERE_MODEL: pcfAtmosphereFamily.JACCHIA70, HAS_MAXIMUM_TESSERAL_DEGREE: true, MAXIMUM_TESSERAL_DEGREE: 8 };
  const fit = await ap.invoke({ methodId: "fit", inputs: [{ portId: "ephemeris", typeRef: T("OEM"), payload: oem },
    configuration({ theory: "AP", forces, output: { START_TIME: lines[0].EPOCH, STOP_TIME: lines.at(-1).EPOCH } })] });
  if (fit.statusCode !== 0) { failures.push(`${name}: fit refused: ${fit.errorCode} ${fit.errorMessage}`); continue; }
  const rec = new Uint8Array(fit.outputs.find((q) => q.portId === "elements").payload);
  const u = OCM.getRootAsOCM(new flatbuffers.ByteBuffer(rec)).unpack();
  const fly = async (ts) => {
    const out = [];
    for (let k0 = 0; k0 < ts.length; k0 += 50000) {
      const part = ts.slice(k0, k0 + 50000);
      const r = await ap.invoke({ methodId: "propagate", inputs: [{ portId: "ocm", typeRef: T("OCM"), payload: rec }, configuration({ output: { EPOCHS: part.map(iso), FRAME: pcfOutputFrame.GCRF } })] });
      if (r.statusCode !== 0) throw new Error(`${c.name}: propagate ${r.errorCode} ${r.errorMessage}`);
      const blocks = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(new Uint8Array(r.outputs[0].payload))).unpack().EPHEMERIS_DATA_BLOCK;
      if (blocks.length !== 1) throw new Error(`${c.name}: ${blocks.length} blocks for one record`);
      for (const l of oemLines(r.outputs[0].payload)) out.push({ r: [l.X, l.Y, l.Z], v: [l.X_DOT, l.Y_DOT, l.Z_DOT], source: l.source });
    }
    return out;
  };
  const hyp = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  // 1. off the build's times
  const off = states.filter((s) => s.k % (BUILD / STEP) !== 0);
  const got = await fly(off.map((s) => s.t));
  let ep = 0, ev = 0;
  got.forEach((g, k) => { ep = Math.max(ep, hyp(g.r, off[k].r)); ev = Math.max(ev, hyp(g.v, off[k].v)); });
  // 30 s: within 0.1 m and 0.1 mm/s (the record is held to 1 cm and 0.1 mm/s); 60 s: within the 0.1 rad tier's stated 1 cm and 0.2 mm/s
  const [pmax, vmax] = coarse ? [1e-5, 2e-7] : [1e-4, 1e-7];
  check(ep <= pmax, `${name}: ${(ep * 1e6).toFixed(3)} mm from the forecast off the build's times, over ${pmax * 1e6} mm`);
  check(ev <= vmax, `${name}: ${(ev * 1e6).toFixed(4)} mm/s from the forecast off the build's times, over ${vmax * 1e6} mm/s`);
  check(got.every((g) => g.source === "CARRIED FORECAST"), `${name}: a state of the span is not labeled CARRIED FORECAST`);
  // 2. the second differences at the 10-s grid, at the triplets that hold a joint
  const segs = u.POLYNOMIAL_POSITION_RECORDS;
  const midOf = (s) => (Date.parse(`${s.EPOCH_MID.slice(0, 19)}Z`) - BASE_MS) / 1000 + Number(`0${s.EPOCH_MID.slice(19)}`);
  const joins = segs.slice(0, -1).map((s) => midOf(s) + s.EPOCH_HALF_SPAN);
  const all = await fly(states.map((s) => s.t));
  const d2 = (arr, k, h) => { const rr = arr[k].r, rn = Math.hypot(...rr); return [0, 1, 2].map((q) => arr[k + 1].r[q] - 2 * rr[q] + arr[k - 1].r[q] + h * h * MU * rr[q] / rn ** 3); };
  let joint = 0, own = 0, nJ = 0, ji = 0;
  for (let k = 1; k + 1 < states.length; k++) {
    while (ji < joins.length && joins[ji] < states[k - 1].t) ji++;
    if (!(ji < joins.length && joins[ji] <= states[k + 1].t)) continue;
    const h = states[k + 1].t - states[k].t, a = d2(all, k, h), b = d2(states, k, h);
    joint = Math.max(joint, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
    own = Math.max(own, Math.hypot(...a));
    nJ++;
  }
  check(joins.length === 0 || nJ > 0, `${name}: no triplet holds a joint`);
  check(joint <= 5e-5, `${name}: a second-difference residual of ${(joint * 1000).toFixed(4)} m at a joint beyond the forecast's, over 0.05 m`);
  // 3. the record's statement of its forecast
  const tb = u.TRAJECTORY_BLOCKS?.[0];
  const spanStart = segs.length ? midOf(segs[0]) - segs[0].EPOCH_HALF_SPAN : NaN, spanStop = segs.length ? midOf(segs.at(-1)) + segs.at(-1).EPOCH_HALF_SPAN : NaN;
  const near = (text, t) => Math.abs((Date.parse(`${text.slice(0, 19)}Z`) - BASE_MS) / 1000 + Number(`0${text.slice(19)}`) - t) < 2e-6;
  check(tb && tb.TRAJ_BASIS === "PREDICTED" && near(tb.USEABLE_START_TIME, spanStart) && near(tb.USEABLE_STOP_TIME, spanStop) &&
    near(u.METADATA.START_TIME, spanStart) && near(u.METADATA.STOP_TIME, spanStop), `${name}: the record does not state its span`);
  check(tb && tb.COMMENT.includes(FORCE_TEXT) && tb.COMMENT.includes(od.OD_METHOD), `${name}: the record does not state its forecast's force model, weather and initial state: ${tb?.COMMENT}`);
  const tier = coarse ? "Held to 1 cm and about 0.2 mm/s against the forecast at any time" : "Held to 1 cm and 0.1 mm/s against the forecast at any time";
  check(tb && tb.COMMENT.includes(tier) && tb.COMMENT.includes(coarse ? "the 0.1 rad tier" : "the 0.05 rad tier"), `${name}: the record does not state its tier (${tier}): ${tb?.COMMENT}`);
  const bytes = segs.reduce((a, s) => a + 112 + 24 * s.NUM_COEFFICIENTS, 0);
  rows.push({ regime: name, days: c.days, segments: segs.length, coefficients: segs[0]?.NUM_COEFFICIENTS, bytesPerDay: Math.round(bytes / c.days),
    maxMm: +(ep * 1e6).toFixed(3), maxMmS: +(ev * 1e6).toFixed(4), joints: joins.length, jointResidualMm: +(joint * 1e6).toFixed(4), ownResidualAtJointsM: +(own * 1000).toFixed(3) });
}
console.table(rows);
if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  console.log(`CARRIED-COMPRESSION FAIL: ${failures.length} failure(s)`);
  process.exit(1);
}
console.log(`CARRIED-COMPRESSION PASS: ${rows.length} records within 0.1 m and 0.1 mm/s of the forecast off the build's times (from 60 s: 1 cm and 0.2 mm/s), joints under 0.05 m, every state labeled, the forecast and its tier stated`);
process.exit(0);

#!/usr/bin/env node
// E2E (issue 316, SPEC 18.7): the theory takes over where the carried forecast stops. A numerical forecast made by
// propagator/ffm (EGM96 70 x 70, Sun and Moon from DE440, solar radiation pressure, drag; GCRF every 30 s) reaching a
// day past the carried span (its first two days) is
// fitted with OUTPUT.START_TIME to STOP_TIME and no USEABLE_STOP_TIME, and again with USEABLE_STOP_TIME a day into the
// span (the theory fitted to the forecast's first part, the way a record was fitted before 18.7):
// - the theory's arc ends at the span's stop: FIT_STATISTICS.FIT_STOP within one step of it, the states after it held
//   out (HELD_OUT_STATES) and scored;
// - the jump at the stop that fit states (theory minus forecast) is under 0.1 km in low orbit and 0.02 km in medium
//   orbit, and under the jump of the record fitted to the first part;
// - a day past the stop the theory (flown from the record) is nearer the forecast than the first part's theory;
// - the states at the stop and a millisecond after it are labeled CARRIED FORECAST and THEORY;
// - with a 24 h arc (its epoch a day into the span), the record flies the theory's covariance from the span's start (the
//   weather rows it carries begin the day before the span).
// JS only moves bytes and compares numbers the modules produced.
//   node test/carried-span-end.e2e.mjs
import fs from "node:fs";
import * as flatbuffers from "flatbuffers";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { OEM, OEMT } from "spacedatastandards.org/lib/js/OEM/OEM.js";
import { OCM } from "spacedatastandards.org/lib/js/OCM/OCM.js";
import { CATT } from "spacedatastandards.org/lib/js/OEM/CAT.js";
import { ephemerisDataBlockT } from "spacedatastandards.org/lib/js/OEM/ephemerisDataBlock.js";
import { ephemerisDataLineT } from "spacedatastandards.org/lib/js/OEM/ephemerisDataLine.js";
import { timingStandard } from "spacedatastandards.org/lib/js/OEM/timingStandard.js";
import { pcfOutputFrame } from "spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js";
import { pcfAtmosphereFamily } from "spacedatastandards.org/lib/js/PCF/pcfAtmosphereFamily.js";
import { requestFor, decodeResult, decodePrw, encodePrw, makeTable, TYPE } from "../../ffm/tests/lib/prwCodec.mjs";
import { wasmPath } from "./lib/module.mjs";
import { configuration } from "./lib/pcf.mjs";
import { packOem, rfm } from "./lib/frames.mjs";
import { pcfWeatherSource } from "spacedatastandards.org/lib/js/PCF/pcfWeatherSource.js";
import { T, rowsThrough, spwStream } from "./lib/ocm.mjs";
import { spwConstantText } from "./lib/spw-constant.mjs";

const ffmPath = new URL("../../ffm/dist/isomorphic/module.wasm", import.meta.url).pathname;
const kernel = fs.readFileSync(new URL("../../../files/orbit-products/tests/fixtures/de440/de440-2026.bsp", import.meta.url));
const EPOCH_WHOLE = 2461328.5, BASE_MS = Date.UTC(2026, 9, 15), STEP = 30, DAY = 86400, SPAN = 2 * DAY;
const REGIMES = [
  { name: "LEO 500 km", a: 6878.137, e: 0.001, i: 97.4, drag: true, jumpKm: 0.1 },
  { name: "MEO", a: 26560, e: 0.005, i: 55, drag: false, jumpKm: 0.02 },
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
const x = ap.instance.exports, p = x.sdnap_alloc(128);
const ffm = await createStandaloneHarness("browser", ffmPath, { surface: "command" });

/** FFM's forecast: [{ t, r, v }] GCRF every 30 s for `days`, t its own instants (s from the epoch). */
async function forecast(c, days) {
  new Float64Array(ap.memory.buffer, p, 6).set([c.a, c.e, c.i, 40, 30, 30]);
  if (x.sdnap_state_of_elements(EPOCH_WHOLE, 0, p, 1, p + 48) !== 0) throw new Error(`${c.name}: no state`);
  const state = Array.from(new Float64Array(ap.memory.buffer, p + 48, 6));
  const n = Math.round((days * DAY) / STEP), t0 = (EPOCH_WHOLE - 2440587.5) * 86400000;
  const params = {
    epochJD: EPOCH_WHOLE, epochTimeScale: "UTC", targetJD: EPOCH_WHOLE + days, targetTimeScale: "UTC", position: state.slice(0, 3), velocity: state.slice(3), frame: "GCRF",
    sampleEpochsJD: Array.from({ length: n + 1 }, (_, j) => ({ jd: EPOCH_WHOLE + (j * STEP) / DAY, scale: "UTC" })),
    forces: { gravityMode: "EGM96", maxDegree: 70, maxOrder: 70, thirdBody: true, srp: true, drag: c.drag, massKg: 1000, areaM2: 10, cd: 2.2 },
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
  const split = (label) => { const m = /^(.*T\d\d:\d\d:\d\d)\.(\d+)$/.exec(label); return [Date.parse(`${m[1]}Z`) / 1000, Number(`0.${m[2]}`)]; };
  const [w0, f0] = split(labels[0]);
  return got.map((g, k) => { const [w, f] = split(labels[k]); return { t: (w - w0) + (f - f0), r: g.position, v: g.velocity }; });
}
const hyp = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
// AP with zonal 20 and tesseral 31, NRLMSISE-00 on rows of the forecast's own constant weather
const forces = { EPHEMERIS_SOURCE: "", HAS_MAXIMUM_TESSERAL_DEGREE: true, MAXIMUM_TESSERAL_DEGREE: 31, HAS_MAXIMUM_DEGREE: true, MAXIMUM_DEGREE: 20,
  ATMOSPHERE_MODEL: pcfAtmosphereFamily.NRLMSISE00, WEATHER_SOURCE: pcfWeatherSource.RECORDS };
const weather = spwStream(rowsThrough(JSON.parse(spwConstantText("2026-10-20", 45))));
const rows = [];
for (const c of REGIMES) {
  const states = await forecast(c, 3);
  const lines = states.map((s) => Object.assign(new ephemerisDataLineT(), { EPOCH: iso(s.t), X: s.r[0], Y: s.r[1], Z: s.r[2], X_DOT: s.v[0], Y_DOT: s.v[1], Z_DOT: s.v[2] }));
  const stopState = states.reduce((b, s) => (Math.abs(s.t - SPAN) < Math.abs(b.t - SPAN) ? s : b));
  const fitWith = async (useableStop, more = {}) => {
    const block = Object.assign(new ephemerisDataBlockT(), { OBJECT: Object.assign(new CATT(), { NORAD_CAT_ID: 99410, OBJECT_NAME: c.name }), CENTER_NAME: "EARTH",
      REFERENCE_FRAME: rfm("GCRF"), TIME_SYSTEM: timingStandard.UTC, START_TIME: lines[0].EPOCH, STOP_TIME: lines.at(-1).EPOCH, EPHEMERIS_DATA_LINES: lines,
      ...(useableStop != null ? { USEABLE_STOP_TIME: iso(useableStop) } : {}) });
    const r = await ap.invoke({ methodId: "fit", inputs: [{ portId: "ephemeris", typeRef: T("OEM"), payload: packOem(Object.assign(new OEMT(), { EPHEMERIS_DATA_BLOCK: [block] })) },
      { portId: "space_weather", typeRef: T("SPW"), payload: weather }, configuration({ theory: "AP", forces, output: { START_TIME: lines[0].EPOCH, STOP_TIME: iso(stopState.t) }, ...more })] });
    if (r.statusCode !== 0) throw new Error(`${c.name}: fit ${r.errorCode} ${r.errorMessage}`);
    const rec = new Uint8Array(r.outputs.find((q) => q.portId === "elements").payload);
    const u = OCM.getRootAsOCM(new flatbuffers.ByteBuffer(rec)).unpack();
    const line = u.ORBIT_DETERMINATION.COMMENT.find((l) => l.startsWith("carried forecast stop")) ?? "";
    const jump = Number(/theory minus forecast ([\d.]+) km/.exec(line)?.[1] ?? NaN);
    const after = states.reduce((b, s) => (Math.abs(s.t - (SPAN + DAY)) < Math.abs(b.t - (SPAN + DAY)) ? s : b));
    const f = await ap.invoke({ methodId: "propagate", inputs: [{ portId: "ocm", typeRef: T("OCM"), payload: rec },
      configuration({ output: { EPOCHS: [iso(stopState.t), iso(stopState.t + 1e-3), iso(after.t)], FRAME: pcfOutputFrame.GCRF } })] });
    if (f.statusCode !== 0) throw new Error(`${c.name}: propagate ${f.errorCode}`);
    const got = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(new Uint8Array(f.outputs[0].payload))).unpack().EPHEMERIS_DATA_BLOCK
      .flatMap((b) => b.EPHEMERIS_DATA_LINES.map((l) => ({ r: [l.X, l.Y, l.Z], source: b.COMMENT.split(":")[0] })));
    return { rec, stats: u.ORBIT_DETERMINATION.FIT_STATISTICS, jump, dayAfterKm: hyp(got[2].r, after.r), labels: got.map((g) => g.source) };
  };
  const last = await fitWith(null), first = await fitWith(DAY);
  // a 24 h arc at the end of the 48 h span: its epoch a day into the span; the theory's covariance flies over the whole
  // span, from the weather rows of the day before the span's start the record carries
  {
    const short = await fitWith(null, { fit: { DEFAULT_SPAN_HOURS: 24 } });
    const f = await ap.invoke({ methodId: "propagate", inputs: [{ portId: "ocm", typeRef: T("OCM"), payload: short.rec }, configuration({ output: { EPOCHS: [iso(0), iso(3600)], FRAME: pcfOutputFrame.GCRF } })] });
    const blocks = f.statusCode === 0 ? OEM.getRootAsOEM(new flatbuffers.ByteBuffer(new Uint8Array(f.outputs[0].payload))).unpack().EPHEMERIS_DATA_BLOCK : [];
    check(f.statusCode === 0 && blocks.every((b) => b.COVARIANCE_MATRIX_LINES.length === b.EPHEMERIS_DATA_LINES.length && b.COVARIANCE_MATRIX_LINES.length > 0),
      `${c.name}: a record whose arc starts a day into its span does not fly the covariance at the span's start: ${f.errorCode ?? "no covariance lines"}`);
  }
  check(Math.abs(secondsOf(last.stats.FIT_STOP) - stopState.t) <= STEP, `${c.name}: the theory's arc ends at ${last.stats.FIT_STOP}, not at the span's stop`);
  const later = states.filter((s) => s.t > stopState.t + 1e-6).length;
  check(last.stats.HELD_OUT_STATES === later, `${c.name}: ${last.stats.HELD_OUT_STATES} states held out, not the ${later} after the span's stop`);
  check(last.jump < c.jumpKm, `${c.name}: the jump at the stop is ${last.jump} km, over ${c.jumpKm}`);
  check(last.jump < first.jump, `${c.name}: the jump at the stop (${last.jump} km) is not under the first part's theory's (${first.jump} km)`);
  check(last.dayAfterKm < first.dayAfterKm, `${c.name}: a day past the stop ${last.dayAfterKm} km from the forecast, not under the first part's ${first.dayAfterKm} km`);
  check(JSON.stringify(last.labels) === JSON.stringify(["CARRIED FORECAST", "THEORY", "THEORY"]), `${c.name}: labels at the stop ${last.labels.join(", ")}`);
  rows.push({ regime: c.name, arc: `${last.stats.FIT_START} to ${last.stats.FIT_STOP}`, heldOut: last.stats.HELD_OUT_STATES, jumpKm: last.jump, firstPartJumpKm: first.jump,
    dayAfterKm: +last.dayAfterKm.toFixed(4), firstPartDayAfterKm: +first.dayAfterKm.toFixed(4) });
}
console.table(rows);
if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  console.log(`CARRIED-SPAN-END FAIL: ${failures.length} failure(s)`);
  process.exit(1);
}
console.log("CARRIED-SPAN-END PASS: the theory's arc ends at the span's stop, the jump there and a day past it under the first part's theory's, the stop labeled");
process.exit(0);

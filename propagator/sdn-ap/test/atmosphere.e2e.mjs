#!/usr/bin/env node
// E2E (tasks modules-sgp4xp-atmosphere-variant-20261026, modules-sdn-ap-ocm-fly-20261103): SGP4XP's selectable drag
// atmosphere (SPEC 15), through the module's invoke surface and its atmosphere probe. The force model is the record's:
// fit runs under its $PCF FORCES and writes it, with the rows and the density-correction nodes, into its $OCM; a flight
// takes the $OCM alone (arms here: A0 stock SGP4XP; A1 Jacchia 1970 on the rows; A2 NRLMSISE-00 on the rows; A3 A2
// times exp(s(t)) of the open-DCA nodes).
// - The default is inert: a stock set flown with no $PCF and with an empty one gives the same bytes; fit under stock
//   FORCES and under FORCES written at every other default gives the same bytes (the conformance E2E holds the default
//   to the oracle bit for bit); A1 and A2 move a 400 km set; a fit under each of them writes its forces.
// - NRLMSISE-00 at the drag nodes (sdnap_atmosphere_probe, model 2) against analysis/density-calibration, an
//   independent wrapper of the same model: `evaluate` at the node's own geodetic point and time on the same $SPW rows
//   must give the same density within 1e-8 relative (the two wrappers' time arithmetic) and the same drivers (F10.7 of the previous day, the 81-day mean
//   and Ap of the day: the rows move every day, so a wrong day shows); `drag_work` at the point carried to GCRF by the
//   module's own rotation (density-calibration then reaches the Earth-fixed axes through ERFA) within 2e-4 (the
//   two geometries: SPEC 3.4's geodetic height and GMST82 against ERFA's).
// - The open DCA: nodes of s = 0 give the A2 bytes; s = ln 2 gives the states of A2 with the set's BTERM doubled
//   within 1 um (the drag rates are linear in B rho).
// - Above 2,500 km every atmosphere is the theory's 1e-20 kg/m^3: a GPS-like set propagates to the same bytes.
// - Jacchia 1970 on measured drivers (model 1) reads the same rows as NRLMSISE-00.
// - Probe model 3 (task modules-sgp4xp-fit-lognormal-drag-20261026): NRLMSISE-00 times exp(s(t)) of a $DCL; a constant
//   ln 2 doubles model 2 within 1e-15 and a varying s scales it by exp of its linear interpolation within 1e-12.
// - The two-stage decoupled fit (FIT.MINIMUM_SPAN_HOURS 17.1) under A2 and A3: epoch at the cutoff, a 17 h arc, the
//   record's forces and its nodes (from the last at or before its first row's day); the epoch store flies the A3
//   record as propagate does.
// - Every refusal is by name, FORCES.THIRD_BODY_MAXIMUM_DEGREE and _ORDER included; a flight's $PCF with FORCES is
//   configuration-refused FORCES.
// JS only moves bytes and compares numbers the modules produced.
//   node test/atmosphere.e2e.mjs
import fs from "node:fs";
import { createHash } from "node:crypto";
import * as flatbuffers from "flatbuffers";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { createBrowserModuleHarness } from "space-data-module-sdk/host/browser-module";
import { OEM, OEMT } from "spacedatastandards.org/lib/js/OEM/OEM.js";
import { ephemerisDataBlockT as OemBlockT } from "spacedatastandards.org/lib/js/OEM/ephemerisDataBlock.js";
import { timingStandard } from "spacedatastandards.org/lib/js/OEM/timingStandard.js";
import { SPW, SPWT } from "spacedatastandards.org/lib/js/SPW/SPW.js";
import { DCL, DCLT } from "spacedatastandards.org/lib/js/DCL/DCL.js";
import { ATMT } from "spacedatastandards.org/lib/js/DCL/ATM.js";
import { AtmosphericModelFamily } from "spacedatastandards.org/lib/js/DCL/AtmosphericModelFamily.js";
import { dclCorrectionT } from "spacedatastandards.org/lib/js/DCL/dclCorrection.js";
import { dclCorrectionForm } from "spacedatastandards.org/lib/js/DCL/dclCorrectionForm.js";
import { dclStatus } from "spacedatastandards.org/lib/js/DCL/dclStatus.js";
import { dclPointsT } from "spacedatastandards.org/lib/js/DCL/dclPoints.js";
import { dclStatesT } from "spacedatastandards.org/lib/js/DCL/dclStates.js";
import { ephemerisDataBlockT } from "spacedatastandards.org/lib/js/DCL/ephemerisDataBlock.js";
import { ephemerisDataLineT } from "spacedatastandards.org/lib/js/DCL/ephemerisDataLine.js";
import { pcfAtmosphereFamily } from "spacedatastandards.org/lib/js/PCF/pcfAtmosphereFamily.js";
import { pcfWeatherSource } from "spacedatastandards.org/lib/js/PCF/pcfWeatherSource.js";
import { pcfWeatherExtension } from "spacedatastandards.org/lib/js/PCF/pcfWeatherExtension.js";
import { pcfDensityCorrection } from "spacedatastandards.org/lib/js/PCF/pcfDensityCorrection.js";
import { PCFForceModel, PCFForceModelT } from "spacedatastandards.org/lib/js/PCF/PCFForceModel.js";
import { PCF } from "spacedatastandards.org/lib/js/PCF/PCF.js";
import { MNV, MNVT } from "spacedatastandards.org/lib/js/MNV/MNV.js";
import { FRAME_PROBE, packOem, rfm, rotate } from "./lib/frames.mjs";
import { ensureBuilt, wasmPath } from "./lib/module.mjs";
import { configuration, PCF_TYPE, XP_FORCES, MSIS_FORCES } from "./lib/pcf.mjs";
import { seedOcm, ocmOf, flight } from "./lib/ocm.mjs";

ensureBuilt();
const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };
const h = await createStandaloneHarness("browser", wasmPath, { surface: "direct" });
const x = h.instance.exports;
const mem = () => h.memory.buffer;
const T = (name) => ({ schemaName: `${name}.fbs`, fileIdentifier: `$${name}`, rootTypeName: name });
const sha = (b) => createHash("sha256").update(b).digest("hex").slice(0, 16);
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString().replace("Z", "");
const dateOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const invoke = async (methodId, inputs) => h.invoke({ methodId, inputs });

// --- records -------------------------------------------------------------------------------------------------------
/** $SPW rows of the days from `firstMs` (UTC midnight), each day's values moving (so that a day read wrongly shows), as
 *  size-prefixed records end to end. */
function rowsOf(firstMs, days, { f0 = 140, ap0 = 7 } = {}) {
  const parts = [];
  const values = [];
  for (let k = 0; k < days; k++) {
    const r = Object.assign(new SPWT(), { DATE: dateOf(firstMs + k * DAY), F107_OBS: f0 + 13 * (k % 5), F107_OBS_CENTER81: f0 + 4 + 2 * k, AP_AVG: ap0 + 9 * (k % 4) });
    const b = new flatbuffers.Builder(256);
    SPW.finishSizePrefixedSPWBuffer(b, r.pack(b));
    parts.push(b.asUint8Array().slice());
    values.push({ date: r.DATE, f107: Math.fround(r.F107_OBS), c81: Math.fround(r.F107_OBS_CENTER81), ap: r.AP_AVG });
  }
  return { bytes: Buffer.concat(parts), values };
}
/** An open-DCA $DCL: Solved, NRLMSISE-00, LogDensityNodes at `nodesMs` with values `s`. */
function dclOf(nodesMs, s, { status = dclStatus.Solved } = {}) {
  const d = Object.assign(new DCLT(), {
    STATUS: status,
    ATMOSPHERE: Object.assign(new ATMT(), { MODEL: AtmosphericModelFamily.NRLMSIS00E, YEAR: 2000 }),
    CORRECTION: Object.assign(new dclCorrectionT(), { FORM: dclCorrectionForm.LogDensityNodes, NODE_TIMES_MS: nodesMs.map(BigInt), NODE_LOG_DENSITY_SCALE_DIMENSIONLESS: s }),
  });
  const b = new flatbuffers.Builder(1024);
  DCL.finishDCLBuffer(b, d.pack(b));
  return b.asUint8Array().slice();
}
/** An SGP4XP or AP $OCM of arm `arm` (A0, A1, A2, A3) on `rows` (A3: with `nodes`, `s`). */
function setOf({ epoch, n, e = 0.001, i = 51.6, raan = 30, argp = 60, ma = 10, bterm = 0.01, agom = 0.005, norad = 90100, arm = "A0", rows: r = null, nodes = null, s = null }) {
  const spw = (r ?? []).map((v) => Object.assign(new SPWT(), { DATE: v.date, F107_OBS: v.f107, F107_OBS_CENTER81: v.c81, AP_AVG: v.ap, F107_DATA_TYPE: 0 }));
  return seedOcm({ epoch, n, e, i, raan, argp, ma, bterm, agom, norad, records: arm !== "A0", msis: arm === "A2" || arm === "A3", rows: spw,
    dca: arm === "A3" ? { ms: nodes, s } : null });
}
const forces = (fields) => ({ ...XP_FORCES, ...fields });
const A1 = forces({ WEATHER_SOURCE: pcfWeatherSource.RECORDS });
const A2 = { ...MSIS_FORCES, WEATHER_SOURCE: pcfWeatherSource.RECORDS };
const A3 = { ...A2, DENSITY_CORRECTION: pcfDensityCorrection.DCA_COMMON_MODE };
/** fit's frames: the track, the call's $PCF (FORCES, FIT), the rows and the $DCL. */
const fitFrames = ({ ephemeris, config, forces: f = XP_FORCES, fit: fitOpts, rows: r, dcl }) => [
  { portId: "ephemeris", typeRef: T("OEM"), payload: ephemeris },
  config instanceof Uint8Array ? { portId: "configuration", typeRef: PCF_TYPE, payload: config } : configuration({ forces: f, ...(fitOpts ? { fit: fitOpts } : {}) }),
  ...(r ? [{ portId: "space_weather", typeRef: T("SPW"), payload: r }] : []),
  ...(dcl ? [{ portId: "density_correction", typeRef: T("DCL"), payload: dcl }] : []),
];
/** A flight's output times: START_TIME to STOP_TIME every `stepS`, TEME. */
const gridOf = (startMs, stopMs, stepS) => ({ START_TIME: iso(startMs), STOP_TIME: iso(stopMs), STEP_SECONDS: stepS });
const linesOf = (bytes) => OEM.getRootAsOEM(new flatbuffers.ByteBuffer(new Uint8Array(bytes))).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES;
async function propagated(label, set, grid) {
  const r = await invoke("propagate", flight([set], grid ? { output: grid } : null));
  if (r.statusCode !== 0) { failures.push(`${label}: propagate ${r.errorCode} ${r.errorMessage}`); return null; }
  return new Uint8Array(r.outputs[0].payload);
}
async function refused(label, method, inputs, code, field) {
  const r = await invoke(method, inputs);
  const ok = r.statusCode !== 0 && r.errorCode === code && (field === undefined || String(r.errorMessage).startsWith(field));
  check(ok, `${label}: expected ${code}${field ? ` (${field})` : ""}, got ${r.statusCode === 0 ? "success" : `${r.errorCode} ${r.errorMessage}`}`);
  return ok;
}

/** A fit $PCF whose FORCES table writes every scalar field at its documented default but ATMOSPHERE_MODEL JACCHIA70
 *  (the builder forcing defaults for the scalars only), with the required EPHEMERIS_SOURCE empty and an empty
 *  THIRD_BODY_IDS. */
function forcesAtEveryDefault() {
  const b = new flatbuffers.Builder(1024);
  const t = new PCFForceModelT();
  t.ATMOSPHERE_MODEL = pcfAtmosphereFamily.JACCHIA70;
  const source = b.createString("");
  const ids = PCFForceModel.createThirdBodyIdsVector(b, []);
  PCFForceModel.startPCFForceModel(b);
  b.forceDefaults(true);
  let written = 0;
  for (const [key, value] of Object.entries(t)) {
    if (value === null || Array.isArray(value) || typeof value === "string") continue;
    const adder = `add${key.toLowerCase().split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join("")}`;
    if (typeof PCFForceModel[adder] !== "function") throw new Error(`no ${adder}`);
    PCFForceModel[adder](b, value);
    written += 1;
  }
  b.forceDefaults(false);
  PCFForceModel.addEphemerisSource(b, source);
  PCFForceModel.addThirdBodyIds(b, ids);
  const forcesTable = PCFForceModel.endPCFForceModel(b);
  PCF.startPCF(b);
  PCF.addForces(b, forcesTable);
  b.finish(PCF.endPCF(b), "$PCF");
  check(written >= 45, `FORCES at every default wrote ${written} scalar fields`);
  return b.asUint8Array().slice();
}

// --- the scenario: a 400 km set across days whose rows move ---------------------------------------------------------
const day0 = Date.UTC(2026, 2, 10);  // 2026-03-10
const epochMs = day0 + 2 * DAY + 0.37 * DAY;
const rows = rowsOf(day0, 12);
const leo = (arm, more = {}) => setOf({ epoch: iso(epochMs), n: 15.5, arm, rows: rows.values, ...more });
const grid = gridOf(epochMs, epochMs + 3 * DAY, 600);
const HORIZON = { WEATHER_HORIZON_DAYS: 3 };  // the rows end 2026-03-21: the record carries them through the epoch's day + 3

// 1. the default is inert
{
  const none = await propagated("A0 alone", leo("A0"), null);
  const empty = await invoke("propagate", [...flight([leo("A0")]), configuration({})]);
  check(none && empty.statusCode === 0 && Buffer.from(none).equals(Buffer.from(empty.outputs[0].payload)), "propagate: an empty $PCF changes the bytes");
  const track = await propagated("A0", leo("A0"), grid);
  const fitOf = async (config) => {
    const r = await invoke("fit", fitFrames({ ephemeris: track, config }));
    return r.statusCode === 0 ? Buffer.concat(r.outputs.map((o) => Buffer.from(o.payload))) : `${r.errorCode} ${r.errorMessage}`;
  };
  const f0 = await fitOf(configuration({ forces: XP_FORCES }).payload), f1 = await fitOf(forcesAtEveryDefault());
  const stripCid = (b) => (typeof b === "string" ? b : b.length);  // the records differ in FIT_STATISTICS.PCF_CID only
  const e0 = typeof f0 === "string" ? null : ocmOf(f0), e1 = typeof f1 === "string" ? null : ocmOf(f1);
  const sameSet = e0 && e1 && JSON.stringify(e0.MEAN_ELEMENTS) === JSON.stringify(e1.MEAN_ELEMENTS) &&
    JSON.stringify(e0.COVARIANCE_DATA) === JSON.stringify(e1.COVARIANCE_DATA) && e0.ORBIT_DETERMINATION.FIT_STATISTICS.PCF_CID !== e1.ORBIT_DETERMINATION.FIT_STATISTICS.PCF_CID;
  console.log(`default fit: ${stripCid(f0)} B and ${stripCid(f1)} B, the same set and covariance: ${!!sameSet} (the records name their own $PCF)`);
  check(sameSet, `fit: FORCES at every default changes the set (${typeof f0 === "string" ? f0 : sha(f0)} / ${typeof f1 === "string" ? f1 : sha(f1)})`);
  // the arms move the LEO set, and every arm propagates it
  const a1 = await propagated("A1", leo("A1"), grid);
  const a2 = await propagated("A2", leo("A2"), grid);
  for (const [name, b] of [["A1", a1], ["A2", a2]]) {
    if (!track || !b) continue;
    const p = linesOf(track).at(-1), q = linesOf(b).at(-1);
    const d = Math.hypot(p.X - q.X, p.Y - q.Y, p.Z - q.Z);
    console.log(`${name} against A0 after 3 days at 400 km: ${(d * 1000).toFixed(1)} m`);
    check(d > 1e-3, `${name}: the atmosphere does not move a 400 km set (${d} km)`);
  }
  // a fit under each arm writes its forces
  for (const [name, f, theory, year] of [["A1", A1, 5, 1970], ["A2", A2, 5, 2000]]) {
    const r = await invoke("fit", fitFrames({ ephemeris: track, forces: f, fit: HORIZON, rows: rows.bytes }));
    check(r.statusCode === 0, `${name} fit: ${r.errorCode} ${r.errorMessage}`);
    if (r.statusCode !== 0) continue;
    const o = ocmOf(r.outputs[0].payload);
    check(o.MEAN_ELEMENTS.MEAN_ELEMENT_THEORY === theory && o.PERTURBATIONS.ATMOSPHERIC_MODEL.YEAR === year && o.PERTURBATIONS.WEATHER_SOURCE === pcfWeatherSource.RECORDS &&
      o.PERTURBATIONS.SPACE_WEATHER.length > 0, `${name} fit's record forces`);
  }
}

// 2. NRLMSISE-00 at the nodes against analysis/density-calibration
{
  const dcDir = new URL("../../../analysis/density-calibration/", import.meta.url);
  const dc = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(new URL("dist/isomorphic/module.wasm", dcDir)), manifest: JSON.parse(fs.readFileSync(new URL("plugin-manifest.json", dcDir), "utf8")), surface: "direct" });
  const rowsPtr = x.sdnap_alloc(rows.bytes.length);
  new Uint8Array(mem(), rowsPtr, rows.bytes.length).set(rows.bytes);
  const rp = x.sdnap_alloc(24), out = x.sdnap_alloc(56);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const points = [];
  for (let k = 0; k < 240; k++) {
    const ms = day0 + 2 * DAY + Math.round(rnd() * 8 * DAY);  // whole milliseconds
    const rad = 6378.137 + 120 + rnd() * 860, lat = Math.asin(2 * rnd() - 1), lon = 2 * Math.PI * rnd();
    const r = [rad * Math.cos(lat) * Math.cos(lon), rad * Math.cos(lat) * Math.sin(lon), rad * Math.sin(lat)];
    const jd = 2440587.5 + ms / DAY, whole = Math.floor(jd - 0.5) + 0.5, frac = (ms - (whole - 2440587.5) * DAY) / DAY;
    new Float64Array(mem(), rp, 3).set(r);
    const status = x.sdnap_atmosphere_probe(2, whole, frac, rp, rowsPtr, rows.bytes.length, 0, 0, out);
    const o = Array.from(new Float64Array(mem(), out, 7));
    points.push({ ms, whole, frac, r, status, rho: o[0], lat: o[1], lon: o[2], h: o[3], drivers: o.slice(4) });
  }
  check(points.every((p) => p.status === 0 && p.rho > 0), "probe: a point refused or without density");
  // the drivers as the rows give them on the point's UTC day d: F10.7 of d - 1, the 81-day mean and Ap of d
  let driverMiss = 0;
  for (const p of points) {
    const d = dateOf(p.ms), before = dateOf(p.ms - DAY);
    const today = rows.values.find((v) => v.date === d), yesterday = rows.values.find((v) => v.date === before);
    if (!(p.drivers[0] === yesterday.f107 && p.drivers[1] === today.c81 && p.drivers[2] === today.ap)) driverMiss += 1;
  }
  check(driverMiss === 0, `probe: ${driverMiss} points read their drivers from another day`);
  const call = async (method, d) => {
    const b = new flatbuffers.Builder(1 << 16);
    DCL.finishDCLBuffer(b, d.pack(b));
    const r = await dc.invoke({ methodId: method, inputs: [{ portId: "request", typeRef: { ...T("DCL"), wireFormat: "flatbuffer" }, payload: b.asUint8Array().slice() }] });
    if (r.statusCode !== 0) throw new Error(`${method}: ${r.errorCode} ${r.errorMessage}`);
    return DCL.getRootAsDCL(new flatbuffers.ByteBuffer(new Uint8Array(r.outputs[0].payload))).unpack();
  };
  const msisRows = rows.values.map((v) => Object.assign(new SPWT(), { DATE: v.date, F107_OBS: v.f107, F107_OBS_CENTER81: v.c81, AP_AVG: v.ap }));
  const atm = Object.assign(new ATMT(), { MODEL: AtmosphericModelFamily.NRLMSIS00E, YEAR: 2000 });
  const inBand = points.filter((p) => p.h >= 90 && p.h <= 1000);
  const evaluated = await call("evaluate", Object.assign(new DCLT(), { ATMOSPHERE: atm, SPACE_WEATHER: msisRows,
    POINTS: Object.assign(new dclPointsT(), { TIME_MS: inBand.map((p) => BigInt(p.ms)), LATITUDE_DEG: inBand.map((p) => (p.lat * 180) / Math.PI), LONGITUDE_DEG: inBand.map((p) => (p.lon * 180) / Math.PI), ALTITUDE_KM: inBand.map((p) => p.h) }) }));
  let worstPoint = 0;
  evaluated.POINTS.DENSITY_KG_M3.forEach((rho, k) => { worstPoint = Math.max(worstPoint, Math.abs(rho / inBand[k].rho - 1)); });
  console.log(`NRLMSISE-00 at ${inBand.length} node points: density-calibration evaluate at the node's geodetic point agrees within ${worstPoint.toExponential(2)} relative`);
  check(evaluated.POINTS.DENSITY_KG_M3.length === inBand.length && worstPoint <= 1e-8, `evaluate: ${worstPoint} relative`);
  // the geometry: the point carried to GCRF by the module's rotation, density-calibration's ERFA Earth-fixed axes
  const lines = inBand.map((p) => {
    const { out: g } = rotate({ x, harness: h }, p.whole, p.frac, [...p.r, 0, 7.5, 0], FRAME_PROBE.TEME_TO_GCRF);
    return Object.assign(new ephemerisDataLineT(), { EPOCH: `${iso(p.ms)}Z`, X: g[0], Y: g[1], Z: g[2], X_DOT: g[3], Y_DOT: g[4], Z_DOT: g[5] });
  });
  const worked = await call("drag_work", Object.assign(new DCLT(), { ATMOSPHERE: atm, SPACE_WEATHER: msisRows, BALLISTIC_COEFFICIENT_M2_KG: 1,
    STATES: Object.assign(new dclStatesT(), { EPHEMERIS: Object.assign(new ephemerisDataBlockT(), { EPHEMERIS_DATA_LINES: lines }) }) }));
  let worstGeometry = 0;
  worked.STATES.DENSITY_KG_M3.forEach((rho, k) => { if (Number.isFinite(rho)) worstGeometry = Math.max(worstGeometry, Math.abs(rho / inBand[k].rho - 1)); });
  const refusedStates = worked.STATES.REFUSED.length;
  console.log(`NRLMSISE-00 at the same points through ERFA's geometry (drag_work): within ${worstGeometry.toExponential(2)} relative (${refusedStates} refused)`);
  check(refusedStates === 0 && worstGeometry <= 2e-4, `drag_work: ${worstGeometry} relative, ${refusedStates} refused`);
  // Jacchia 1970 on the measured drivers reads the same days
  let j70Miss = 0;
  for (const p of points.slice(0, 40)) {
    new Float64Array(mem(), rp, 3).set(p.r);
    const status = x.sdnap_atmosphere_probe(1, p.whole, p.frac, rp, rowsPtr, rows.bytes.length, 0, 0, out);
    const o = Array.from(new Float64Array(mem(), out, 7));
    if (status !== 0 || !(o[0] > 0) || o[4] !== p.drivers[0] || o[5] !== p.drivers[1] || o[6] !== p.drivers[2]) j70Miss += 1;
  }
  check(j70Miss === 0, `probe model 1: ${j70Miss} points with other drivers or no density`);
  // model 3 (task modules-sgp4xp-fit-lognormal-drag-20261026): NRLMSISE-00 on the drivers times exp(s(t)) of the $DCL,
  // s linear in UTC between its nodes; a constant ln 2 doubles model 2, a varying s scales it by exp of the interpolation
  {
    const nodes = [day0, day0 + 4 * DAY, day0 + 8 * DAY, day0 + 11 * DAY], s = [0.1, -0.2, 0.3, 0];
    const put = (bytes) => { const p = x.sdnap_alloc(bytes.length); new Uint8Array(mem(), p, bytes.length).set(bytes); return p; };
    const ln2 = dclOf(nodes, nodes.map(() => Math.log(2))), varying = dclOf(nodes, s), pending = dclOf(nodes, s, { status: dclStatus.Pending });
    const pl = put(ln2), pv = put(varying), pp = put(pending);
    const sAt = (ms) => { const k = nodes.findIndex((t, i) => ms >= t && ms <= nodes[i + 1]); const w = (ms - nodes[k]) / (nodes[k + 1] - nodes[k]); return s[k] * (1 - w) + s[k + 1] * w; };
    let worstDouble = 0, worstVarying = 0, bad = 0;
    for (const p of points.slice(0, 60)) {
      new Float64Array(mem(), rp, 3).set(p.r);
      const s2 = x.sdnap_atmosphere_probe(3, p.whole, p.frac, rp, rowsPtr, rows.bytes.length, pl, ln2.length, out);
      const d2 = new Float64Array(mem(), out, 7)[0];
      const s3 = x.sdnap_atmosphere_probe(3, p.whole, p.frac, rp, rowsPtr, rows.bytes.length, pv, varying.length, out);
      const d3 = new Float64Array(mem(), out, 7)[0];
      if (s2 !== 0 || s3 !== 0) { bad += 1; continue; }
      worstDouble = Math.max(worstDouble, Math.abs(d2 / (2 * p.rho) - 1));
      worstVarying = Math.max(worstVarying, Math.abs(d3 / (p.rho * Math.exp(sAt(p.ms))) - 1));
    }
    console.log(`probe model 3: a constant ln 2 doubles model 2 within ${worstDouble.toExponential(2)}, a varying s scales it by exp(s(t)) within ${worstVarying.toExponential(2)} (60 points)`);
    check(bad === 0 && worstDouble <= 1e-15 && worstVarying <= 1e-12, `probe model 3: ${bad} refused, ${worstDouble}, ${worstVarying}`);
    new Float64Array(mem(), rp, 3).set(points[0].r);
    const refusedProbe = [x.sdnap_atmosphere_probe(3, points[0].whole, points[0].frac, rp, rowsPtr, rows.bytes.length, 0, 0, out),
      x.sdnap_atmosphere_probe(2, points[0].whole, points[0].frac, rp, rowsPtr, rows.bytes.length, pv, varying.length, out),
      x.sdnap_atmosphere_probe(3, points[0].whole, points[0].frac, rp, rowsPtr, rows.bytes.length, pp, pending.length, out)];
    check(refusedProbe.every((r) => r === -1), `probe: model 3 without a $DCL, model 2 with one, a $DCL not Solved: ${refusedProbe.join(", ")}`);
    for (const q of [pl, pv, pp]) x.sdnap_free(q);
  }
  // rows that start on the point's own day do not reach the day before
  {
    const late = rowsOf(day0 + 5 * DAY, 3);
    const lp = x.sdnap_alloc(late.bytes.length);
    new Uint8Array(mem(), lp, late.bytes.length).set(late.bytes);
    new Float64Array(mem(), rp, 3).set(points[0].r);
    const jd = 2440587.5 + (day0 + 5 * DAY + 0.5 * DAY) / DAY, whole = Math.floor(jd - 0.5) + 0.5;
    check(x.sdnap_atmosphere_probe(2, whole, jd - whole, rp, lp, late.bytes.length, 0, 0, out) === 1, "probe: rows starting on the point's day are not flagged");
    x.sdnap_free(lp);
  }
  x.sdnap_free(rowsPtr); x.sdnap_free(rp); x.sdnap_free(out);
  await dc.destroy?.();
}

// 3. the open DCA
{
  const nodes = [day0, day0 + 4 * DAY, day0 + 8 * DAY, day0 + 11 * DAY];
  const a2 = await propagated("A2", leo("A2"), grid);
  const zero = await propagated("A3, s = 0", leo("A3", { nodes, s: [0, 0, 0, 0] }), grid);
  check(a2 && zero && Buffer.from(a2).equals(Buffer.from(zero)), "A3 with s = 0 differs from A2");
  const ln2 = Math.log(2);
  const doubled = await propagated("A3, s = ln 2", leo("A3", { nodes, s: [ln2, ln2, ln2, ln2] }), grid);
  const a2b = await propagated("A2, 2 BTERM", leo("A2", { bterm: 0.02 }), grid);
  if (doubled && a2b) {
    const p = linesOf(doubled), q = linesOf(a2b);
    const worst = Math.max(...p.map((l, k) => Math.hypot(l.X - q[k].X, l.Y - q[k].Y, l.Z - q[k].Z)));
    console.log(`A3 with s = ln 2 against A2 with BTERM doubled: ${(worst * 1e6).toFixed(3)} mm over 3 days`);
    check(worst <= 1e-9, `A3 s = ln 2 against A2 2 BTERM: ${worst} km`);
  }
  const varying = await propagated("A3, s varying", leo("A3", { nodes, s: [0.1, -0.2, 0.3, 0] }), grid);
  check(varying && a2 && !Buffer.from(varying).equals(Buffer.from(a2)), "A3 with a varying s equals A2");
}

// 4. above 2,500 km every atmosphere is the theory's
{
  const gps = (arm, more = {}) => setOf({ epoch: iso(epochMs), n: 2.00563, e: 0.01, i: 55, bterm: 0.02, agom: 0.02, norad: 90200, arm, rows: rows.values, ...more });
  const g0 = await propagated("GPS A0", gps("A0"), grid);
  const g2 = await propagated("GPS A2", gps("A2"), grid);
  const g3 = await propagated("GPS A3", gps("A3", { nodes: [day0, day0 + 11 * DAY], s: [0.4, -0.3] }), grid);
  check(g0 && g2 && Buffer.from(g0).equals(Buffer.from(g2)), "GPS: A2 differs from A0");
  check(g0 && g3 && Buffer.from(g0).equals(Buffer.from(g3)), "GPS: A3 differs from A0");
  console.log(`GPS-like set: A0 ${g0 && sha(g0)}, A2 ${g2 && sha(g2)}, A3 ${g3 && sha(g3)}`);
}

// 5. refusals by name
{
  const track = await propagated("track", leo("A0"), grid);
  const fitRefused = (label, req, code, field) => refused(label, "fit", fitFrames({ ephemeris: track, fit: HORIZON, ...req }), code, field);
  await fitRefused("ATMOSPHERE_MODEL JACCHIA_ROBERTS", { forces: forces({ ATMOSPHERE_MODEL: pcfAtmosphereFamily.JACCHIA_ROBERTS }), rows: rows.bytes }, "configuration-refused", "FORCES.ATMOSPHERE_MODEL");
  await fitRefused("WEATHER_SOURCE CONSTANT", { forces: forces({ WEATHER_SOURCE: pcfWeatherSource.CONSTANT }) }, "configuration-refused", "FORCES.WEATHER_SOURCE");
  await fitRefused("THEORY_FLUX_MODEL under NRLMSISE-00", { forces: { ...MSIS_FORCES, WEATHER_SOURCE: pcfWeatherSource.THEORY_FLUX_MODEL } }, "configuration-refused", "FORCES.WEATHER_SOURCE");
  await fitRefused("WEATHER_EXTENSION HOLD_LAST", { forces: { ...A2, WEATHER_EXTENSION: pcfWeatherExtension.HOLD_LAST }, rows: rows.bytes }, "configuration-refused", "FORCES.WEATHER_EXTENSION");
  await fitRefused("WEATHER_EXTENSION FORECAST_CHAIN", { forces: { ...A2, WEATHER_EXTENSION: pcfWeatherExtension.FORECAST_CHAIN }, rows: rows.bytes }, "configuration-refused", "FORCES.WEATHER_EXTENSION");
  await fitRefused("DCA on Jacchia 1970", { forces: forces({ DENSITY_CORRECTION: pcfDensityCorrection.DCA_COMMON_MODE }), rows: rows.bytes }, "configuration-refused", "FORCES.DENSITY_CORRECTION");
  await fitRefused("relaxation 12 h", { forces: { ...A3, DENSITY_CORRECTION_RELAXATION_HOURS: 12, HAS_DENSITY_CORRECTION_RELAXATION_HOURS: true }, rows: rows.bytes, dcl: dclOf([day0], [0]) }, "configuration-refused", "FORCES.DENSITY_CORRECTION_RELAXATION_HOURS");
  await fitRefused("ENABLE_DRAG", { forces: { ...A2, ENABLE_DRAG: true }, rows: rows.bytes }, "configuration-refused", "FORCES.ENABLE_DRAG");
  await fitRefused("another FORCES field", { forces: forces({ AREA_M2: 3 }) }, "configuration-refused", "FORCES.AREA_M2");
  // the last two PCFForceModel fields (task modules-sgp4xp-fit-lognormal-drag-20261026): refused by name, not ignored
  await fitRefused("THIRD_BODY_MAXIMUM_DEGREE 2", { forces: forces({ THIRD_BODY_MAXIMUM_DEGREE: 2 }) }, "configuration-refused", "FORCES.THIRD_BODY_MAXIMUM_DEGREE");
  await fitRefused("THIRD_BODY_MAXIMUM_ORDER 2", { forces: forces({ THIRD_BODY_MAXIMUM_ORDER: 2 }) }, "configuration-refused", "FORCES.THIRD_BODY_MAXIMUM_ORDER");
  await fitRefused("no ATMOSPHERE_MODEL", { config: configuration({}).payload }, "configuration-refused", "FORCES.ATMOSPHERE_MODEL");
  await fitRefused("NRLMSISE-00 without rows", { forces: A2 }, "weather-rows-missing");
  await fitRefused("RECORDS without rows", { forces: A1 }, "weather-rows-missing");
  await fitRefused("rows under the theory's flux model", { rows: rows.bytes }, "weather-rows-unselected");
  await fitRefused("DCA without a $DCL", { forces: A3, rows: rows.bytes }, "density-correction-missing");
  await fitRefused("a $DCL with DENSITY_CORRECTION NONE", { forces: A2, rows: rows.bytes, dcl: dclOf([day0], [0]) }, "density-correction-unselected");
  await fitRefused("a $DCL not Solved", { forces: A3, rows: rows.bytes, dcl: dclOf([day0], [0], { status: dclStatus.Pending }) }, "invalid-density-correction");
  await fitRefused("a row without F10.7", { forces: A2, rows: (() => {
    const b = new flatbuffers.Builder(128);
    SPW.finishSizePrefixedSPWBuffer(b, Object.assign(new SPWT(), { DATE: dateOf(day0), F107_OBS: 0, F107_OBS_CENTER81: 150, AP_AVG: 5 }).pack(b));
    return b.asUint8Array().slice();
  })() }, "weather-rows-invalid:2026-03-10");
  // rows from the day before the arc's first day are enough; rows from that day itself miss the day before it
  const enough = await invoke("fit", fitFrames({ ephemeris: track, forces: A2, fit: HORIZON, rows: rowsOf(day0 + DAY, 8).bytes }));
  check(enough.statusCode === 0, `rows from the day before the arc's first day: ${enough.errorCode} ${enough.errorMessage}`);
  if (enough.statusCode === 0) {
    const first = Date.parse(`${ocmOf(enough.outputs[0].payload).ORBIT_DETERMINATION.FIT_STATISTICS.FIT_START.slice(0, 10)}T00:00:00Z`);
    await fitRefused("rows that start on the arc's first day", { forces: A2, rows: rowsOf(first, 8).bytes }, `weather-rows-short:${dateOf(first - DAY)}`);
  }
  // a flight's $PCF carries no FORCES
  await refused("propagate with FORCES", "propagate", flight([leo("A2")], { output: grid, forces: A2 }), "configuration-refused", "FORCES");
  const mb = new flatbuffers.Builder(64);
  MNV.finishMNVBuffer(mb, new MNVT().pack(mb));
  await refused("maneuver with FORCES", "maneuver", [...flight([leo("A0")], { forces: XP_FORCES }), { portId: "maneuvers", typeRef: T("MNV"), payload: mb.asUint8Array().slice() }], "configuration-refused", "FORCES");
}

// 6. NRLMSISE-00 + open DCA, two-stage decoupled 17.1h tesseral-null fit, the record's forces and nodes, the epoch store
{
  // A 5-day track from 00:00:00 UTC on day0 + 1*DAY to day0 + 6*DAY (cutoff D0 = day0 + 6*DAY) under A3; the 48 h Stage 1
  // span starts at day0 + 4*DAY. Rows from day0 + 3*DAY (1 day before the 48 h fit start, after the track's start):
  //   (a) the speculative 72 h/120 h candidate spans do not poison the span rule when it keeps 48 h, and
  //   (b) backward RK3 bracketing at 00:00:00 UTC on day0 + 4*DAY reads no day before the rows.
  const d0Ms = day0 + 6 * DAY;
  const dclNodes = [day0, day0 + 3 * DAY, day0 + 6 * DAY, day0 + 9 * DAY];
  const dclS = [0.05, -0.08, 0.04, 0.0];
  const dclBytes = dclOf(dclNodes, dclS);
  const mid = setOf({ epoch: iso(day0 + 4 * DAY), n: 15.5, bterm: 0.012, agom: 0.004, norad: 90300, arm: "A3", rows: rows.values, nodes: dclNodes, s: dclS });
  const trackA3 = await propagated("trackA3 5d", mid, gridOf(day0 + DAY, d0Ms, 600));
  check(trackA3 !== null, "trackA3 5d failed to propagate");
  const tightRows = rowsOf(day0 + 3 * DAY, 6);  // 2026-03-13 .. 2026-03-18
  const fitR17 = { MINIMUM_SPAN_HOURS: 17.1, DEFAULT_SPAN_HOURS: 48.0, WEATHER_HORIZON_DAYS: 2 };
  const rFitA2 = await invoke("fit", fitFrames({ ephemeris: trackA3, forces: A2, fit: fitR17, rows: tightRows.bytes }));
  const rFitA3 = await invoke("fit", fitFrames({ ephemeris: trackA3, forces: A3, fit: fitR17, rows: tightRows.bytes, dcl: dclBytes }));
  check(rFitA2.statusCode === 0, `two-stage R17 fit under A2: ${rFitA2.errorCode} ${rFitA2.errorMessage}`);
  check(rFitA3.statusCode === 0, `two-stage R17 fit under A3: ${rFitA3.errorCode} ${rFitA3.errorMessage}`);
  if (rFitA2.statusCode === 0 && rFitA3.statusCode === 0) {
    const setA2 = new Uint8Array(rFitA2.outputs[0].payload), setA3 = new Uint8Array(rFitA3.outputs[0].payload);
    const o2 = ocmOf(setA2), o3 = ocmOf(setA3), st = o3.ORBIT_DETERMINATION.FIT_STATISTICS;
    console.log(`two-stage R17 fit: A2 ${o2.PERTURBATIONS.ATMOSPHERIC_MODEL.YEAR} correction ${o2.PERTURBATIONS.DENSITY_CORRECTION} epoch=${o2.MEAN_ELEMENTS.EPOCH}; A3 correction ${o3.PERTURBATIONS.DENSITY_CORRECTION}, ${o3.PERTURBATIONS.DENSITY_CORRECTION_NODE_TIMES_MS.length} nodes, epoch=${o3.MEAN_ELEMENTS.EPOCH} BTERM=${o3.MEAN_ELEMENTS.BTERM.toExponential(4)} arc ${st.FIT_START} to ${st.FIT_STOP} (${(o3.ORBIT_DETERMINATION.ACTUAL_OD_SPAN * 24).toFixed(3)} h); rows ${o3.PERTURBATIONS.SPACE_WEATHER[0].DATE} to ${o3.PERTURBATIONS.SPACE_WEATHER.at(-1).DATE}`);
    check(o2.PERTURBATIONS.ATMOSPHERIC_MODEL.YEAR === 2000 && o2.PERTURBATIONS.DENSITY_CORRECTION === pcfDensityCorrection.NONE, "the A2 record's forces");
    check(o3.PERTURBATIONS.DENSITY_CORRECTION === pcfDensityCorrection.DCA_COMMON_MODE && o3.PERTURBATIONS.DENSITY_CORRECTION_CID?.startsWith("b"), "the A3 record's forces");
    // the nodes from the last at or before the first row's day (2026-03-14) through the last published
    check(JSON.stringify(o3.PERTURBATIONS.DENSITY_CORRECTION_NODE_TIMES_MS.map(Number)) === JSON.stringify(dclNodes.slice(1)) &&
      JSON.stringify(o3.PERTURBATIONS.DENSITY_CORRECTION_LOG_DENSITY_SCALE_DIMENSIONLESS) === JSON.stringify(dclS.slice(1)), "the A3 record's nodes");
    check(o3.MEAN_ELEMENTS.EPOCH.startsWith(iso(d0Ms).slice(0, 19)), `two-stage R17 epoch expected cutoff ${iso(d0Ms)}, got ${o3.MEAN_ELEMENTS.EPOCH}`);
    check(Math.abs(o3.ORBIT_DETERMINATION.ACTUAL_OD_SPAN * 24 - 17.0) < 1e-6, `two-stage R17 arc: ${o3.ORBIT_DETERMINATION.ACTUAL_OD_SPAN * 24} h, expected 17.000 h (103 10-min states)`);
    check(st.FIT_START.startsWith(iso(d0Ms - 17.0 * 3600000).slice(0, 16)), `two-stage R17 FIT_START: ${st.FIT_START}`);
    // the records fly alone; the epoch store flies the A3 record as propagate does
    const predGrid = gridOf(d0Ms, d0Ms + DAY, 600);
    const propA2 = await propagated("A2 record forward", setA2, predGrid);
    const propA3 = await propagated("A3 record forward", setA3, predGrid);
    check(propA2 && propA3, "the fitted records fly");
    const rPropEpA3 = await invoke("propagate_epochs", [{ portId: "ocm", typeRef: T("OCM"), payload: setA3 }, configuration({ output: predGrid })]);
    check(rPropEpA3.statusCode === 0, `propagate_epochs A3: ${rPropEpA3.errorCode} ${rPropEpA3.errorMessage}`);
    if (propA3 && rPropEpA3.statusCode === 0) {
      const p1 = linesOf(propA3), p2 = linesOf(new Uint8Array(rPropEpA3.outputs[0].payload));
      const maxDiff = Math.max(...p1.map((l, k) => Math.hypot(l.X - p2[k].X, l.Y - p2[k].Y, l.Z - p2[k].Z)));
      console.log(`propagate_epochs A3 vs propagate A3 over 24h: max |dr| ${(maxDiff * 1e6).toFixed(3)} mm`);
      check(maxDiff <= 1e-5, `propagate_epochs A3 vs propagate A3: ${maxDiff} km`);
    }
    const rLoad = await invoke("load_epochs", [{ portId: "ocm", typeRef: T("OCM"), payload: setA2 }]);
    check(rLoad.statusCode === 0, `load_epochs A2 alone: ${rLoad.errorCode} ${rLoad.errorMessage}`);
  }
  // the altitude-adaptive log-normal BTERM prior under NRLMSISE-00 (0.002 m^2/kg at 600-800 km, 0.0005 at >= 800 km) is
  // not written in the record (its OD COMMENT carries no number); the fits at 700 and 900 km are made and fly
  for (const [label, nRevDay] of [["700 km", 14.58], ["900 km", 13.97]]) {
    const hi = setOf({ epoch: iso(epochMs), n: nRevDay, bterm: 0.001, agom: 0.002, norad: 90400, arm: "A2", rows: rows.values });
    const hiTrack = await propagated(`track ${label}`, hi, gridOf(epochMs, epochMs + DAY, 600));
    const rHi = await invoke("fit", fitFrames({ ephemeris: hiTrack, forces: A2, fit: HORIZON, rows: rows.bytes }));
    check(rHi.statusCode === 0, `altitude-adaptive fit ${label}: ${rHi.errorCode} ${rHi.errorMessage}`);
    if (rHi.statusCode === 0) console.log(`fit at ${label} under NRLMSISE-00: BTERM ${ocmOf(rHi.outputs[0].payload).MEAN_ELEMENTS.BTERM.toExponential(4)} m^2/kg`);
  }
}

await h.destroy?.();
if (failures.length) {
  console.error(`FAIL (${failures.length})\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("PASS");
process.exit(0);

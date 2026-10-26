#!/usr/bin/env node
// E2E (task modules-sgp4xp-atmosphere-variant-20261026): SGP4XP's selectable drag atmosphere (SPEC 15), through the
// module's invoke surface and its atmosphere probe.
// - The default is inert: propagate and fit with no FORCES, with a FORCES table written at every default, and with
//   FORCES at its defaults beside no frames, give the same bytes (the conformance E2E holds the default to the
//   oracle bit for bit).
// - NRLMSISE-00 at the drag nodes (sdnap_atmosphere_probe, model 2) against analysis/density-calibration, an
//   independent wrapper of the same model: `evaluate` at the node's own geodetic point and time on the same $SPW rows
//   must give the same density within 1e-8 relative (the two wrappers' time arithmetic) and the same drivers (F10.7 of the previous day, the 81-day mean
//   and Ap of the day: the rows move every day, so a wrong day shows); `drag_work` at the point carried to GCRF by the
//   module's own rotation (density-calibration then reaches the Earth-fixed axes through ERFA) within 2e-4 (the
//   two geometries: SPEC 3.4's geodetic height and GMST82 against ERFA's).
// - The open DCA: a $DCL of s = 0 at every node gives the NRLMSISE-00 arm's bytes; s = ln 2 gives the states of the
//   NRLMSISE-00 arm with the set's BTERM doubled within 1 um (the drag rates are linear in B rho).
// - Above 2,500 km every atmosphere is the theory's 1e-20 kg/m^3: a GPS-like set propagates to the same bytes.
// - Jacchia 1970 on measured drivers (model 1) reads the same rows as NRLMSISE-00.
// - Probe model 3 (task modules-sgp4xp-fit-lognormal-drag-20261026): NRLMSISE-00 times exp(s(t)) of a $DCL; a constant
//   ln 2 doubles model 2 within 1e-15 and a varying s scales it by exp of its linear interpolation within 1e-12.
// - Every refusal is by name, FORCES.THIRD_BODY_MAXIMUM_DEGREE and _ORDER included.
// JS only moves bytes and compares numbers the modules produced.
//   node test/atmosphere.e2e.mjs
import fs from "node:fs";
import { createHash } from "node:crypto";
import * as flatbuffers from "flatbuffers";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { createBrowserModuleHarness } from "space-data-module-sdk/host/browser-module";
import { OMM } from "spacedatastandards.org/lib/js/OMM/OMM.js";
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
import { pcfTheory } from "spacedatastandards.org/lib/js/PCF/pcfTheory.js";
import { FRAME_PROBE, packOem, rfm, rotate } from "./lib/frames.mjs";
import { ensureBuilt, wasmPath } from "./lib/module.mjs";
import { configuration, PCF_TYPE } from "./lib/pcf.mjs";

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

// --- records -------------------------------------------------------------------------------------------------------
/** An SGP4XP $OMM (BTERM in BSTAR, AGOM in MEAN_MOTION_DDOT). */
function ommOf({ epoch, n, e = 0.001, i = 51.6, raan = 30, argp = 60, ma = 10, bterm = 0.01, agom = 0.005, norad = 90100 }) {
  const b = new flatbuffers.Builder(256);
  const s = b.createString(epoch);
  OMM.startOMM(b);
  OMM.addEpoch(b, s);
  OMM.addMeanMotion(b, n);
  OMM.addEccentricity(b, e);
  OMM.addInclination(b, i);
  OMM.addRaOfAscNode(b, raan);
  OMM.addArgOfPericenter(b, argp);
  OMM.addMeanAnomaly(b, ma);
  OMM.addBstar(b, bterm);
  OMM.addMeanMotionDdot(b, agom);
  OMM.addNoradCatId(b, norad);
  OMM.addMeanElementTheory(b, 1);
  OMM.finishOMMBuffer(b, OMM.endOMM(b));
  return b.asUint8Array().slice();
}
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
const forces = (fields) => ({ forces: { EPHEMERIS_SOURCE: "", ...fields } });
const A1 = forces({ WEATHER_SOURCE: pcfWeatherSource.RECORDS, WEATHER_EXTENSION: pcfWeatherExtension.HOLD_LAST });
const A2 = forces({ ENABLE_DRAG: true, ATMOSPHERE_MODEL: pcfAtmosphereFamily.NRLMSISE00, WEATHER_SOURCE: pcfWeatherSource.RECORDS, WEATHER_EXTENSION: pcfWeatherExtension.HOLD_LAST });
const A3 = forces({ ...A2.forces, DENSITY_CORRECTION: pcfDensityCorrection.DCA_COMMON_MODE });

const invoke = async (methodId, inputs) => h.invoke({ methodId, inputs });
const frames = ({ omm, ephemeris, config, forces: f, rows, dcl, grid }) => [
  ...(omm ? [{ portId: "omm", typeRef: T("OMM"), payload: omm }] : []),
  ...(ephemeris ? [{ portId: "ephemeris", typeRef: T("OEM"), payload: ephemeris }] : []),
  config instanceof Uint8Array ? { portId: "configuration", typeRef: PCF_TYPE, payload: config } : configuration({ theory: "SGP4XP", ...(f ? { forces: f } : {}) }),
  ...(rows ? [{ portId: "space_weather", typeRef: T("SPW"), payload: rows }] : []),
  ...(dcl ? [{ portId: "density_correction", typeRef: T("DCL"), payload: dcl }] : []),
  ...(grid ? [{ portId: "grid", typeRef: T("OEM"), payload: grid }] : []),
];
/** A grid $OEM template: START_TIME / STOP_TIME / STEP_SIZE in TEME. */
function gridOf(startMs, stopMs, stepS) {
  const blk = Object.assign(new OemBlockT(), { CENTER_NAME: "EARTH", REFERENCE_FRAME: rfm("TEME"), TIME_SYSTEM: timingStandard.UTC, START_TIME: iso(startMs), STOP_TIME: iso(stopMs), STEP_SIZE: stepS });
  return packOem(Object.assign(new OEMT(), { EPHEMERIS_DATA_BLOCK: [blk] })).slice();
}
const linesOf = (bytes) => OEM.getRootAsOEM(new flatbuffers.ByteBuffer(new Uint8Array(bytes))).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES;
async function propagated(label, req) {
  const r = await invoke("propagate", frames(req));
  if (r.statusCode !== 0) { failures.push(`${label}: propagate ${r.errorCode} ${r.errorMessage}`); return null; }
  return new Uint8Array(r.outputs[0].payload);
}
async function refused(label, method, req, code, field) {
  const r = await invoke(method, frames(req));
  const ok = r.statusCode !== 0 && r.errorCode === code && (field === undefined || String(r.errorMessage).startsWith(field));
  check(ok, `${label}: expected ${code}${field ? ` (${field})` : ""}, got ${r.statusCode === 0 ? "success" : `${r.errorCode} ${r.errorMessage}`}`);
  return ok;
}

/** A $PCF whose FORCES table writes every scalar field at its documented default (the builder forcing defaults for the
 *  scalars only), with the required EPHEMERIS_SOURCE empty and an empty THIRD_BODY_IDS. */
function forcesAtEveryDefault() {
  const b = new flatbuffers.Builder(1024);
  const t = new PCFForceModelT();
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
  PCF.addTheory(b, pcfTheory.SGP4XP);
  PCF.addForces(b, forcesTable);
  b.finish(PCF.endPCF(b), "$PCF");
  check(written >= 45, `FORCES at every default wrote ${written} scalar fields`);
  return b.asUint8Array().slice();
}

// --- the scenario: a 400 km set across days whose rows move ---------------------------------------------------------
const day0 = Date.UTC(2026, 2, 10);  // 2026-03-10
const epochMs = day0 + 2 * DAY + 0.37 * DAY;
const leo = ommOf({ epoch: iso(epochMs), n: 15.5 });
const leo2 = ommOf({ epoch: iso(epochMs), n: 15.5, bterm: 0.02 });
const gps = ommOf({ epoch: iso(epochMs), n: 2.00563, e: 0.01, i: 55, bterm: 0.02, agom: 0.02, norad: 90200 });
const rows = rowsOf(day0, 12);
const grid = gridOf(epochMs, epochMs + 3 * DAY, 600);

// 1. the default is inert
{
  const none = await propagated("A0", { omm: leo, grid });
  const explicitForces = forcesAtEveryDefault();
  const atDefaults = await propagated("A0, FORCES at every default", { omm: leo, grid, config: explicitForces });
  const fieldsAtDefaults = await propagated("A0, FORCES with its atmosphere fields at their defaults", { omm: leo, grid, ...forces({ ENABLE_DRAG: false, ATMOSPHERE_MODEL: pcfAtmosphereFamily.NRLMSISE00, WEATHER_SOURCE: pcfWeatherSource.UNSPECIFIED, DENSITY_CORRECTION: pcfDensityCorrection.NONE }) });
  console.log(`default: none ${none && sha(none)}, FORCES at defaults ${atDefaults && sha(atDefaults)}, atmosphere fields at defaults ${fieldsAtDefaults && sha(fieldsAtDefaults)}`);
  check(none && atDefaults && Buffer.from(none).equals(Buffer.from(atDefaults)), "propagate: FORCES at every default changes the bytes");
  check(none && fieldsAtDefaults && Buffer.from(none).equals(Buffer.from(fieldsAtDefaults)), "propagate: the atmosphere fields at their defaults change the bytes");
  // fit: the A0 track fitted with and without FORCES at its defaults
  const track = none;
  const fitOf = async (config) => {
    const r = await invoke("fit", frames({ ephemeris: track, ...(config ? { config } : {}) }));
    return r.statusCode === 0 ? Buffer.concat(r.outputs.map((o) => Buffer.from(o.payload))) : `${r.errorCode} ${r.errorMessage}`;
  };
  const f0 = await fitOf(), f1 = await fitOf(explicitForces);
  check(Buffer.isBuffer(f0) && Buffer.isBuffer(f1) && f0.equals(f1), `fit: FORCES at every default changes the bytes (${typeof f0 === "string" ? f0 : sha(f0)} / ${typeof f1 === "string" ? f1 : sha(f1)})`);
  console.log(`default fit: ${typeof f0 === "string" ? f0 : sha(f0)} and ${typeof f1 === "string" ? f1 : sha(f1)}`);
  // the arms move the LEO set, and every arm propagates it
  const a1 = await propagated("A1", { omm: leo, grid, ...A1, rows: rows.bytes });
  const a2 = await propagated("A2", { omm: leo, grid, ...A2, rows: rows.bytes });
  for (const [name, b] of [["A1", a1], ["A2", a2]]) {
    if (!none || !b) continue;
    const p = linesOf(none).at(-1), q = linesOf(b).at(-1);
    const d = Math.hypot(p.X - q.X, p.Y - q.Y, p.Z - q.Z);
    console.log(`${name} against A0 after 3 days at 400 km: ${(d * 1000).toFixed(1)} m`);
    check(d > 1e-3, `${name}: the atmosphere does not move a 400 km set (${d} km)`);
  }
  // a fit under each arm
  for (const [name, cfg, extra] of [["A1", A1, { rows: rows.bytes }], ["A2", A2, { rows: rows.bytes }]]) {
    const r = await invoke("fit", frames({ ephemeris: track, ...cfg, ...extra }));
    check(r.statusCode === 0, `${name} fit: ${r.errorCode} ${r.errorMessage}`);
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
  const a2 = await propagated("A2", { omm: leo, grid, ...A2, rows: rows.bytes });
  const zero = await propagated("A3, s = 0", { omm: leo, grid, ...A3, rows: rows.bytes, dcl: dclOf(nodes, [0, 0, 0, 0]) });
  check(a2 && zero && Buffer.from(a2).equals(Buffer.from(zero)), "A3 with s = 0 differs from A2");
  const ln2 = Math.log(2);
  const doubled = await propagated("A3, s = ln 2", { omm: leo, grid, ...A3, rows: rows.bytes, dcl: dclOf(nodes, [ln2, ln2, ln2, ln2]) });
  const a2b = await propagated("A2, 2 BTERM", { omm: leo2, grid, ...A2, rows: rows.bytes });
  if (doubled && a2b) {
    const p = linesOf(doubled), q = linesOf(a2b);
    const worst = Math.max(...p.map((l, k) => Math.hypot(l.X - q[k].X, l.Y - q[k].Y, l.Z - q[k].Z)));
    const same = Buffer.from(doubled.slice(0, 0)).length === 0 && p.every((l, k) => l.X === q[k].X && l.Y === q[k].Y && l.Z === q[k].Z);
    console.log(`A3 with s = ln 2 against A2 with BTERM doubled: ${(worst * 1e6).toFixed(3)} mm over 3 days${same ? " (the same numbers)" : ""}`);
    check(worst <= 1e-9, `A3 s = ln 2 against A2 2 BTERM: ${worst} km`);
  }
  // varying s moves the states between the A2 and the doubled ones
  const varying = await propagated("A3, s varying", { omm: leo, grid, ...A3, rows: rows.bytes, dcl: dclOf(nodes, [0.1, -0.2, 0.3, 0]) });
  check(varying && a2 && !Buffer.from(varying).equals(Buffer.from(a2)), "A3 with a varying s equals A2");
}

// 4. above 2,500 km every atmosphere is the theory's
{
  const g0 = await propagated("GPS A0", { omm: gps, grid });
  const g2 = await propagated("GPS A2", { omm: gps, grid, ...A2, rows: rows.bytes });
  const g3 = await propagated("GPS A3", { omm: gps, grid, ...A3, rows: rows.bytes, dcl: dclOf([day0, day0 + 11 * DAY], [0.4, -0.3]) });
  check(g0 && g2 && Buffer.from(g0).equals(Buffer.from(g2)), "GPS: A2 differs from A0");
  check(g0 && g3 && Buffer.from(g0).equals(Buffer.from(g3)), "GPS: A3 differs from A0");
  console.log(`GPS-like set: A0 ${g0 && sha(g0)}, A2 ${g2 && sha(g2)}, A3 ${g3 && sha(g3)}`);
}

// 5. refusals by name
{
  const base = { omm: leo, grid };
  await refused("ATMOSPHERE_MODEL JACCHIA_ROBERTS", "propagate", { ...base, ...forces({ ENABLE_DRAG: true, ATMOSPHERE_MODEL: pcfAtmosphereFamily.JACCHIA_ROBERTS }), rows: rows.bytes }, "configuration-refused", "FORCES.ATMOSPHERE_MODEL");
  await refused("WEATHER_SOURCE CONSTANT", "propagate", { ...base, ...forces({ WEATHER_SOURCE: pcfWeatherSource.CONSTANT }) }, "configuration-refused", "FORCES.WEATHER_SOURCE");
  await refused("WEATHER_EXTENSION REFUSE", "propagate", { ...base, ...forces({ WEATHER_EXTENSION: pcfWeatherExtension.REFUSE }), rows: rows.bytes }, "configuration-refused", "FORCES.WEATHER_EXTENSION");
  await refused("WEATHER_EXTENSION FORECAST_CHAIN", "fit", { ephemeris: await propagated("track", base), ...forces({ WEATHER_EXTENSION: pcfWeatherExtension.FORECAST_CHAIN }), rows: rows.bytes }, "configuration-refused", "FORCES.WEATHER_EXTENSION");
  await refused("DCA on Jacchia 1970", "propagate", { ...base, ...forces({ DENSITY_CORRECTION: pcfDensityCorrection.DCA_COMMON_MODE }), rows: rows.bytes }, "configuration-refused", "FORCES.DENSITY_CORRECTION");
  await refused("relaxation 12 h", "propagate", { ...base, ...forces({ ...A3.forces, DENSITY_CORRECTION_RELAXATION_HOURS: 12, HAS_DENSITY_CORRECTION_RELAXATION_HOURS: true }), rows: rows.bytes, dcl: dclOf([day0], [0]) }, "configuration-refused", "FORCES.DENSITY_CORRECTION_RELAXATION_HOURS");
  await refused("another FORCES field", "propagate", { ...base, ...forces({ AREA_M2: 3 }) }, "configuration-refused", "FORCES.AREA_M2");
  // the last two PCFForceModel fields (task modules-sgp4xp-fit-lognormal-drag-20261026): refused by name, not ignored
  await refused("THIRD_BODY_MAXIMUM_DEGREE 2", "propagate", { ...base, ...forces({ THIRD_BODY_MAXIMUM_DEGREE: 2 }) }, "configuration-refused", "FORCES.THIRD_BODY_MAXIMUM_DEGREE");
  await refused("THIRD_BODY_MAXIMUM_ORDER 2", "fit", { ephemeris: await propagated("track", base), ...forces({ THIRD_BODY_MAXIMUM_ORDER: 2 }) }, "configuration-refused", "FORCES.THIRD_BODY_MAXIMUM_ORDER");
  await refused("NRLMSISE-00 without rows", "propagate", { ...base, ...forces({ ENABLE_DRAG: true }) }, "space-weather-missing");
  await refused("RECORDS without rows", "fit", { ephemeris: await propagated("track", base), ...forces({ WEATHER_SOURCE: pcfWeatherSource.RECORDS }) }, "space-weather-missing");
  await refused("DCA without a $DCL", "propagate", { ...base, ...A3, rows: rows.bytes }, "density-correction-missing");
  await refused("a $DCL with DENSITY_CORRECTION NONE", "propagate", { ...base, ...A2, rows: rows.bytes, dcl: dclOf([day0], [0]) }, "density-correction-unselected");
  await refused("a $DCL not Solved", "propagate", { ...base, ...A3, rows: rows.bytes, dcl: dclOf([day0], [0], { status: dclStatus.Pending }) }, "invalid-density-correction");
  await refused("a row without F10.7", "propagate", { ...base, ...A2, rows: (() => {
    const b = new flatbuffers.Builder(128);
    SPW.finishSizePrefixedSPWBuffer(b, Object.assign(new SPWT(), { DATE: dateOf(day0), F107_OBS: 0, F107_OBS_CENTER81: 150, AP_AVG: 5 }).pack(b));
    return b.asUint8Array().slice();
  })() }, "invalid-space-weather");
  await refused("rows that start on the epoch's day", "propagate", { ...base, ...A2, rows: rowsOf(day0 + 2 * DAY, 6).bytes }, "space-weather-out-of-range");
  {
    const mb = new flatbuffers.Builder(64);
    MNV.finishMNVBuffer(mb, new MNVT().pack(mb));
    const r = await invoke("maneuver", [...frames({ omm: leo, ...forces({ ENABLE_DRAG: true }) }), { portId: "maneuvers", typeRef: T("MNV"), payload: mb.asUint8Array().slice() }]);
    check(r.statusCode !== 0 && r.errorCode === "configuration-refused" && String(r.errorMessage).startsWith("FORCES.ENABLE_DRAG"),
      `maneuver with ENABLE_DRAG: ${r.statusCode === 0 ? "success" : `${r.errorCode} ${r.errorMessage}`}`);
  }
  // rows with no FORCES table: WEATHER_SOURCE UNSPECIFIED infers them, so the theory's own Jacchia 1970 reads them (A1)
  const inferred = await propagated("rows, no FORCES", { ...base, rows: rows.bytes });
  const a1 = await propagated("A1", { ...base, ...A1, rows: rows.bytes });
  check(inferred && a1 && Buffer.from(inferred).equals(Buffer.from(a1)), "rows without FORCES do not read as A1");
  // rows that begin the day before the epoch's day are enough
  const enough = await propagated("rows from the day before the epoch", { ...base, ...A2, rows: rowsOf(day0 + DAY, 6).bytes });
  check(enough !== null, "rows from the day before the epoch's day are refused");
}

await h.destroy?.();
if (failures.length) {
  console.error(`FAIL (${failures.length})\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("PASS");
process.exit(0);

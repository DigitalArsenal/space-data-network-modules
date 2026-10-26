#!/usr/bin/env node
// Native WasmEdge parity of the shared artifact: `propagate` of the same SGP4 and SGP4XP sets, the `fit` method ($OEM
// in; $OMM and $OBD out) on the first set's ephemeris in TEME, GCRF (ERFA) and ITRF, `propagate` on a 4-day GCRF grid
// template, a maneuver across an impulse and a finite burn, an epoch store through propagate_epochs, and the drag
// atmosphere of SPEC 15 (NRLMSISE-00 on $SPW rows times an open-DCA $DCL) on propagate and fit, through the
// browser host and the SDK's wasi-threads WasmEdge runner (WasmEdge 0.16.4); every output's bytes must be
// identical. Docker lane waived (owner ruling 2026-10-22).
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as flatbuffers from "flatbuffers";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { configuration, withConfiguration } from "./lib/pcf.mjs";
// every configured method takes a $PCF (the defaults unless a call names its own)
import { FRAME_PROBE, oemInFrame, packOem, rfm } from "./lib/frames.mjs";
import { OEM } from "spacedatastandards.org/lib/js/OEM/OEM.js";
import { OMM } from "spacedatastandards.org/lib/js/OMM/OMM.js";
import { MNV, MNVT } from "spacedatastandards.org/lib/js/MNV/MNV.js";
import { SPW, SPWT } from "spacedatastandards.org/lib/js/SPW/SPW.js";
import { DCL, DCLT } from "spacedatastandards.org/lib/js/DCL/DCL.js";
import { ATMT } from "spacedatastandards.org/lib/js/DCL/ATM.js";
import { AtmosphericModelFamily } from "spacedatastandards.org/lib/js/DCL/AtmosphericModelFamily.js";
import { dclCorrectionT } from "spacedatastandards.org/lib/js/DCL/dclCorrection.js";
import { dclCorrectionForm } from "spacedatastandards.org/lib/js/DCL/dclCorrectionForm.js";
import { dclStatus } from "spacedatastandards.org/lib/js/DCL/dclStatus.js";
import { pcfWeatherSource } from "spacedatastandards.org/lib/js/PCF/pcfWeatherSource.js";
import { pcfWeatherExtension } from "spacedatastandards.org/lib/js/PCF/pcfWeatherExtension.js";
import { pcfDensityCorrection } from "spacedatastandards.org/lib/js/PCF/pcfDensityCorrection.js";
import { ensureBuilt, openModule, wasmPath } from "./lib/module.mjs";

const standards = await import("space-data-module-sdk/standards");
// The runner: SDM_WASMEDGE_RUNNER_BINARY, else the SDK builds its wasi-threads runner against the local WasmEdge.
async function runnerBinary() {
  if (process.env.SDM_WASMEDGE_RUNNER_BINARY) return process.env.SDM_WASMEDGE_RUNNER_BINARY;
  const testing = path.dirname(fileURLToPath(import.meta.resolve("space-data-module-sdk/testing")));
  const { resolveWasmEdgeWasiThreadsRunner } = await import(pathToFileURL(path.join(testing, "buildWasmEdgeRunner.js")).href);
  return resolveWasmEdgeWasiThreadsRunner({});
}

async function ommSlots() {
  const loader = standards.loadStandardsCatalog ?? standards.resolveStandardsCatalog ?? standards.getStandardsCatalog;
  const loaded = await loader();
  const catalog = Array.isArray(loaded) ? loaded : loaded.catalog;
  const text = catalog.find((c) => c.fileIdentifier === "$OMM").idl.replace(/\/\/.*$/gm, "");
  const unions = new Set([...text.matchAll(/union\s+(\w+)/g)].map((m) => m[1]));
  const body = /table\s+OMM\s*\{([\s\S]*?)\}/.exec(text)[1];
  const declared = [];
  for (const m of body.matchAll(/([A-Za-z_]\w*)\s*:\s*\[?\s*([A-Za-z_][\w.]*)/g)) {
    if (unions.has(m[2])) declared.push(`${m[1]}_type`);
    declared.push(m[1]);
  }
  return { slot: (name) => declared.indexOf(name), count: declared.length };
}

/** A $OMM FlatBuffer with the fields the module reads. */
function ommBytes(slots, o) {
  const b = new flatbuffers.Builder(256);
  const epoch = b.createString(o.epoch);
  b.startObject(slots.count);
  b.addFieldOffset(slots.slot("EPOCH"), epoch, 0);
  for (const [name, value] of Object.entries(o.doubles)) b.addFieldFloat64(slots.slot(name), value, 0);
  b.addFieldInt32(slots.slot("NORAD_CAT_ID"), o.norad, 0);
  b.addFieldInt8(slots.slot("MEAN_ELEMENT_THEORY"), o.theory, 0);
  b.finish(b.endObject(), "$OMM");
  return b.asUint8Array();
}

ensureBuilt();
const slots = await ommSlots();
const sets = [
  { epoch: "2026-10-20T12:00:00.000000", norad: 90001, theory: 1, doubles: { MEAN_MOTION: 15.2, ECCENTRICITY: 0.001, INCLINATION: 51.6, RA_OF_ASC_NODE: 120, ARG_OF_PERICENTER: 90, MEAN_ANOMALY: 30, BSTAR: 0.01, MEAN_MOTION_DDOT: 0.01 } },
  { epoch: "2026-10-20T12:00:00.000000", norad: 90002, theory: 1, doubles: { MEAN_MOTION: 1.0027, ECCENTRICITY: 0.0003, INCLINATION: 0.05, RA_OF_ASC_NODE: 80, ARG_OF_PERICENTER: 10, MEAN_ANOMALY: 200, BSTAR: 0.001, MEAN_MOTION_DDOT: 0.02 } },
  { epoch: "2026-10-20T12:00:00.000000", norad: 90003, theory: 0, doubles: { MEAN_MOTION: 2.006, ECCENTRICITY: 0.72, INCLINATION: 63.4, RA_OF_ASC_NODE: 30, ARG_OF_PERICENTER: 270, MEAN_ANOMALY: 10, BSTAR: 1e-5 } },
];
const inputs = sets.map((o) => ({ portId: "omm", typeRef: { schemaName: "OMM.fbs", fileIdentifier: "$OMM", rootTypeName: "OMM" }, payload: ommBytes(slots, o) }));
const runner = await runnerBinary();
// fit inputs: the first set's ephemeris (browser host), in three frames rotated by the module
const oemType = { schemaName: "OEM.fbs", fileIdentifier: "$OEM", rootTypeName: "OEM" };
let gridInput = null;
const fitInputs = await (async () => {
  const browser = withConfiguration(await createStandaloneHarness("browser", wasmPath, { surface: "command" }));
  const oem = (await browser.invoke({ methodId: "propagate", inputs: [inputs[0]] })).outputs[0].payload;
  const g = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(oem)).unpack();
  const gb = g.EPHEMERIS_DATA_BLOCK[0];
  gb.EPHEMERIS_DATA_LINES = [];
  gb.START_TIME = "2026-10-20T12:00:00.000000";
  gb.STOP_TIME = "2026-10-24T12:00:00.000000";
  gb.STEP_SIZE = 300;
  gb.REFERENCE_FRAME = rfm("GCRF", "both");
  g.EPHEMERIS_DATA_BLOCK = [gb];
  gridInput = { portId: "grid", typeRef: oemType, payload: packOem(g) };
  await browser.destroy?.();
  const direct = await openModule();
  const frames = [["TEME", null], ["GCRF", FRAME_PROBE.TEME_TO_GCRF], ["ITRF", FRAME_PROBE.TEME_TO_EARTH_FIXED]];
  const out = frames.map(([name, mode]) => [{ portId: "ephemeris", typeRef: { schemaName: "OEM.fbs", fileIdentifier: "$OEM", rootTypeName: "OEM" }, payload: oemInFrame(direct, oem, name, mode) }]);
  direct.destroy();
  return out;
})();
// a maneuver (DESIGN 5.1): the first set across an impulse and a 20-minute burn, with the TEME states on a grid
const maneuverInputs = (() => {
  const mk = (start, end, dv) => {
    const t = new MNVT();
    t.ID = "PARITY";
    t.SAT_NO = 90001;
    t.EVENT_START_TIME = start;
    if (end) t.EVENT_END_TIME = end;
    [t.DELTA_VEL_U, t.DELTA_VEL_V, t.DELTA_VEL_W] = dv;
    const b = new flatbuffers.Builder(512);
    MNV.finishMNVBuffer(b, t.pack(b));
    return { portId: "maneuvers", typeRef: { schemaName: "MNV.fbs", fileIdentifier: "$MNV", rootTypeName: "MNV" }, payload: b.asUint8Array() };
  };
  const g = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(gridInput.payload)).unpack();
  g.EPHEMERIS_DATA_BLOCK[0].REFERENCE_FRAME = rfm("TEME", "both");
  return [inputs[0], mk("2026-10-21T00:00:00.000000", null, [2e-4, 1e-3, -5e-4]), mk("2026-10-22T06:00:00.000000", "2026-10-22T06:20:00.000000", [0, 5e-4, 0]),
    { portId: "grid", typeRef: oemType, payload: packOem(g) }];
})();
// an epoch-store snapshot: three SGP4XP sets of one object, 12 h apart, size-prefixed end to end
const epochSnapshot = (() => {
  const recs = [0, 1, 2].map((k) => {
    const b = new flatbuffers.Builder(256);
    const e = b.createString(new Date(Date.parse("2026-10-20T00:00:00Z") + k * 43200000).toISOString().replace("Z", ""));
    OMM.startOMM(b); OMM.addEpoch(b, e); OMM.addMeanMotion(b, 15.06 + 1e-5 * k); OMM.addEccentricity(b, 0.0002); OMM.addInclination(b, 53);
    OMM.addRaOfAscNode(b, 120 - 2.4 * k); OMM.addArgOfPericenter(b, 90); OMM.addMeanAnomaly(b, (30 + 10.8 * k) % 360); OMM.addBstar(b, 0.01);
    OMM.addMeanMotionDdot(b, 0.01); OMM.addNoradCatId(b, 90021); OMM.addMeanElementTheory(b, 1);
    OMM.finishSizePrefixedOMMBuffer(b, OMM.endOMM(b));
    return Buffer.from(b.asUint8Array());
  });
  return { portId: "omm", typeRef: { schemaName: "OMM.fbs", fileIdentifier: "$OMM", rootTypeName: "OMM" }, payload: new Uint8Array(Buffer.concat(recs)) };
})();
// SPEC 15: the drag atmosphere, NRLMSISE-00 on $SPW rows times an open-DCA $DCL, on propagate (the grid) and fit
const atmosphere = (() => {
  const rows = [];
  for (let k = 0; k < 9; k++) {
    const b = new flatbuffers.Builder(256);
    const day = new Date(Date.parse("2026-10-18T00:00:00Z") + k * 86400000).toISOString().slice(0, 10);
    SPW.finishSizePrefixedSPWBuffer(b, Object.assign(new SPWT(), { DATE: day, F107_OBS: 130 + 11 * (k % 3), F107_OBS_CENTER81: 140 + k, AP_AVG: 6 + 7 * (k % 4) }).pack(b));
    rows.push(Buffer.from(b.asUint8Array()));
  }
  const d = Object.assign(new DCLT(), { STATUS: dclStatus.Solved, ATMOSPHERE: Object.assign(new ATMT(), { MODEL: AtmosphericModelFamily.NRLMSIS00E, YEAR: 2000 }),
    CORRECTION: Object.assign(new dclCorrectionT(), { FORM: dclCorrectionForm.LogDensityNodes, NODE_TIMES_MS: [0, 1, 2, 3, 4].map((k) => BigInt(Date.parse("2026-10-19T00:00:00Z") + k * 86400000)), NODE_LOG_DENSITY_SCALE_DIMENSIONLESS: [0.1, -0.05, 0.2, 0, -0.1] }) });
  const db = new flatbuffers.Builder(1024);
  DCL.finishDCLBuffer(db, d.pack(db));
  const forces = { EPHEMERIS_SOURCE: "", ENABLE_DRAG: true, WEATHER_SOURCE: pcfWeatherSource.RECORDS, WEATHER_EXTENSION: pcfWeatherExtension.HOLD_LAST, DENSITY_CORRECTION: pcfDensityCorrection.DCA_COMMON_MODE };
  return [configuration({ theory: "SGP4XP", forces }), { portId: "space_weather", typeRef: { schemaName: "SPW.fbs", fileIdentifier: "$SPW", rootTypeName: "SPW" }, payload: new Uint8Array(Buffer.concat(rows)) },
    { portId: "density_correction", typeRef: { schemaName: "DCL.fbs", fileIdentifier: "$DCL", rootTypeName: "DCL" }, payload: db.asUint8Array() }];
})();
const digest = (result) => ({
  statusCode: result.statusCode,
  errorCode: result.errorCode ?? null,
  outputs: (result.outputs ?? []).map((f) => {
    const bytes = f.payload instanceof Uint8Array ? f.payload : new Uint8Array(f.payload ?? []);
    return { portId: f.portId, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }),
});
const lanes = {};
for (const [lane, options] of [["browser", { surface: "command" }], ["wasmedge", { surface: "command", enableThreads: true, wasmEdgeRunnerBinary: runner }]]) {
  const harness = withConfiguration(await createStandaloneHarness(lane, wasmPath, options));
  const result = await harness.invoke({ methodId: "propagate", inputs });
  lanes[lane] = digest(result);
  lanes[lane].fit = [];
  for (const fitInput of fitInputs) lanes[lane].fit.push(digest(await harness.invoke({ methodId: "fit", inputs: fitInput })));
  lanes[lane].grid = digest(await harness.invoke({ methodId: "propagate", inputs: [...inputs, gridInput] }));
  // DESIGN 5.1: the first set across an impulse and a 20-minute burn, with the TEME states on a grid
  lanes[lane].maneuver = digest(await harness.invoke({ methodId: "maneuver", inputs: maneuverInputs }));
  // SPEC 14: an epoch store of three SGP4XP sets of one object 12 h apart on the grid (selection and blend)
  lanes[lane].epochs = digest(await harness.invoke({ methodId: "propagate_epochs", inputs: [configuration({}), epochSnapshot, gridInput] }));
  // SPEC 15: NRLMSISE-00 on the rows times the open DCA, propagate on the grid and fit
  lanes[lane].atmosphere = digest(await harness.invoke({ methodId: "propagate", inputs: [inputs[0], gridInput, ...atmosphere] }));
  lanes[lane].atmosphereFit = digest(await harness.invoke({ methodId: "fit", inputs: [...fitInputs[1], ...atmosphere] }));
  await harness.destroy?.();
}
const identical = JSON.stringify(lanes.browser) === JSON.stringify(lanes.wasmedge) && lanes.browser.statusCode === 0 && lanes.browser.outputs.length === sets.length &&
  lanes.browser.fit.every((f) => f.statusCode === 0 && f.outputs.length === 2) && lanes.browser.grid.statusCode === 0 &&
  lanes.browser.maneuver.statusCode === 0 && lanes.browser.maneuver.outputs.length === 5 && lanes.browser.epochs.statusCode === 0 &&
  lanes.browser.atmosphere.statusCode === 0 && lanes.browser.atmosphereFit.statusCode === 0 && lanes.browser.atmosphereFit.outputs.length === 2;
console.log(JSON.stringify({ wasmedge: "0.16.4 (SDK wasi-threads runner)", browser: lanes.browser, native: lanes.wasmedge, identical }, null, 1));
process.exit(identical ? 0 : 1);

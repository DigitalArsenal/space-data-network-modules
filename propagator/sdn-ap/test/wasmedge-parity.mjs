#!/usr/bin/env node
// Native WasmEdge parity of the shared artifact: `propagate` of the same SGP4 and SGP4XP $OCM sets (each alone, the
// SGP4 one through ingest_omm), the `fit` method ($OEM in; one $OCM out) on the first set's ephemeris in TEME, GCRF
// (ERFA) and ITRF, `propagate` at the $PCF OUTPUT times of 4 days in GCRF, a maneuver across an impulse and a finite
// burn, an epoch store through propagate_epochs, and the drag atmosphere of SPEC 15 (an AP $OCM carrying its
// NRLMSISE-00 rows and open-DCA nodes; the fit under those FORCES on $SPW rows and a $DCL), a fit under LOG_NORMAL
// priors on BTERM and AGOM, through the browser host and the SDK's wasi-threads WasmEdge runner (WasmEdge 0.16.4); every
// output's bytes must be identical. Docker lane waived (owner ruling 2026-10-22).
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as flatbuffers from "flatbuffers";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { configuration, pcfPriorForm, prior, withConfiguration, XP_FORCES, MSIS_FORCES } from "./lib/pcf.mjs";
import { seedOcm, rowsThrough } from "./lib/ocm.mjs";
// every configured method takes a $PCF (the defaults unless a call names its own)
import { FRAME_PROBE, oemInFrame, packOem, rfm } from "./lib/frames.mjs";
import { OEM } from "spacedatastandards.org/lib/js/OEM/OEM.js";
import { OMM, OMMT } from "spacedatastandards.org/lib/js/OMM/OMM.js";
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

// The runner: SDM_WASMEDGE_RUNNER_BINARY, else the SDK builds its wasi-threads runner against the local WasmEdge.
async function runnerBinary() {
  if (process.env.SDM_WASMEDGE_RUNNER_BINARY) return process.env.SDM_WASMEDGE_RUNNER_BINARY;
  const testing = path.dirname(fileURLToPath(import.meta.resolve("space-data-module-sdk/testing")));
  const { resolveWasmEdgeWasiThreadsRunner } = await import(pathToFileURL(path.join(testing, "buildWasmEdgeRunner.js")).href);
  return resolveWasmEdgeWasiThreadsRunner({});
}

ensureBuilt();
const OCM_T = { schemaName: "OCM.fbs", fileIdentifier: "$OCM", rootTypeName: "OCM" };
const EPOCH = "2026-10-20T12:00:00.000000";
// two SGP4XP sets and an SGP4 set (an $OMM through the one boundary, ingest_omm)
const sgp4Ocm = await (async () => {
  const t = Object.assign(new OMMT(), { EPOCH, NORAD_CAT_ID: 90003, MEAN_ELEMENT_THEORY: 0, MEAN_MOTION: 2.006, ECCENTRICITY: 0.72, INCLINATION: 63.4, RA_OF_ASC_NODE: 30,
    ARG_OF_PERICENTER: 270, MEAN_ANOMALY: 10, BSTAR: 1e-5 });
  const b = new flatbuffers.Builder(512);
  OMM.finishOMMBuffer(b, t.pack(b));
  const h = await createStandaloneHarness("browser", wasmPath, { surface: "command" });
  const r = await h.invoke({ methodId: "ingest_omm", inputs: [{ portId: "omm", typeRef: { schemaName: "OMM.fbs", fileIdentifier: "$OMM", rootTypeName: "OMM" }, payload: b.asUint8Array() }] });
  await h.destroy?.();
  if (r.statusCode !== 0) throw new Error(`ingest_omm: ${r.errorCode} ${r.errorMessage}`);
  return new Uint8Array(r.outputs[0].payload);
})();
const sets = [
  seedOcm({ epoch: EPOCH, norad: 90001, n: 15.2, e: 0.001, i: 51.6, raan: 120, argp: 90, ma: 30, bterm: 0.01, agom: 0.01 }),
  seedOcm({ epoch: EPOCH, norad: 90002, n: 1.0027, e: 0.0003, i: 0.05, raan: 80, argp: 10, ma: 200, bterm: 0.001, agom: 0.02 }),
  sgp4Ocm,
];
const inputs = sets.map((payload) => ({ portId: "ocm", typeRef: OCM_T, payload }));
const GRID = { START_TIME: "2026-10-20T12:00:00.000000", STOP_TIME: "2026-10-24T12:00:00.000000", STEP_SECONDS: 300 };
const runner = await runnerBinary();
// fit inputs: the first set's ephemeris (browser host), in three frames rotated by the module
const oemType = { schemaName: "OEM.fbs", fileIdentifier: "$OEM", rootTypeName: "OEM" };
const gridInput = configuration({ output: { ...GRID, FRAME: 2 } });  // GCRF
const fitInputs = await (async () => {
  const browser = withConfiguration(await createStandaloneHarness("browser", wasmPath, { surface: "command" }));
  const oem = (await browser.invoke({ methodId: "propagate", inputs: [inputs[0]] })).outputs[0].payload;
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
  return [inputs[0], mk("2026-10-21T00:00:00.000000", null, [2e-4, 1e-3, -5e-4]), mk("2026-10-22T06:00:00.000000", "2026-10-22T06:20:00.000000", [0, 5e-4, 0]),
    configuration({ output: GRID })];
})();
// an epoch-store snapshot: three SGP4XP sets of one object, 12 h apart, size-prefixed end to end
const prefixed = (plain) => { const b = Buffer.alloc(4 + plain.length); b.writeUInt32LE(plain.length, 0); Buffer.from(plain).copy(b, 4); return b; };
const epochSnapshot = { portId: "ocm", typeRef: OCM_T, payload: new Uint8Array(Buffer.concat([0, 1, 2].map((k) => prefixed(seedOcm({
  epoch: new Date(Date.parse("2026-10-20T00:00:00Z") + k * 43200000).toISOString().replace("Z", ""), norad: 90021, n: 15.06 + 1e-5 * k, e: 0.0002, i: 53,
  raan: 120 - 2.4 * k, argp: 90, ma: (30 + 10.8 * k) % 360, bterm: 0.01, agom: 0.01 }))))) };
// SPEC 15: the drag atmosphere, NRLMSISE-00 on daily rows times the open-DCA nodes: an AP $OCM carrying them (propagate),
// and the fit under those FORCES on $SPW rows and a $DCL
const atmosphere = (() => {
  const values = [];
  for (let k = 0; k < 9; k++) {
    const day = new Date(Date.parse("2026-10-18T00:00:00Z") + k * 86400000).toISOString().slice(0, 10);
    values.push({ DATE: day, F107_OBS: 130 + 11 * (k % 3), F107_OBS_CENTER81: 140 + k, AP_AVG: 6 + 7 * (k % 4) });
  }
  const rows = rowsThrough(values);
  const nodes = [0, 1, 2, 3, 4].map((k) => Date.parse("2026-10-19T00:00:00Z") + k * 86400000), s = [0.1, -0.05, 0.2, 0, -0.1];
  const d = Object.assign(new DCLT(), { STATUS: dclStatus.Solved, ATMOSPHERE: Object.assign(new ATMT(), { MODEL: AtmosphericModelFamily.NRLMSIS00E, YEAR: 2000 }),
    CORRECTION: Object.assign(new dclCorrectionT(), { FORM: dclCorrectionForm.LogDensityNodes, NODE_TIMES_MS: nodes.map(BigInt), NODE_LOG_DENSITY_SCALE_DIMENSIONLESS: s }) });
  const db = new flatbuffers.Builder(1024);
  DCL.finishDCLBuffer(db, d.pack(db));
  const spw = Buffer.concat(rows.map((r) => { const b = new flatbuffers.Builder(256); SPW.finishSizePrefixedSPWBuffer(b, r.pack(b)); return b.asUint8Array(); }));
  const forces = { ...MSIS_FORCES, WEATHER_SOURCE: pcfWeatherSource.RECORDS, DENSITY_CORRECTION: pcfDensityCorrection.DCA_COMMON_MODE };
  const record = seedOcm({ epoch: EPOCH, norad: 90001, n: 15.2, e: 0.001, i: 51.6, raan: 120, argp: 90, ma: 30, bterm: 0.01, agom: 0.01, msis: true, rows, dca: { ms: nodes, s } });
  return { record: { portId: "ocm", typeRef: OCM_T, payload: record },
    fit: [configuration({ forces, fit: { WEATHER_HORIZON_DAYS: 5 } }), { portId: "space_weather", typeRef: { schemaName: "SPW.fbs", fileIdentifier: "$SPW", rootTypeName: "SPW" }, payload: new Uint8Array(spw) },
      { portId: "density_correction", typeRef: { schemaName: "DCL.fbs", fileIdentifier: "$DCL", rootTypeName: "DCL" }, payload: db.asUint8Array() }] };
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
  const result = { statusCode: 0, outputs: [] };
  for (const input of inputs) {
    const r = await harness.invoke({ methodId: "propagate", inputs: [input] });
    if (r.statusCode !== 0) { result.statusCode = r.statusCode; result.errorCode = r.errorCode; }
    result.outputs.push(...(r.outputs ?? []));
  }
  lanes[lane] = digest(result);
  lanes[lane].fit = [];
  for (const fitInput of fitInputs) lanes[lane].fit.push(digest(await harness.invoke({ methodId: "fit", inputs: fitInput })));
  lanes[lane].grid = digest(await harness.invoke({ methodId: "propagate", inputs: [inputs[0], gridInput] }));
  // DESIGN 5.1: the first set across an impulse and a 20-minute burn, with the TEME states on a grid
  lanes[lane].maneuver = digest(await harness.invoke({ methodId: "maneuver", inputs: maneuverInputs }));
  // SPEC 14: an epoch store of three SGP4XP sets of one object 12 h apart on the grid (selection and blend)
  lanes[lane].epochs = digest(await harness.invoke({ methodId: "propagate_epochs", inputs: [epochSnapshot, gridInput] }));
  // SPEC 15: NRLMSISE-00 on the rows times the open DCA, propagate at the OUTPUT times and fit
  lanes[lane].atmosphere = digest(await harness.invoke({ methodId: "propagate", inputs: [atmosphere.record, gridInput] }));
  lanes[lane].atmosphereFit = digest(await harness.invoke({ methodId: "fit", inputs: [...fitInputs[1], ...atmosphere.fit] }));
  // $PCF 1.0.6: the fit estimating ln BTERM and ln AGOM under LOG_NORMAL priors N(ln 0.01, ln 10)
  lanes[lane].logNormalFit = digest(await harness.invoke({ methodId: "fit", inputs: [...fitInputs[0], configuration({ theory: "SGP4XP", forces: XP_FORCES, fit: {
    DRAG_PRIOR: prior(0.01, Math.LN10), DRAG_PRIOR_FORM: pcfPriorForm.LOG_NORMAL, SRP_PRIOR: prior(0.01, Math.LN10), SRP_PRIOR_FORM: pcfPriorForm.LOG_NORMAL } })] }));
  await harness.destroy?.();
}
const identical = JSON.stringify(lanes.browser) === JSON.stringify(lanes.wasmedge) && lanes.browser.statusCode === 0 && lanes.browser.outputs.length === sets.length &&
  lanes.browser.fit.every((f) => f.statusCode === 0 && f.outputs.length === 1) && lanes.browser.grid.statusCode === 0 &&
  lanes.browser.maneuver.statusCode === 0 && lanes.browser.maneuver.outputs.length === 5 && lanes.browser.epochs.statusCode === 0 &&
  lanes.browser.atmosphere.statusCode === 0 && lanes.browser.atmosphereFit.statusCode === 0 && lanes.browser.atmosphereFit.outputs.length === 1 &&
  lanes.browser.logNormalFit.statusCode === 0 && lanes.browser.logNormalFit.outputs.length === 1;
console.log(JSON.stringify({ wasmedge: "0.16.4 (SDK wasi-threads runner)", browser: lanes.browser, native: lanes.wasmedge, identical }, null, 1));
process.exit(identical ? 0 : 1);

#!/usr/bin/env node
// Native WasmEdge parity of the shared artifact (with the SDN-AP segment sets: propagate, fit SDNAP, propagate; and an osculating $OPM through opm_set and propagate): the `propagate` method (one $OMM in, one $OEM out) invoked with the
// same SGP4 and SGP4XP sets, and the `fit` method ($OEM in; $OMM and $OBD out) on the first set's ephemeris in TEME,
// GCRF (ERFA) and ITRF, `propagate` on a 4-day GCRF grid template, and SDN-AP: `fit` (THEORY SDNAP) on the TEME ephemeris
// (NRLMSISE-00 drag through the shared kernel, the 2d tesseral terms) and its set propagated on the grid, a
// Moon-centered set (2h.1: GRGM660PRIM, the DE440 PA orientation) propagated on a grid, through
// the browser host and the SDK's wasi-threads WasmEdge runner (WasmEdge 0.16.4); every output's bytes must be
// identical. Docker lane waived (owner ruling 2026-10-22).
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as flatbuffers from "flatbuffers";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { configuration, withConfiguration } from "./lib/pcf.mjs";
// every configured method takes a $PCF (the defaults unless a call names its own); THEORY SDNAP selects the SDN-AP fit
const SDNAP = configuration({ theory: "SDNAP" });
import { FRAME_PROBE, oemInFrame, packOem, rfm } from "./lib/frames.mjs";
import { OEM } from "spacedatastandards.org/lib/js/OEM/OEM.js";
import { OMM } from "spacedatastandards.org/lib/js/OMM/OMM.js";
import { OMMUserDefinedParameter } from "spacedatastandards.org/lib/js/OMM/OMMUserDefinedParameter.js";
import { MNV, MNVT } from "spacedatastandards.org/lib/js/MNV/MNV.js";
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
let gridInput = null, lunarGrid = null;
// a Moon-centered SDN-AP set (2h.1): 100 km polar
const lunarOmm = (() => {
  const b = new flatbuffers.Builder(1024);
  // light term sets (degree 8 averaged, 4 short-periodic): the native lane interprets the module
  const params = [["SDNAP_REGIME", "MOON"], ["SDNAP_LUNAR_DEGREE", "8"], ["SDNAP_LUNAR_SHORT_DEGREE", "4"]]
    .map(([k, v]) => OMMUserDefinedParameter.createOMMUserDefinedParameter(b, b.createString(k), b.createString(v)));
  const vec = OMM.createUserDefinedParametersVector(b, params);
  const epoch = b.createString("2026-06-01T00:00:00.000000"), center = b.createString("MOON");
  OMM.startOMM(b);
  OMM.addEpoch(b, epoch);
  OMM.addCenterName(b, center);
  OMM.addMeanMotion(b, 86400 / (2 * Math.PI * Math.sqrt(1838.0 ** 3 / 4902.7998)));
  OMM.addEccentricity(b, 0.01);
  OMM.addInclination(b, 90);
  OMM.addRaOfAscNode(b, 30);
  OMM.addArgOfPericenter(b, 90);
  OMM.addMeanAnomaly(b, 10);
  OMM.addNoradCatId(b, 90010);
  OMM.addMeanElementTheory(b, 4);
  OMM.addUserDefinedParameters(b, vec);
  OMM.finishOMMBuffer(b, OMM.endOMM(b));
  return b.asUint8Array();
})();
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
  const lg = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(oem)).unpack();
  const lb = lg.EPHEMERIS_DATA_BLOCK[0];
  lb.EPHEMERIS_DATA_LINES = [];
  lb.START_TIME = "2026-06-01T00:00:00.000000";
  lb.STOP_TIME = "2026-06-01T12:00:00.000000";
  lb.STEP_SIZE = 600;
  lb.REFERENCE_FRAME = rfm("GCRF", "both");
  lb.CENTER_NAME = "MOON";
  lg.EPHEMERIS_DATA_BLOCK = [lb];
  lunarGrid = { portId: "grid", typeRef: oemType, payload: packOem(lg) };
  await browser.destroy?.();
  const direct = await openModule();
  const frames = [["TEME", null], ["GCRF", FRAME_PROBE.TEME_TO_GCRF], ["ITRF", FRAME_PROBE.TEME_TO_EARTH_FIXED]];
  const out = frames.map(([name, mode]) => [{ portId: "ephemeris", typeRef: { schemaName: "OEM.fbs", fileIdentifier: "$OEM", rootTypeName: "OEM" }, payload: oemInFrame(direct, oem, name, mode) }]);
  direct.destroy();
  return out;
})();
// SDN-AP segment sets (2h.2 / 2h.3): an NRHO-like Moon-centered set, an Earth orbit reaching the Moon and a thrusting
// cruise set; each lane propagates the set, fits the browser lane's ephemeris of it and propagates the fitted set
const segmentCases = await (async () => {
  const set = ({ center, gm, a, e, i, raan, argp, ma, params }) => {
    const b = new flatbuffers.Builder(1024);
    const ps = [...params].map(([k, v]) => OMMUserDefinedParameter.createOMMUserDefinedParameter(b, b.createString(k), b.createString(String(v))));
    const vec = OMM.createUserDefinedParametersVector(b, ps);
    const epoch = b.createString("2026-06-01T00:00:00.000000"), c = b.createString(center);
    OMM.startOMM(b);
    OMM.addEpoch(b, epoch);
    OMM.addCenterName(b, c);
    OMM.addSemiMajorAxis(b, a);
    OMM.addGm(b, gm);
    OMM.addMeanMotion(b, (Math.sqrt(gm / Math.abs(a) ** 3) * 86400) / (2 * Math.PI));
    OMM.addEccentricity(b, e);
    OMM.addInclination(b, i);
    OMM.addRaOfAscNode(b, raan);
    OMM.addArgOfPericenter(b, argp);
    OMM.addMeanAnomaly(b, ma);
    OMM.addNoradCatId(b, 90020);
    OMM.addMeanElementTheory(b, 4);
    OMM.addUserDefinedParameters(b, vec);
    OMM.finishOMMBuffer(b, OMM.endOMM(b));
    return b.asUint8Array();
  };
  const grid = (center, hours, step) => {
    const g = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(gridInput.payload)).unpack();
    const gb = g.EPHEMERIS_DATA_BLOCK[0];
    gb.START_TIME = "2026-06-01T00:00:00.000000";
    gb.STOP_TIME = new Date(Date.parse("2026-06-01T00:00:00Z") + hours * 3600e3).toISOString().replace("Z", "000");
    gb.STEP_SIZE = step;
    gb.CENTER_NAME = center;
    g.EPHEMERIS_DATA_BLOCK = [gb];
    return { portId: "grid", typeRef: oemType, payload: packOem(g) };
  };
  const cases = [
    { omm: set({ center: "MOON", gm: 4902.79980693169, a: 37000, e: 0.9, i: 88, raan: 30, argp: 90, ma: 180, params: [["SDNAP_REGIME", "CISLUNAR"], ["SDNAP_AGOM", 0.01]] }), grid: grid("MOON", 24, 1800) },
    { omm: set({ center: "EARTH", gm: 398600.4418, a: 250000, e: 0.7, i: 28.5, raan: 40, argp: 10, ma: 20, params: [["SDNAP_REGIME", "CISLUNAR"], ["SDNAP_AGOM", 0.01]] }), grid: grid("EARTH", 24, 1800) },
    { omm: set({ center: "SUN", gm: 1.32712440018e11, a: 2.244e8, e: 0.2, i: 23.4, raan: 5, argp: 60, ma: 40, params: [["SDNAP_REGIME", "HELIO"], ["SDNAP_BETA", 1e-5], ["SDNAP_RTN_T", 5e-8]] }), grid: grid("SUN", 240, 21600) },
  ];
  const browser = withConfiguration(await createStandaloneHarness("browser", wasmPath, { surface: "command" }));
  for (const c of cases) {
    const r = await browser.invoke({ methodId: "propagate", inputs: [{ ...inputs[0], payload: c.omm }, c.grid] });
    c.ephemeris = [{ portId: "ephemeris", typeRef: oemType, payload: r.outputs[0].payload }];
  }
  await browser.destroy?.();
  return cases;
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
// launch (5.3.1, $LAM and $BOV), the batch (5.3.3), reentry (5.2) and detection (5.1.4): small inputs (the native lane
// interprets the module)
const eventInputs = await (async () => {
  const { LAM, LAMT } = await import("spacedatastandards.org/lib/js/LAM/LAM.js");
  const { lamInsertionOrbitT } = await import("spacedatastandards.org/lib/js/LAM/lamInsertionOrbit.js");
  const t = new LAMT();
  t.MISSION_NAME = "PARITY";
  t.INSERTION = new lamInsertionOrbitT("2026-10-20T12:00:00.000000", 600, "TEME", 6778137, 0.001, 53, 100, 80, 30);
  const lb = new flatbuffers.Builder(512);
  LAM.finishLAMBuffer(lb, t.pack(lb));
  const launch = [{ portId: "launch", typeRef: { schemaName: "LAM.fbs", fileIdentifier: "$LAM", rootTypeName: "LAM" }, payload: lb.asUint8Array() }];
  // a low SDN-AP set (perigee near 170 km: the hand-off at once)
  const b = new flatbuffers.Builder(256);
  const epoch = b.createString("2026-10-20T12:00:00.000000");
  OMM.startOMM(b);
  OMM.addEpoch(b, epoch);
  OMM.addMeanMotion(b, 16.32);
  OMM.addEccentricity(b, 0.0003);
  OMM.addInclination(b, 51.6);
  OMM.addRaOfAscNode(b, 40);
  OMM.addArgOfPericenter(b, 90);
  OMM.addMeanAnomaly(b, 10);
  OMM.addNoradCatId(b, 90041);
  OMM.addMeanElementTheory(b, 4);
  OMM.addBstar(b, 0.03);
  OMM.finishOMMBuffer(b, OMM.endOMM(b));
  const low = [{ ...inputs[0], payload: b.asUint8Array() }];
  // a 6 h TEME ephemeris of the first set for the detector (72 states)
  const browser = withConfiguration(await createStandaloneHarness("browser", wasmPath, { surface: "command" }));
  const g = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(gridInput.payload)).unpack();
  const gb = g.EPHEMERIS_DATA_BLOCK[0];
  gb.REFERENCE_FRAME = rfm("TEME", "both");
  gb.STOP_TIME = "2026-10-20T18:00:00.000000";
  g.EPHEMERIS_DATA_BLOCK = [gb];
  const eph = (await browser.invoke({ methodId: "propagate", inputs: [inputs[0], { portId: "grid", typeRef: oemType, payload: packOem(g) }] })).outputs[0].payload;
  // the batch (5.3.3): two objects' 2 h TEME arcs of the launch's first set
  const first = (await browser.invoke({ methodId: "launch_set", inputs: launch })).outputs.find((o) => o.portId === "elements").payload;
  gb.STOP_TIME = "2026-10-20T14:00:00.000000";
  const arc = (await browser.invoke({ methodId: "propagate", inputs: [{ ...inputs[0], payload: first }, { portId: "grid", typeRef: oemType, payload: packOem(g) }] })).outputs[0].payload;
  await browser.destroy?.();
  // a $BOV burnout vector (Earth-fixed km, km/s)
  const { BOV, BOVT } = await import("spacedatastandards.org/lib/js/BOV/BOV.js");
  const bb = new flatbuffers.Builder(256);
  BOV.finishBOVBuffer(bb, new BOVT(6778.137, 0, 0, 0, 4.6, 6.0, "2026-10-20T12:00:00.000000", 600).pack(bb));
  const burnout = [{ portId: "burnout", typeRef: { schemaName: "BOV.fbs", fileIdentifier: "$BOV", rootTypeName: "BOV" }, payload: bb.asUint8Array() }];
  const batch = [...launch, ...[0, 1].map(() => ({ portId: "ephemeris", typeRef: oemType, payload: arc }))];
  return { launch, low, burnout, batch, detect: [{ portId: "ephemeris", typeRef: oemType, payload: eph }] };
})();
// an osculating $OPM: an HEO Keplerian block (EME2000, UTC, GM) with a covariance
const opmInput = await (async () => {
  const { OPM, OPMT } = await import("spacedatastandards.org/lib/js/OPM/OPM.js");
  const t = Object.assign(new OPMT(), { CCSDS_OPM_VERS: "2.0", ORIGINATOR: "SDN-AP parity", OBJECT_NAME: "PARITY HEO", CENTER_NAME: "EARTH", REF_FRAME: "EME2000",
    TIME_SYSTEM: "UTC", EPOCH: "2026-10-20T12:00:00.000Z", SEMI_MAJOR_AXIS: 24974.9, ECCENTRICITY: 0.68526, INCLINATION: 34.018, RA_OF_ASC_NODE: 243.148,
    ARG_OF_PERICENTER: 189.804, TRUE_ANOMALY: 170.3, GM: 398600.4418, COV_REF_FRAME: "EME2000",
    COVARIANCE: [1e-2, 1e-3, 2e-2, 1e-4, 2e-4, 3e-2, 1e-6, 2e-6, 3e-6, 1e-8, 2e-6, 1e-6, 4e-6, 1e-9, 2e-8, 3e-6, 2e-6, 1e-6, 1e-9, 1e-9, 3e-8] });
  const b = new flatbuffers.Builder(1024);
  OPM.finishSizePrefixedOPMBuffer(b, t.pack(b));
  return { portId: "opm", typeRef: { schemaName: "OPM.fbs", fileIdentifier: "$OPM", rootTypeName: "OPM" }, payload: b.asUint8Array() };
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
  const sdnap = await harness.invoke({ methodId: "fit", inputs: [SDNAP, ...fitInputs[0]] });
  lanes[lane].fitSdnap = digest(sdnap);
  const elements = (sdnap.outputs ?? []).find((o) => o.portId === "elements");
  lanes[lane].sdnapGrid = elements ? digest(await harness.invoke({ methodId: "propagate", inputs: [{ ...inputs[0], payload: elements.payload }, gridInput] })) : null;
  const lunar = await harness.invoke({ methodId: "propagate", inputs: [{ ...inputs[0], payload: lunarOmm }, lunarGrid] });
  lanes[lane].lunar = digest(lunar);
  // (the lunar fit, degree-50 term sets for every Jacobian column, is left to the browser lane's fit E2E: the
  // native lane interprets the module and takes tens of minutes on it)
  lanes[lane].maneuver = digest(await harness.invoke({ methodId: "maneuver", inputs: maneuverInputs }));
  lanes[lane].launch = digest(await harness.invoke({ methodId: "launch_set", inputs: eventInputs.launch }));
  lanes[lane].reentry = digest(await harness.invoke({ methodId: "reentry", inputs: eventInputs.low }));
  lanes[lane].detect = digest(await harness.invoke({ methodId: "detect_maneuvers", inputs: eventInputs.detect }));
  lanes[lane].bov = digest(await harness.invoke({ methodId: "launch_set", inputs: eventInputs.burnout }));
  // SPEC 13: an osculating $OPM (an HEO Keplerian block with a covariance, EME2000) through opm_set and through propagate
  lanes[lane].opmSet = digest(await harness.invoke({ methodId: "opm_set", inputs: [SDNAP, opmInput] }));
  lanes[lane].opmGrid = digest(await harness.invoke({ methodId: "propagate", inputs: [SDNAP, opmInput, gridInput] }));
  lanes[lane].batch = digest(await harness.invoke({ methodId: "launch_batch", inputs: eventInputs.batch }));
  lanes[lane].segments = [];
  for (const c of segmentCases) {
    const prop = digest(await harness.invoke({ methodId: "propagate", inputs: [{ ...inputs[0], payload: c.omm }, c.grid] }));
    const fitted = await harness.invoke({ methodId: "fit", inputs: [SDNAP, ...c.ephemeris] });
    const el = (fitted.outputs ?? []).find((o) => o.portId === "elements");
    const again = el ? digest(await harness.invoke({ methodId: "propagate", inputs: [{ ...inputs[0], payload: el.payload }, c.grid] })) : null;
    lanes[lane].segments.push({ prop, fit: digest(fitted), again });
  }
  await harness.destroy?.();
}
const identical = JSON.stringify(lanes.browser) === JSON.stringify(lanes.wasmedge) && lanes.browser.statusCode === 0 && lanes.browser.outputs.length === sets.length &&
  lanes.browser.fit.every((f) => f.statusCode === 0 && f.outputs.length === 2) && lanes.browser.grid.statusCode === 0 &&
  lanes.browser.fitSdnap.statusCode === 0 && lanes.browser.sdnapGrid?.statusCode === 0 &&
  lanes.browser.lunar.statusCode === 0 &&
  lanes.browser.segments.every((c) => c.prop.statusCode === 0 && c.fit.statusCode === 0 && c.again?.statusCode === 0) &&
  lanes.browser.maneuver.statusCode === 0 && lanes.browser.maneuver.outputs.length === 5 &&
  lanes.browser.launch.statusCode === 0 && lanes.browser.reentry.statusCode === 0 && lanes.browser.detect.statusCode === 0 &&
  lanes.browser.bov.statusCode === 0 && lanes.browser.batch.statusCode === 0 && lanes.browser.batch.outputs.length === 2 &&
  lanes.browser.opmSet.statusCode === 0 && lanes.browser.opmGrid.statusCode === 0;
console.log(JSON.stringify({ wasmedge: "0.16.4 (SDK wasi-threads runner)", browser: lanes.browser, native: lanes.wasmedge, identical }, null, 1));
process.exit(identical ? 0 : 1);

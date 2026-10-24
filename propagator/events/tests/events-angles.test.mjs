// The SHIPPED event-locator artifact on a Kepler orbit: a goal on the true anomaly, the latitude
// extrema and a crossing of an arbitrary plane, measured on the wire against the closed form.
//
// The orbit is the two-body problem in 60-digit arithmetic (the reference the FFM E2E uses), sampled
// every 10 s into an $OEM; the module makes the table continuous by Hermite interpolation and
// finds the roots, so the bar is the interpolation of a 10 s table, 1 ms.
//
// The $EVL bindings are generated here from the installed schema, so the test reads whatever
// $EVL the installed spacedatastandards.org defines.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripTypeScriptTypes } from "node:module";

import * as flatbuffers from "flatbuffers";
import createFlatc from "flatc-wasm/module";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";
import { orbit as keplerOrbit } from "../../ffm/tests/lib/keplerReference.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
const wasmPath = path.join(packageRoot, "dist", "isomorphic", "module.wasm");
const standardsRoot = path.join(packageRoot, "node_modules", "spacedatastandards.org");

async function generateBindings() {
  const flatc = await createFlatc();
  const mkdir = (p) => { try { flatc.FS.mkdir(p); } catch { /* exists */ } };
  for (const p of ["/schemas", "/out"]) mkdir(p);
  for (const family of fs.readdirSync(path.join(standardsRoot, "schema"))) {
    const input = path.join(standardsRoot, "schema", family, "main.fbs");
    if (!fs.existsSync(input)) continue;
    mkdir(`/schemas/${family}`);
    flatc.FS.writeFile(`/schemas/${family}/main.fbs`, fs.readFileSync(input, "utf8"));
  }
  const rc = flatc.callMain(["--ts", "--gen-object-api", "--gen-all", "--preserve-case", "--no-warnings",
    "-I", "/schemas", "-o", "/out", "/schemas/EVL/main.fbs"]);
  assert.equal(rc, 0, "flatc failed on $EVL");
  // Inside node_modules, so the generated files resolve `flatbuffers` like any dependency.
  const target = path.join(packageRoot, "node_modules", ".cache", "evl-bindings");
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  const write = (dir) => {
    for (const name of flatc.FS.readdir(dir)) {
      if (name === "." || name === "..") continue;
      const file = `${dir}/${name}`;
      if (flatc.FS.isDir(flatc.FS.stat(file).mode)) write(file);
      else if (name.endsWith(".ts")) {
        const out = path.join(target, file.slice("/out/".length).replace(/\.ts$/, ".js"));
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, stripTypeScriptTypes(flatc.FS.readFile(file, { encoding: "utf8" }), { mode: "transform", sourceMap: false }));
      }
    }
  };
  write("/out");
  return { target, module: await import(pathToFileURL(path.join(target, "main.js")).href) };
}

const { target, module: sds } = await generateBindings();
process.on("exit", () => fs.rmSync(target, { recursive: true, force: true }));
const { OEM, OEMT, ephemerisDataBlockT, ephemerisDataLineT } = await import("spacedatastandards.org/lib/js/OEM/main.js");

const MU = 398600.4418;                         // km^3/s^2
const START = Date.UTC(2026, 7, 29, 0, 0, 0);
const iso = (seconds) => new Date(START + seconds * 1000).toISOString().replace("Z", "");
const ORBIT = { a: 9000, e: 0.3, i: 1.107, raan: 0.4, argp: 1.2, meanAnomaly0: 0.3 };
const reference = keplerOrbit({ ...ORBIT, mu: MU });
const SPAN = 2.2 * reference.period_s;
const wrap = (x) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

function ephemeris() {
  const builder = new flatbuffers.Builder(1 << 22);
  const lines = [];
  for (let t = 0; t <= SPAN + 10; t += 10) {
    const { position, velocity } = reference.state(t);
    const line = new ephemerisDataLineT();
    Object.assign(line, { EPOCH: iso(t), X: position[0], Y: position[1], Z: position[2], X_DOT: velocity[0], Y_DOT: velocity[1], Z_DOT: velocity[2] });
    lines.push(line);
  }
  const block = new ephemerisDataBlockT();
  block.EPHEMERIS_DATA_LINES = lines;
  const message = new OEMT();
  message.EPHEMERIS_DATA_BLOCK = [block];
  OEM.finishOEMBuffer(builder, message.pack(builder));
  return builder.asUint8Array().slice();
}

const type = (family) => ({ schemaName: `${family}.fbs`, fileIdentifier: `$${family}`, rootTypeName: family });
async function locate(configure) {
  const harness = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(wasmPath),
    manifest: JSON.parse(fs.readFileSync(path.join(packageRoot, "plugin-manifest.json"), "utf8")), surface: "direct" });
  try {
    const builder = new flatbuffers.Builder(1 << 16);
    const request = new sds.EVLEventLocationRequestT();
    request.CONTEXT = new sds.PCEEvaluationContextT();
    Object.assign(request.CONTEXT, { CENTRAL_BODY_ID: 399, GRAVITATIONAL_PARAMETER: MU * 1e9, EQUATORIAL_RADIUS_M: 6378137.0, FLATTENING: 1 / 298.257223563 });
    Object.assign(request, { SCAN_START_EPOCH: iso(0), SCAN_STOP_EPOCH: iso(SPAN), EPOCH_TIME_SYSTEM: "UTC", SCAN_STEP_SECONDS: 30, REFINEMENT_TOLERANCE_SECONDS: 1e-9 });
    configure(request);
    const evl = new sds.EVLT();
    evl.LOCATION_REQUEST = request;
    sds.EVL.finishEVLBuffer(builder, evl.pack(builder));
    const response = await harness.invoke({ methodId: "locate_events", inputs: [
      { portId: "request", typeRef: type("EVL"), payload: builder.asUint8Array().slice() },
      { portId: "ephemeris", typeRef: type("OEM"), payload: ephemeris() }] });
    assert.equal(response.statusCode, 0, response.errorMessage);
    const report = sds.EVL.getRootAsEVL(new flatbuffers.ByteBuffer(response.outputs.find((o) => o.portId === "report").payload)).unpack().EVENT_REPORT;
    assert.equal(report.STATUS, sds.evlResultStatus.OK, report.ERROR_MESSAGE);
    return report.EVENTS.map((e) => ({ type: e.EVENT_TYPE, t: (Date.parse(`${e.START_EPOCH}Z`) - START) / 1000 }));
  } finally {
    await harness.destroy?.();
  }
}
const epochs = (nus) => {
  const out = [];
  for (const nu of nus) for (let t = reference.timeOfTrueAnomaly(nu, 0); t < SPAN; t += reference.period_s) out.push(t);
  return out.sort((a, b) => a - b);
};
const assertEpochs = (found, expected, label) => {
  assert.equal(found.length, expected.length, `${label}: ${found.length} events, expected ${expected.length}`);
  found.forEach((e, k) => assert.ok(Math.abs(e.t - expected[k]) < 1e-3, `${label} #${k}: ${e.t} against ${expected[k]}`));
};

test("a goal on the true anomaly is met once an orbit, without the wrap", async () => {
  const found = await locate((request) => {
    request.LOCATOR_CLASS = sds.evlLocatorClass.PARAMETER_CONDITION;
    const condition = new sds.PCEParameterConditionT();
    condition.PARAMETER = new sds.PCEParameterRefT();
    condition.PARAMETER.PARAMETER = sds.pceParameter.TRUE_ANOMALY;
    Object.assign(condition, { GOAL_VALUE: 1.0, DIRECTION: sds.pceConditionDirection.INCREASING });
    request.PARAMETER_CONDITION_CONFIGURATION = new sds.EVLParameterConditionConfigurationT();
    request.PARAMETER_CONDITION_CONFIGURATION.CONDITIONS = [condition];
    request.PARAMETER_CONDITION_CONFIGURATION.REPORT_AS_INTERVAL = false;
  });
  assertEpochs(found, epochs([1.0]), "true anomaly 1.0");
});

test("latitude maxima and minima are located at the argument of latitude 90 and 270 degrees", async () => {
  const both = await locate((request) => {
    request.LOCATOR_CLASS = sds.evlLocatorClass.LATITUDE_EXTREMUM;
    request.LATITUDE_EXTREMUM_CONFIGURATION = new sds.EVLLatitudeExtremumConfigurationT();
    Object.assign(request.LATITUDE_EXTREMUM_CONFIGURATION, { CENTRAL_BODY_ID: 399, REPORT_MAXIMUM: true, REPORT_MINIMUM: true });
  });
  const w = ORBIT.argp;
  assertEpochs(both, epochs([wrap(Math.PI / 2 - w), wrap(3 * Math.PI / 2 - w)]), "latitude extrema");
  assert.deepEqual([...new Set(both.map((e) => e.type))].sort(), [sds.evlEventType.MAXIMUM_LATITUDE, sds.evlEventType.MINIMUM_LATITUDE].sort());
  const maxima = await locate((request) => {
    request.LOCATOR_CLASS = sds.evlLocatorClass.LATITUDE_EXTREMUM;
    request.LATITUDE_EXTREMUM_CONFIGURATION = new sds.EVLLatitudeExtremumConfigurationT();
    Object.assign(request.LATITUDE_EXTREMUM_CONFIGURATION, { CENTRAL_BODY_ID: 399, REPORT_MAXIMUM: true, REPORT_MINIMUM: false });
  });
  assertEpochs(maxima, epochs([wrap(Math.PI / 2 - w)]), "latitude maxima");
  assert.ok(maxima.every((e) => e.type === sds.evlEventType.MAXIMUM_LATITUDE));
});

test("a plane with a stated normal is crossed where r . n vanishes", async () => {
  const raw = [0.3, -0.4, 0.8], length = Math.hypot(...raw), n = raw.map((x) => x / length);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const nu0 = Math.atan2(-dot(reference.P, n), dot(reference.Q, n));
  const found = await locate((request) => {
    request.LOCATOR_CLASS = sds.evlLocatorClass.NODE_CROSSING;
    request.NODE_CROSSING_CONFIGURATION = new sds.EVLNodeCrossingConfigurationT();
    Object.assign(request.NODE_CROSSING_CONFIGURATION, { REPORT_ASCENDING: true, REPORT_DESCENDING: true });
    request.NODE_CROSSING_CONFIGURATION.PLANE_NORMAL = new sds.FRMVector3T();
    Object.assign(request.NODE_CROSSING_CONFIGURATION.PLANE_NORMAL, { X: raw[0], Y: raw[1], Z: raw[2] });
  });
  assertEpochs(found, epochs([wrap(nu0), wrap(nu0 + Math.PI)]), "plane crossings");
});

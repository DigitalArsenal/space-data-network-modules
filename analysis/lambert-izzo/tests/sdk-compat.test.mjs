import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as flatbuffers from "flatbuffers";
import { LMS } from "spacedatastandards.org/lib/js/LMS/main.js";
import {
  LMO,
  lambertBranchKind,
  lambertSolveState,
} from "spacedatastandards.org/lib/js/LMO/main.js";
import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule, loadModule } from "space-data-module-sdk/host/isomorphic";
import {
  createBrowserModuleHarness,
  generateManifestHarnessPlan,
  materializeHarnessScenario,
} from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL(
  "../dist/isomorphic/module.wasm",
  import.meta.url,
);
const STANDARDS_ROOT = fileURLToPath(
  new URL("../../../node_modules/spacedatastandards.org/", import.meta.url),
);

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function createInvokeRequest() {
  const manifest = readManifest();
  const plan = generateManifestHarnessPlan({
    manifest,
    payloadForPort({ portId }) {
      if (portId !== "request") {
        return null;
      }
      return new Uint8Array([0, 1, 2, 3]);
    },
  });
  const scenario = plan.generatedCases.find((entry) => entry.surface === "command");
  assert.ok(scenario, "missing command harness scenario");
  return materializeHarnessScenario(scenario);
}

function createLambertRequestPayload(overrides = {}) {
  const builder = new flatbuffers.Builder(256);
  const requestId = builder.createString(overrides.requestId ?? "lambert-test");
  const refFrame = builder.createString(overrides.refFrame ?? "GCRF");
  const epoch = builder.createString(overrides.epoch ?? "2026-05-05T00:00:00Z");
  const request = LMS.createLMS(
    builder,
    requestId,
    overrides.r1x ?? 7000,
    overrides.r1y ?? 0,
    overrides.r1z ?? 0,
    overrides.r2x ?? 0,
    overrides.r2y ?? 8000,
    overrides.r2z ?? 0,
    overrides.tofSec ?? 3600,
    overrides.muKm3S2 ?? 398600.4418,
    overrides.transferWay ?? 0,
    overrides.maxRevs ?? 0,
    refFrame,
    epoch,
    overrides.flags ?? 0,
  );
  LMS.finishLMSBuffer(builder, request);
  return builder.asUint8Array();
}

function createLambertInvokeRequest(payload) {
  return {
    methodId: "solve_lambert",
    inputs: [
      {
        portId: "request",
        typeRef: {
          schemaName: "LMS.fbs",
          fileIdentifier: "$LMS",
          rootTypeName: "LMS",
        },
        payload,
      },
    ],
  };
}

function assertInvalidRequestBufferResponse(response) {
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.outputs.length, 0);
  assert.equal(response.errorCode, "invalid-request-buffer");
  assert.match(response.errorMessage, /valid LMS FlatBuffer/i);
}

function assertPluginErrorResponse(response, { statusCode, errorCode, errorMessage }) {
  assert.equal(response.statusCode, statusCode);
  assert.equal(response.outputs.length, 0);
  assert.equal(response.errorCode, errorCode);
  assert.match(response.errorMessage, errorMessage);
}

function isWasmEdgeUnavailable(error) {
  return /spawn wasmedge ENOENT|command not found|Failed to launch/i.test(
    `${String(error)}\n${String(error?.cause ?? "")}`,
  );
}

function hasWasmEdge() {
  return spawnSync("wasmedge", ["--version"], { stdio: "ignore" }).status === 0;
}

function decodeLambertOutputFrame(response) {
  assert.equal(
    response.statusCode,
    0,
    `${response.errorCode ?? "no-error-code"}: ${response.errorMessage ?? "no error message"}`,
  );
  assert.equal(response.outputs.length, 1);
  const [frame] = response.outputs;
  assert.equal(frame.portId, "solutions");
  assert.equal(frame.typeRef?.schemaName, "LMO.fbs");
  assert.equal(frame.typeRef?.fileIdentifier, "$LMO");
  const bb = new flatbuffers.ByteBuffer(frame.payload);
  assert.equal(LMO.bufferHasIdentifier(bb), true);
  return LMO.getRootAsLMO(bb);
}

function assertVectorNear(actual, expected, toleranceKmPerSec) {
  assert.ok(actual, "missing vector");
  for (const [component, getter] of [
    ["X", () => actual.X()],
    ["Y", () => actual.Y()],
    ["Z", () => actual.Z()],
  ]) {
    const delta = Math.abs(getter() - expected[component]);
    assert.ok(
      delta <= toleranceKmPerSec,
      `${component} delta ${delta} km/s exceeds ${toleranceKmPerSec} km/s`,
    );
  }
}

function singleBranchSnapshot(result) {
  const branch = result.SINGLE();
  assert.ok(branch, "missing single-revolution branch");
  return {
    requestId: result.REQUEST_ID(),
    status: result.STATUS(),
    multiLength: result.multiLength(),
    maxFeasibleRevs: result.MAX_FEASIBLE_REVS(),
    nRevs: branch.N_REVS(),
    iterations: branch.ITERATIONS(),
    v1: [branch.V1().X(), branch.V1().Y(), branch.V1().Z()],
    v2: [branch.V2().X(), branch.V2().Y(), branch.V2().Z()],
  };
}

function createClosedFormCircularQuarterOrbitInvokeRequest() {
  const mu = 398600.4418;
  const radiusKm = 7000;
  const quarterPeriodSeconds =
    (Math.PI / 2) * Math.sqrt((radiusKm ** 3) / mu);
  return createLambertInvokeRequest(
    createLambertRequestPayload({
      requestId: "closed-form-quarter-circle",
      r1x: radiusKm,
      r1y: 0,
      r1z: 0,
      r2x: 0,
      r2y: radiusKm,
      r2z: 0,
      tofSec: quarterPeriodSeconds,
      muKm3S2: mu,
      maxRevs: 0,
    }),
  );
}

function createClosedFormCircularLongWayInvokeRequest() {
  const mu = 398600.4418;
  const radiusKm = 7000;
  const threeQuarterPeriodSeconds =
    (3 * Math.PI / 2) * Math.sqrt((radiusKm ** 3) / mu);
  return createLambertInvokeRequest(
    createLambertRequestPayload({
      requestId: "closed-form-long-way-circle",
      r1x: radiusKm,
      r1y: 0,
      r1z: 0,
      r2x: 0,
      r2y: radiusKm,
      r2z: 0,
      tofSec: threeQuarterPeriodSeconds,
      muKm3S2: mu,
      transferWay: 1,
      maxRevs: 0,
    }),
  );
}

test("build publishes canonical isomorphic artifact path", () => {
  assert.equal(fs.existsSync(fileURLToPath(ISOMORPHIC_WASM_PATH)), true);
});

test("built artifact passes SDK compliance checks", async () => {
  const report = await validateArtifactWithStandards({
    manifest: readManifest(),
    wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH),
    standardsRoot: STANDARDS_ROOT,
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("built artifact exposes the standalone isomorphic surface", async () => {
  const inspection = await inspectModule(
    fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
  );
  const importedModuleNames = Array.from(
    new Set(inspection.imports.map((entry) => entry.module)),
  ).sort();

  assert.equal(inspection.profile, "standalone");
  assert.deepEqual(importedModuleNames, ["wasi_snapshot_preview1"]);
  assert.ok(inspection.exports.includes("_start"));
  assert.ok(inspection.exports.includes("plugin_alloc"));
  assert.ok(inspection.exports.includes("plugin_free"));
  assert.ok(inspection.exports.includes("plugin_invoke_stream"));
  assert.ok(inspection.exports.includes("plugin_get_manifest_flatbuffer"));
  assert.ok(inspection.exports.includes("plugin_get_manifest_flatbuffer_size"));
});

test("built artifact loads through the SDK browser harness and fails closed", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "command",
  });
  t.after(() => {
    harness.destroy();
  });

  const response = await harness.invoke(createInvokeRequest());
  assertInvalidRequestBufferResponse(response);
});

test("built artifact loads through the WasmEdge server path when available", async (t) => {
  if (!hasWasmEdge()) {
    t.skip("Install wasmedge to verify the server-path harness.");
    return;
  }
  let harness;
  try {
    harness = await loadModule({
      wasmSource: fileURLToPath(ISOMORPHIC_WASM_PATH),
      runtimeKind: "wasmedge",
      enableThreads: false,
    });
  } catch (error) {
    if (isWasmEdgeUnavailable(error)) {
      t.skip("Install wasmedge to verify the server-path harness.");
      return;
    }
    throw error;
  }
  t.after(async () => {
    await harness.destroy();
  });

  const response = await harness.invoke({
    methodId: "solve_lambert",
    inputs: createInvokeRequest().inputs,
  });
  assertInvalidRequestBufferResponse(response);
});

test("built artifact returns a typed LMO error for invalid time of flight", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => {
    harness.destroy();
  });

  const response = await harness.invoke(
    createLambertInvokeRequest(
      createLambertRequestPayload({
        requestId: "invalid-tof",
        tofSec: 0,
      }),
    ),
  );
  const result = decodeLambertOutputFrame(response);

  assert.equal(result.REQUEST_ID(), "invalid-tof");
  assert.equal(result.STATUS(), lambertSolveState.ERROR);
  assert.equal(result.ERROR_CODE(), "invalid-time-of-flight");
  assert.match(result.ERROR_MESSAGE(), /time of flight/i);
});

test("built artifact fails closed when the LMS request frame is missing", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => {
    harness.destroy();
  });

  const response = await harness.invoke({
    methodId: "solve_lambert",
    inputs: [],
  });

  assertPluginErrorResponse(response, {
    statusCode: 400,
    errorCode: "missing-required-input",
    errorMessage: /missing required input port: request/i,
  });
});

const invalidRequestCases = [
  {
    name: "non-finite input",
    requestId: "non-finite",
    overrides: { r1x: Number.NaN },
    errorCode: "non-finite-input",
    errorMessage: /non-finite/i,
  },
  {
    name: "zero initial position vector",
    requestId: "zero-r1",
    overrides: { r1x: 0, r1y: 0, r1z: 0 },
    errorCode: "invalid-position-vector",
    errorMessage: /position vector/i,
  },
  {
    name: "invalid gravitational parameter",
    requestId: "invalid-mu",
    overrides: { muKm3S2: 0 },
    errorCode: "invalid-gravitational-parameter",
    errorMessage: /gravitational parameter/i,
  },
  {
    name: "impossible revolution budget",
    requestId: "invalid-revs",
    overrides: { maxRevs: 33 },
    errorCode: "invalid-revolution-budget",
    errorMessage: /revolution/i,
  },
  {
    name: "collinear transfer geometry",
    requestId: "collinear",
    overrides: { r1x: 7000, r1y: 0, r1z: 0, r2x: 8000, r2y: 0, r2z: 0 },
    errorCode: "unsupported-geometry",
    errorMessage: /collinear/i,
  },
];

for (const entry of invalidRequestCases) {
  test(`built artifact returns a typed LMO error for ${entry.name}`, async (t) => {
    const harness = await createBrowserModuleHarness({
      wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
      surface: "direct",
    });
    t.after(() => {
      harness.destroy();
    });

    const response = await harness.invoke(
      createLambertInvokeRequest(
        createLambertRequestPayload({
          requestId: entry.requestId,
          ...entry.overrides,
        }),
      ),
    );
    const result = decodeLambertOutputFrame(response);

    assert.equal(result.REQUEST_ID(), entry.requestId);
    assert.equal(result.STATUS(), lambertSolveState.ERROR);
    assert.equal(result.ERROR_CODE(), entry.errorCode);
    assert.match(result.ERROR_MESSAGE(), entry.errorMessage);
  });
}

test("built artifact solves the closed-form circular quarter-orbit benchmark", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "command",
  });
  t.after(() => {
    harness.destroy();
  });

  const mu = 398600.4418;
  const radiusKm = 7000;
  const circularSpeedKmPerSec = Math.sqrt(mu / radiusKm);
  const quarterPeriodSeconds =
    (Math.PI / 2) * Math.sqrt((radiusKm ** 3) / mu);
  const response = await harness.invoke(createClosedFormCircularQuarterOrbitInvokeRequest());
  const result = decodeLambertOutputFrame(response);
  const branch = result.SINGLE();

  assert.equal(result.REQUEST_ID(), "closed-form-quarter-circle");
  assert.equal(result.STATUS(), lambertSolveState.OK);
  assert.equal(result.multiLength(), 0);
  assert.equal(result.MAX_FEASIBLE_REVS(), 0);
  assert.ok(branch, "missing single-revolution branch");
  assert.equal(branch.N_REVS(), 0);
  assert.ok(branch.ITERATIONS() > 0);
  assertVectorNear(branch.V1(), { X: 0, Y: circularSpeedKmPerSec, Z: 0 }, 1e-6);
  assertVectorNear(branch.V2(), { X: -circularSpeedKmPerSec, Y: 0, Z: 0 }, 1e-6);
});

test("built artifact returns deterministic circular benchmark output in browser and WasmEdge", async (t) => {
  if (!hasWasmEdge()) {
    t.skip("Install wasmedge to verify browser/WasmEdge numerical determinism.");
    return;
  }
  const wasmPath = fileURLToPath(ISOMORPHIC_WASM_PATH);
  const browserHarness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(wasmPath),
    surface: "direct",
  });
  t.after(() => {
    browserHarness.destroy();
  });

  let wasmedgeHarness;
  try {
    wasmedgeHarness = await loadModule({
      wasmSource: wasmPath,
      runtimeKind: "wasmedge",
      enableThreads: false,
    });
  } catch (error) {
    if (isWasmEdgeUnavailable(error)) {
      t.skip("Install wasmedge to verify browser/WasmEdge numerical determinism.");
      return;
    }
    throw error;
  }
  t.after(async () => {
    await wasmedgeHarness.destroy();
  });

  const request = createClosedFormCircularQuarterOrbitInvokeRequest();
  const browserResult = decodeLambertOutputFrame(
    await browserHarness.invoke(request),
  );
  const wasmedgeResult = decodeLambertOutputFrame(
    await wasmedgeHarness.invoke(request),
  );

  assert.deepEqual(
    singleBranchSnapshot(wasmedgeResult),
    singleBranchSnapshot(browserResult),
  );
});

test("built artifact solves the closed-form circular long-way benchmark", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => {
    harness.destroy();
  });

  const mu = 398600.4418;
  const radiusKm = 7000;
  const circularSpeedKmPerSec = Math.sqrt(mu / radiusKm);
  const response = await harness.invoke(createClosedFormCircularLongWayInvokeRequest());
  const result = decodeLambertOutputFrame(response);
  const branch = result.SINGLE();

  assert.equal(result.REQUEST_ID(), "closed-form-long-way-circle");
  assert.equal(result.STATUS(), lambertSolveState.OK);
  assert.ok(branch, "missing single-revolution branch");
  assert.equal(branch.N_REVS(), 0);
  assertVectorNear(branch.V1(), { X: 0, Y: -circularSpeedKmPerSec, Z: 0 }, 1e-6);
  assertVectorNear(branch.V2(), { X: circularSpeedKmPerSec, Y: 0, Z: 0 }, 1e-6);
});

test("built artifact returns both branches of an upstream multi-revolution case", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => {
    harness.destroy();
  });

  const mu = 398600.4418;
  const radiusKm = 8000;
  const periodSeconds = 2 * Math.PI * Math.sqrt((radiusKm ** 3) / mu);
  const response = await harness.invoke(
    createLambertInvokeRequest(
      createLambertRequestPayload({
        requestId: "upstream-multi-rev",
        r1x: radiusKm,
        r2x: 5600,
        r2y: 5600,
        maxRevs: 3,
        tofSec: 5 * periodSeconds,
      }),
    ),
  );

  const result = decodeLambertOutputFrame(response);
  assert.equal(result.REQUEST_ID(), "upstream-multi-rev");
  assert.equal(result.STATUS(), lambertSolveState.OK);
  assert.equal(result.MAX_FEASIBLE_REVS(), 3);
  assert.equal(result.multiLength(), 6);
  for (let revolutions = 1; revolutions <= 3; revolutions += 1) {
    const longPeriod = result.MULTI((revolutions - 1) * 2);
    const shortPeriod = result.MULTI((revolutions - 1) * 2 + 1);
    assert.equal(longPeriod.N_REVS(), revolutions);
    assert.equal(shortPeriod.N_REVS(), revolutions);
    assert.equal(longPeriod.BRANCH_KIND(), lambertBranchKind.MULTI_LONG_PERIOD);
    assert.equal(shortPeriod.BRANCH_KIND(), lambertBranchKind.MULTI_SHORT_PERIOD);
    assert.ok(longPeriod.ITERATIONS() > 0);
    assert.ok(shortPeriod.ITERATIONS() > 0);
    assert.notDeepEqual(
      [longPeriod.V1().X(), longPeriod.V1().Y(), longPeriod.V1().Z()],
      [shortPeriod.V1().X(), shortPeriod.V1().Y(), shortPeriod.V1().Z()],
    );
  }
});

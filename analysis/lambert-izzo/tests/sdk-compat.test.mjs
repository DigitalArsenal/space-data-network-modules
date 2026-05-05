import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as flatbuffers from "../../../../spacedatastandards.org/node_modules/flatbuffers/mjs/flatbuffers.js";
import { LMS } from "../../../../spacedatastandards.org/lib/js/LMS/main.js";
import { LMO, lambertSolveState } from "../../../../spacedatastandards.org/lib/js/LMO/main.js";
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
  new URL("../../../../spacedatastandards.org/", import.meta.url),
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
          schemaName: "spacedata.LMS",
          fileIdentifier: "LMS",
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

function decodeLambertOutputFrame(response) {
  assert.equal(response.statusCode, 0);
  assert.equal(response.outputs.length, 1);
  const [frame] = response.outputs;
  assert.equal(frame.portId, "solutions");
  assert.equal(frame.typeRef?.schemaName, "spacedata.LMO");
  assert.equal(frame.typeRef?.fileIdentifier, "LMO");
  const bb = new flatbuffers.ByteBuffer(frame.payload);
  assert.equal(LMO.bufferHasIdentifier(bb), true);
  return LMO.getRootAsLMO(bb);
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
  let harness;
  try {
    harness = await loadModule({
      wasmSource: fileURLToPath(ISOMORPHIC_WASM_PATH),
      runtimeKind: "wasmedge",
      enableThreads: false,
    });
  } catch (error) {
    if (/spawn wasmedge ENOENT|command not found|Failed to launch/i.test(String(error))) {
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

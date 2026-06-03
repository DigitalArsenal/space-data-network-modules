// SDK artifact coverage for the propagator.sgp4 module.
//
// The SDK still owns artifact validation and wasm inspection. Invocation is
// driven directly through the canonical SDS PIV envelope because OrbPro does
// not keep the SDK's legacy StreamInvoke request dialect.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validatePluginArtifact } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing/browser";

import {
  decodePropagatorState,
  encodeOmmPayload,
  encodePropagatorBatchRequest,
} from "./lib/payloadEncoders.mjs";
import {
  decodePivEnvelope,
  encodePivInvokeRequest,
  invokePiv,
  loadRawSgp4Module,
} from "./lib/pivInvokeHelper.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const MANIFEST_PATH = path.join(packageRoot, "plugin-manifest.json");
const ISOMORPHIC_WASM_PATH = path.join(
  packageRoot,
  "dist",
  "isomorphic",
  "module.wasm",
);
const BROWSER_MODULE_PATH = path.join(
  packageRoot,
  "dist",
  "browser",
  "module.js",
);
const BROWSER_WASM_PATH = path.join(
  packageRoot,
  "dist",
  "browser",
  "module.wasm",
);
const BROWSER_SHARED_WASM_PATH = path.join(
  packageRoot,
  "dist",
  "browser-shared",
  "module.wasm",
);

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

test("build publishes canonical browser and isomorphic artifact paths", () => {
  assert.equal(fs.existsSync(ISOMORPHIC_WASM_PATH), true);
  assert.equal(fs.existsSync(BROWSER_MODULE_PATH), true);
  assert.equal(fs.existsSync(BROWSER_WASM_PATH), true);
});

test("built artifact passes SDK compliance checks", async () => {
  const report = await validatePluginArtifact({
    manifest: readManifest(),
    wasmPath: ISOMORPHIC_WASM_PATH,
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("built artifact exposes the standalone isomorphic surface", async () => {
  const inspection = await inspectModule(
    fs.readFileSync(ISOMORPHIC_WASM_PATH),
  );
  const importedModuleNames = Array.from(
    new Set(inspection.imports.map((entry) => entry.module)),
  ).sort();

  assert.equal(inspection.profile, "standalone");
  assert.deepEqual(importedModuleNames, ["wasi_snapshot_preview1"]);

  for (const required of [
    "_start",
    "plugin_alloc",
    "plugin_free",
    "plugin_invoke_stream",
    "plugin_get_input_frame",
    "plugin_push_output_typed",
    "plugin_set_error",
    "plugin_get_manifest_flatbuffer",
    "plugin_get_manifest_flatbuffer_size",
  ]) {
    assert.ok(
      inspection.exports.includes(required),
      `expected export ${required} on isomorphic artifact`,
    );
  }
});

test("browser-shared artifact imports host memory", async () => {
  assert.equal(fs.existsSync(BROWSER_SHARED_WASM_PATH), true);

  const inspection = await inspectModule(
    fs.readFileSync(BROWSER_SHARED_WASM_PATH),
  );
  const memoryImports = inspection.imports.filter(
    (entry) => entry.kind === "memory",
  );

  assert.deepEqual(memoryImports, [
    { module: "env", name: "memory", kind: "memory" },
  ]);
});

test("browser-shared artifact accepts SharedArrayBuffer-backed imported memory", async (t) => {
  if (typeof SharedArrayBuffer !== "function") {
    t.skip("SharedArrayBuffer is not available in this runtime.");
    return;
  }

  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(BROWSER_SHARED_WASM_PATH),
    surface: "direct",
    sharedMemory: true,
    initialMemoryBytes: 64 * 1024 * 1024,
    maximumMemoryBytes: 2 * 1024 * 1024 * 1024,
  });
  t.after(() => {
    harness.destroy();
  });

  assert.equal(harness.memory.buffer instanceof SharedArrayBuffer, true);
  assert.equal(
    typeof harness.instance.exports.plugin_get_manifest_flatbuffer_size,
    "function",
  );
  assert.ok(harness.instance.exports.plugin_get_manifest_flatbuffer_size() > 0);
});

test("browser-shared artifact drives OMM ingest and PropagatorState emit through SDS PIV", async (t) => {
  if (typeof SharedArrayBuffer !== "function") {
    t.skip("SharedArrayBuffer is not available in this runtime.");
    return;
  }

  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(BROWSER_SHARED_WASM_PATH),
    surface: "direct",
    sharedMemory: true,
    initialMemoryBytes: 64 * 1024 * 1024,
    maximumMemoryBytes: 2 * 1024 * 1024 * 1024,
  });
  t.after(() => {
    harness.destroy();
  });

  const ingestEnvelope = decodePivEnvelope(
    await harness.invokeRaw(
      encodePivInvokeRequest({
        methodId: "ingest_omm",
        inputs: [
          {
            portId: "omm",
            payload: encodeOmmPayload(),
            typeRef: {
              schemaName: "orbpro.sds.omm",
              fileIdentifier: "$OMM",
            },
          },
        ],
      }),
    ),
  );
  assert.equal(ingestEnvelope.RESPONSE.STATUS_CODE ?? 0, 0);

  const propagateEnvelope = decodePivEnvelope(
    await harness.invokeRaw(
      encodePivInvokeRequest({
        methodId: "propagate_state",
        inputs: [
          {
            portId: "request",
            payload: encodePropagatorBatchRequest({
              epoch: 2460310.5,
              entityHandles: [0],
              maxCount: 1,
            }),
            typeRef: {
              schemaName: "orbpro.propagator.PropagatorBatchRequest",
              fileIdentifier: "PROP",
            },
          },
        ],
        outputStreamCap: 1,
      }),
    ),
  );
  const response = propagateEnvelope.RESPONSE;
  assert.equal(response.STATUS_CODE ?? 0, 0);
  assert.equal(response.OUTPUTS.length, 1);
  assert.equal(response.OUTPUTS[0].PORT_ID, "state");

  const statePayload = new Uint8Array(
    response.PAYLOAD_ARENA.slice(
      response.OUTPUTS[0].OFFSET,
      response.OUTPUTS[0].OFFSET + response.OUTPUTS[0].SIZE,
    ),
  );
  const state = decodePropagatorState(statePayload);
  assert.equal(state.catalogNumber, 25544);
  assert.equal(state.valid, true);
  assert.ok(Number.isFinite(state.position[0]));
});

test("raw browser module drives OMM ingest and PropagatorState emit through SDS PIV", async () => {
  const module = await loadRawSgp4Module();
  try {
    const ingestResponse = invokePiv(module, {
      methodId: "ingest_omm",
      inputs: [
        {
          portId: "omm",
          payload: encodeOmmPayload(),
          typeRef: {
            schemaName: "orbpro.sds.omm",
            fileIdentifier: "$OMM",
          },
        },
      ],
    });
    assert.equal(ingestResponse.response.STATUS_CODE ?? 0, 0);

    const propagateResponse = invokePiv(module, {
      methodId: "propagate_state",
      inputs: [
        {
          portId: "request",
          payload: encodePropagatorBatchRequest({
            epoch: 2460310.5,
            entityHandles: [0],
            maxCount: 1,
          }),
          typeRef: {
            schemaName: "orbpro.propagator.PropagatorBatchRequest",
            fileIdentifier: "PROP",
          },
        },
      ],
      outputStreamCap: 1,
    });
    assert.equal(propagateResponse.response.STATUS_CODE ?? 0, 0);
    assert.equal(propagateResponse.outputPayloads.length, 1);
    assert.equal(propagateResponse.outputPayloads[0].portId, "state");

    const state = decodePropagatorState(propagateResponse.outputPayloads[0].bytes);
    assert.equal(state.catalogNumber, 25544);
    assert.equal(state.valid, true);
    assert.ok(Number.isFinite(state.position[0]));
  } finally {
    module._plugin_destroy();
  }
});

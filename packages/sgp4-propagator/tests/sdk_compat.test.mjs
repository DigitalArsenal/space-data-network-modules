// SDK 0.8.0 compat coverage for the sgp4-propagator plugin.
//
// Exercises the published SDK surfaces — `validatePluginArtifact`,
// `inspectModule`, `createBrowserModuleHarness`, and the WasmEdge command
// harness — against the real FlatBuffer wire (OMM ingest + PropagatorState
// output). The `plugin_invoke_bridge.cpp` layer rebuilds the request as an
// OrbPro `StreamInvokeRequest` and dispatches into `plugin_stream_invoke`;
// success here proves both the SDK and OrbPro wire surfaces stay aligned for
// every compiled artifact.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validatePluginArtifact } from "space-data-module-sdk/compliance";
import {
  inspectModule,
  loadModule,
} from "space-data-module-sdk/host/isomorphic";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

import {
  decodePropagatorState,
  encodeOmmPayload,
  encodePropagatorBatchRequest,
} from "./lib/payloadEncoders.mjs";

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

test("browser harness drives OMM ingest and PropagatorState emit through the SDK invoke surface", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(ISOMORPHIC_WASM_PATH),
    surface: "direct",
  });
  t.after(() => {
    harness.destroy();
  });

  const ingestResponse = await harness.invoke({
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
  assert.equal(ingestResponse.statusCode ?? 0, 0);

  const propagateResponse = await harness.invoke({
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
  assert.equal(propagateResponse.statusCode ?? 0, 0);
  assert.equal(propagateResponse.outputs.length, 1);
  assert.equal(propagateResponse.outputs[0].portId, "state");

  const payload = propagateResponse.outputs[0].payload;
  const state = decodePropagatorState(new Uint8Array(payload));
  assert.equal(state.catalogNumber, 25544);
  assert.equal(state.valid, true);
  assert.ok(Number.isFinite(state.position[0]));
});

test("wasmedge command harness accepts SDK invoke requests", async (t) => {
  let harness;
  try {
    harness = await loadModule({
      wasmSource: ISOMORPHIC_WASM_PATH,
      runtimeKind: "wasmedge",
      enableThreads: false,
    });
  } catch (error) {
    if (
      /spawn wasmedge ENOENT|command not found|Failed to launch/i.test(
        String(error),
      )
    ) {
      t.skip("Install wasmedge to verify the server-path harness.");
      return;
    }
    throw error;
  }
  t.after(async () => {
    await harness.destroy();
  });

  // WasmEdge's command surface spawns a fresh process per invoke, so state
  // doesn't persist between calls. The smoke test here drives a single
  // `ingest_omm` call and verifies the plugin accepts the SDK 0.8.0 wire
  // format without tripping the FlatBuffer verifier.
  const response = await harness.invoke({
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
  assert.equal(response.statusCode ?? 0, 0);
});

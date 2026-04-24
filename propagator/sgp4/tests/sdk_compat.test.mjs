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

import {
  decodePropagatorState,
  encodeOmmPayload,
  encodePropagatorBatchRequest,
} from "./lib/payloadEncoders.mjs";
import { invokePiv, loadRawSgp4Module } from "./lib/pivInvokeHelper.mjs";

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

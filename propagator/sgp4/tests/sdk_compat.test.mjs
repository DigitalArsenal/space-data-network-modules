// One SGP4 artifact must load unchanged in the browser and both WasmEdge lanes.
// The former Emscripten browser wrappers were a second build with a different
// import shape, so this file makes that split impossible to reintroduce.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertSequentialArtifact } from "space-data-module-sdk/compiler";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing/browser";

import {
  decodePropagatorState,
  encodeOmmPayload,
  encodePropagatorBatchRequest,
} from "./lib/payloadEncoders.mjs";
import { decodePivEnvelope, encodePivInvokeRequest } from "./lib/pivInvokeHelper.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const wasmPath = path.join(packageRoot, "dist", "isomorphic", "module.wasm");
const toolchainPath = path.join(packageRoot, "dist", "build-toolchain.json");

function manifest() {
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

test("build emits only the canonical isomorphic artifact", () => {
  assert.equal(fs.existsSync(wasmPath), true);
  assert.equal(fs.existsSync(path.join(packageRoot, "dist", "browser")), false);
  assert.equal(fs.existsSync(path.join(packageRoot, "dist", "browser-shared")), false);
});

test("build record proves the sanctioned clang target and pinned SQLite input", () => {
  const proof = JSON.parse(fs.readFileSync(toolchainPath, "utf8"));
  assert.equal(proof.target, "wasm32-wasip1-threads");
  assert.equal(proof.threadModel, "wasi-sequential");
  assert.match(proof.compiler, /wasm32-wasi-clang\+\+$/);
  assert.equal(proof.sqlite.version, "3.45.2");
  assert.equal(proof.artifact, "dist/isomorphic/module.wasm");
});

test("artifact passes the wasi-sequential emitted-byte guard", async () => {
  const artifact = fs.readFileSync(wasmPath);
  assert.doesNotThrow(() =>
    assertSequentialArtifact(artifact, {
      source: wasmPath,
      target: "wasm32-wasip1-threads",
    }),
  );
});

test("artifact imports only the browser and WasmEdge shared WASI contract", async () => {
  const artifact = fs.readFileSync(wasmPath);
  const inspection = await inspectModule(artifact);
  const modules = [...new Set(inspection.imports.map((entry) => entry.module))];
  assert.deepEqual(modules, ["wasi_snapshot_preview1"]);
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
    assert.ok(inspection.exports.includes(required), `missing ${required}`);
  }
});

test("the same artifact executes the SGP4 PIV path in the browser harness", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(wasmPath),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const ingest = decodePivEnvelope(
    await harness.invokeRaw(
      encodePivInvokeRequest({
        methodId: "ingest_omm",
        inputs: [{
          portId: "omm",
          payload: encodeOmmPayload(),
          typeRef: { schemaName: "orbpro.sds.omm", fileIdentifier: "$OMM" },
        }],
      }),
    ),
  );
  assert.equal(ingest.RESPONSE.STATUS_CODE ?? 0, 0);

  const propagated = decodePivEnvelope(
    await harness.invokeRaw(
      encodePivInvokeRequest({
        methodId: "propagate_state",
        inputs: [{
          portId: "request",
          payload: encodePropagatorBatchRequest({ epoch: 2460310.5, entityHandles: [0], maxCount: 1 }),
          typeRef: {
            schemaName: "orbpro.propagator.PropagatorBatchRequest",
            fileIdentifier: "PROP",
          },
        }],
        outputStreamCap: 1,
      }),
    ),
  );
  assert.equal(propagated.RESPONSE.STATUS_CODE ?? 0, 0);
  const frame = propagated.RESPONSE.OUTPUTS[0];
  assert.equal(frame.PORT_ID, "state");
  const state = decodePropagatorState(
    new Uint8Array(propagated.RESPONSE.PAYLOAD_ARENA.slice(frame.OFFSET, frame.OFFSET + frame.SIZE)),
  );
  assert.equal(state.catalogNumber, 25544);
  assert.equal(state.valid, true);
});

test("the package requires the browser, native WasmEdge, and Docker WasmEdge parity command", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  assert.match(pkg.scripts["test:parity"], /--lanes browser,wasmedge,docker-wasmedge/);
  assert.match(pkg.scripts["test:parity"], /dist\/isomorphic\/module\.wasm/);
});

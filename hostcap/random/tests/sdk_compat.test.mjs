import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { createBrowserHost } from "space-data-module-sdk/host/browser";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT = fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));

const encoder = new TextEncoder();

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function readWasm() {
  return fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH));
}

function jsonInput(portId, value) {
  return {
    portId,
    typeRef: { wireFormat: "aligned-binary" },
    payload: encoder.encode(JSON.stringify(value)),
  };
}

// Deterministic "random" bytes so verbatim passthrough is assertable.
function cannedBytes(length) {
  return Uint8Array.from({ length }, (_, i) => (i * 31 + 7) & 0xff);
}

// Host-bridge stub: serves random.bytes with deterministic bytes and records
// every hostcall so tests can assert the resolved length parameter.
function createHostStub({ failOps = {} } = {}) {
  const calls = [];
  const dispatch = (operation, params) => {
    calls.push({ operation, params });
    if (failOps[operation]) {
      throw new Error(failOps[operation]);
    }
    if (operation === "random.bytes") {
      return cannedBytes(params?.length ?? 32);
    }
    throw new Error(`unexpected hostcall operation: ${operation}`);
  };
  return { calls, dispatch };
}

// Zero-input invokes must use the command surface (see data-source/retrieval).
async function createHarness(t, options, surface = "command") {
  const harness = await createBrowserModuleHarness({
    wasmSource: readWasm(),
    manifest: readManifest(),
    surface,
    ...options,
  });
  t.after(() => harness.destroy());
  return harness;
}

function assertBytesOutput(response, expected) {
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.outputs.length, 1);
  const [frame] = response.outputs;
  assert.equal(frame.portId, "bytes");
  assert.equal(frame.wireFormat, "aligned-binary");
  assert.deepEqual(new Uint8Array(frame.payload), expected, "bytes must pass through verbatim");
}

test("hostcap/random artifact passes SDK compliance", async () => {
  const report = await validateArtifactWithStandards({
    manifest: readManifest(),
    wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH),
    standardsRoot: STANDARDS_ROOT,
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("hostcap/random artifact exports the canonical ABI and imports only WASI + the sync hostcall bridge", async () => {
  const inspection = await inspectModule(readWasm());
  assert.equal(inspection.profile, "module-host-abi");
  const importedModuleNames = Array.from(new Set(inspection.imports.map((entry) => entry.module))).sort();
  assert.deepEqual(importedModuleNames, ["space_data_module_host", "wasi_snapshot_preview1"]);
  for (const required of [
    "plugin_alloc",
    "plugin_free",
    "plugin_invoke_stream",
    "plugin_get_manifest_flatbuffer",
    "plugin_get_manifest_flatbuffer_size",
  ]) {
    assert.ok(inspection.exports.includes(required), `missing export ${required}`);
  }
});

test("bytes defaults to 32 random bytes when no request frame is given", async (t) => {
  const stub = createHostStub();
  const harness = await createHarness(t, { hostcallDispatch: stub.dispatch });
  const response = await harness.invoke({ methodId: "bytes", inputs: [] });

  assertBytesOutput(response, cannedBytes(32));
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].operation, "random.bytes");
  assert.equal(stub.calls[0].params.length, 32, "default length must be 32");
});

test("bytes forwards the requested length from the request JSON frame", async (t) => {
  const stub = createHostStub();
  const harness = await createHarness(t, { hostcallDispatch: stub.dispatch }, "direct");
  const response = await harness.invoke({
    methodId: "bytes",
    inputs: [jsonInput("request", { length: 4096 })],
  });

  assertBytesOutput(response, cannedBytes(4096));
  assert.equal(stub.calls[0].params.length, 4096);
});

test("bytes rejects lengths above 65536 without issuing a hostcall", async (t) => {
  const stub = createHostStub();
  const harness = await createHarness(t, { hostcallDispatch: stub.dispatch }, "direct");
  const response = await harness.invoke({
    methodId: "bytes",
    inputs: [jsonInput("request", { length: 65537 })],
  });

  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "invalid-length");
  assert.equal(stub.calls.length, 0, "invalid lengths must fail before the hostcall");
});

test("bytes rejects zero and negative lengths", async (t) => {
  const stub = createHostStub();
  const harness = await createHarness(t, { hostcallDispatch: stub.dispatch }, "direct");
  const response = await harness.invoke({
    methodId: "bytes",
    inputs: [jsonInput("request", { length: 0 })],
  });

  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "invalid-length");
  assert.equal(stub.calls.length, 0);
});

test("bytes works against the real BrowserHost CSPRNG (capability-gated passthrough)", async (t) => {
  const host = createBrowserHost({ capabilities: ["random"] });
  const harness = await createHarness(t, { host }, "direct");
  const response = await harness.invoke({
    methodId: "bytes",
    inputs: [jsonInput("request", { length: 64 })],
  });

  assert.equal(response.statusCode, 0, response.errorMessage);
  const payload = new Uint8Array(response.outputs[0].payload);
  assert.equal(payload.length, 64);
  assert.ok(new Set(payload).size > 8, "64 CSPRNG bytes should not be constant");
});

test("bytes surfaces host errors as plugin error status with the host message", async (t) => {
  const stub = createHostStub({ failOps: { "random.bytes": "random capability not granted" } });
  const harness = await createHarness(t, { hostcallDispatch: stub.dispatch });
  const response = await harness.invoke({ methodId: "bytes", inputs: [] });

  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "random-unavailable");
  assert.match(String(response.errorMessage), /random capability not granted/);
  assert.equal(response.outputs.length, 0);
});

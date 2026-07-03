import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT = fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function readWasm() {
  return fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH));
}

function bytesInput(portId, bytes) {
  return {
    portId,
    typeRef: { wireFormat: "aligned-binary" },
    payload: bytes instanceof Uint8Array ? bytes : encoder.encode(bytes),
  };
}

const FILE_CONTENT = Uint8Array.from({ length: 48 }, (_, i) => (i * 11 + 3) & 0xff);

// Host-bridge stub emulating the SDK NodeHost/BrowserHost filesystem ops:
// readFile returns raw bytes (delivered as a binary envelope segment),
// writeFile returns {path: <resolved>}. Records every hostcall.
// Byte params arrive as live views into guest memory; snapshot them so
// post-invoke assertions see the bytes as they were at hostcall time.
function snapshotParams(params) {
  if (params instanceof Uint8Array) return Uint8Array.from(params);
  if (Array.isArray(params)) return params.map(snapshotParams);
  if (params && typeof params === "object") {
    return Object.fromEntries(
      Object.entries(params).map(([key, value]) => [key, snapshotParams(value)]),
    );
  }
  return params;
}

function createHostStub({ files = {}, failOps = {} } = {}) {
  const calls = [];
  const dispatch = (operation, params) => {
    calls.push({ operation, params: snapshotParams(params) });
    if (failOps[operation]) {
      throw new Error(failOps[operation]);
    }
    switch (operation) {
      case "filesystem.readFile": {
        const content = files[params?.path];
        if (!content) {
          throw new Error(`ENOENT: no such file: ${params?.path}`);
        }
        return content;
      }
      case "filesystem.writeFile":
        return { path: `/sandbox/${params?.path}` };
      default:
        throw new Error(`unexpected hostcall operation: ${operation}`);
    }
  };
  return { calls, dispatch };
}

async function createHarness(t, stub) {
  const harness = await createBrowserModuleHarness({
    wasmSource: readWasm(),
    manifest: readManifest(),
    surface: "direct",
    hostcallDispatch: stub.dispatch,
  });
  t.after(() => harness.destroy());
  return harness;
}

test("hostcap/file artifact passes SDK compliance", async () => {
  const report = await validateArtifactWithStandards({
    manifest: readManifest(),
    wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH),
    standardsRoot: STANDARDS_ROOT,
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("hostcap/file artifact exports the canonical ABI and imports only WASI + the sync hostcall bridge", async () => {
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

test("read_file forwards the path to filesystem.readFile and streams the content verbatim", async (t) => {
  const stub = createHostStub({ files: { "data/omm.bin": FILE_CONTENT } });
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({
    methodId: "read_file",
    inputs: [bytesInput("request", JSON.stringify({ path: "data/omm.bin" }))],
  });

  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.outputs.length, 1);
  const [frame] = response.outputs;
  assert.equal(frame.portId, "content");
  assert.equal(frame.wireFormat, "aligned-binary");
  assert.deepEqual(new Uint8Array(frame.payload), FILE_CONTENT, "content must pass through verbatim");
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].operation, "filesystem.readFile");
  assert.equal(stub.calls[0].params.path, "data/omm.bin");
});

test("read_file rejects a request without a path before any hostcall", async (t) => {
  const stub = createHostStub();
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({
    methodId: "read_file",
    inputs: [bytesInput("request", JSON.stringify({}))],
  });

  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "missing-path");
  assert.equal(stub.calls.length, 0);
});

test("read_file surfaces host errors (ENOENT) with the host message", async (t) => {
  const stub = createHostStub({ files: {} });
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({
    methodId: "read_file",
    inputs: [bytesInput("request", JSON.stringify({ path: "missing.bin" }))],
  });

  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "file-read-failed");
  assert.match(String(response.errorMessage), /ENOENT.*missing\.bin/);
  assert.equal(response.outputs.length, 0);
});

test("write_file sends the content as the hostcall binary segment and reports the result", async (t) => {
  const stub = createHostStub();
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({
    methodId: "write_file",
    inputs: [
      bytesInput("content", FILE_CONTENT),
      bytesInput("request", JSON.stringify({ path: "out/result.bin" })),
    ],
  });

  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.outputs.length, 1);
  const [frame] = response.outputs;
  assert.equal(frame.portId, "result");
  assert.deepEqual(JSON.parse(decoder.decode(frame.payload)), {
    ok: true,
    bytesWritten: FILE_CONTENT.length,
    path: "/sandbox/out/result.bin",
  });

  const call = stub.calls.find((entry) => entry.operation === "filesystem.writeFile");
  assert.ok(call, "missing filesystem.writeFile hostcall");
  assert.equal(call.params.path, "out/result.bin");
  assert.deepEqual(
    new Uint8Array(call.params.value),
    FILE_CONTENT,
    "content must reach the host as raw bytes (binary segment), not JSON/base64",
  );
});

test("write_file falls back to the requested path when the host result has none", async (t) => {
  const calls = [];
  const stub = {
    calls,
    dispatch: (operation, params) => {
      calls.push({ operation, params });
      return true; // hosts that report no resolved path
    },
  };
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({
    methodId: "write_file",
    inputs: [
      bytesInput("content", FILE_CONTENT),
      bytesInput("request", JSON.stringify({ path: "plain.bin" })),
    ],
  });

  assert.equal(response.statusCode, 0, response.errorMessage);
  const result = JSON.parse(decoder.decode(response.outputs[0].payload));
  assert.equal(result.path, "plain.bin");
  assert.equal(result.bytesWritten, FILE_CONTENT.length);
});

test("write_file surfaces host errors with the host message", async (t) => {
  const stub = createHostStub({ failOps: { "filesystem.writeFile": "EACCES: permission denied" } });
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({
    methodId: "write_file",
    inputs: [
      bytesInput("content", FILE_CONTENT),
      bytesInput("request", JSON.stringify({ path: "denied.bin" })),
    ],
  });

  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "file-write-failed");
  assert.match(String(response.errorMessage), /EACCES/);
});

test("hostcap/file server-side run requires a Go filesystem cap handler (documented gap)", async (t) => {
  // sdn-server internal/modulert/caps has no filesystem handler today; the
  // Go HostBridge answers filesystem.* with operation-not-supported. The
  // node targets the SDK NodeHost/BrowserHost filesystem ops until a server
  // handler lands. Do not fake it here.
  const inspection = await inspectModule(readWasm());
  assert.ok(inspection.imports.some((entry) => entry.module === "space_data_module_host"));
  t.skip("Go server host has no filesystem capability handler yet (documented in the manifest).");
});

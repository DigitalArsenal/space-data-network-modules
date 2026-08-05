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

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function readWasm() {
  return fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH));
}

function jsonInput(portId, value) {
  const payload = encoder.encode(typeof value === "string" ? value : JSON.stringify(value));
  return {
    portId,
    typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: payload.byteLength },
    payload,
  };
}

// Canned "ALIGNED size-prefixed FlatBuffer stream" (same deterministic frames
// as the retrieval suite) — query must pass these bytes through VERBATIM.
function buildCannedStream() {
  const frames = [
    Uint8Array.from({ length: 24 }, (_, i) => (i * 7 + 1) & 0xff),
    Uint8Array.from({ length: 16 }, (_, i) => (i * 13 + 5) & 0xff),
  ];
  const total = frames.reduce((sum, frame) => sum + 4 + frame.length, 0);
  const stream = new Uint8Array(total);
  const view = new DataView(stream.buffer);
  let offset = 0;
  for (const frame of frames) {
    view.setUint32(offset, frame.length, true);
    stream.set(frame, offset + 4);
    offset += 4 + frame.length;
  }
  return stream;
}

const CANNED_STREAM = buildCannedStream();

function createHostStub({ failOps = {}, stream = CANNED_STREAM } = {}) {
  const calls = [];
  const dispatch = (operation, params) => {
    calls.push({ operation, params });
    if (failOps[operation]) {
      throw new Error(failOps[operation]);
    }
    if (operation === "storage.flatsql_query_stream") {
      return { rows: 2, columns: 3, stream };
    }
    throw new Error(`unexpected hostcall operation: ${operation}`);
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

function assertStreamOutput(response, expected = CANNED_STREAM) {
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.outputs.length, 1);
  const [frame] = response.outputs;
  assert.equal(frame.portId, "stream");
  assert.equal(frame.wireFormat, "aligned-binary");
  assert.deepEqual(new Uint8Array(frame.payload), expected, "stream must pass through verbatim");
  return frame;
}

test("hostcap/flatsql-query artifact passes SDK compliance", async () => {
  const report = await validateArtifactWithStandards({
    manifest: readManifest(),
    wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH),
    standardsRoot: STANDARDS_ROOT,
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("hostcap/flatsql-query artifact exports the canonical ABI and imports only WASI + the sync hostcall bridge", async () => {
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

test("query forwards {sql, params} to storage.flatsql_query_stream and streams verbatim", async (t) => {
  const stub = createHostStub();
  const harness = await createHarness(t, stub);
  const request = {
    sql: "SELECT * FROM omm WHERE NORAD_CAT_ID = ? AND EPOCH > ?",
    params: [
      { t: "i64", v: 25544 },
      { t: "f64", v: 1751500800.5 },
    ],
  };
  const response = await harness.invoke({
    methodId: "query",
    inputs: [jsonInput("query", request)],
  });

  assertStreamOutput(response);
  assert.equal(stub.calls.length, 1);
  const call = stub.calls[0];
  assert.equal(call.operation, "storage.flatsql_query_stream");
  assert.equal(call.params.sql, request.sql);
  assert.deepEqual(call.params.params, request.params, "tagged params must forward verbatim");
});

test("query defaults params to [] when absent", async (t) => {
  const stub = createHostStub();
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({
    methodId: "query",
    inputs: [jsonInput("query", { sql: "SELECT COUNT(*) FROM omm" })],
  });

  assertStreamOutput(response);
  assert.equal(stub.calls[0].params.sql, "SELECT COUNT(*) FROM omm");
  assert.deepEqual(stub.calls[0].params.params, []);
});

test("query emits an empty stream frame for zero-row results", async (t) => {
  const stub = createHostStub({ stream: new Uint8Array(0) });
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({
    methodId: "query",
    inputs: [jsonInput("query", { sql: "SELECT * FROM omm WHERE 0 = 1" })],
  });

  assertStreamOutput(response, new Uint8Array(0));
});

test("query rejects a request without sql before any hostcall", async (t) => {
  const stub = createHostStub();
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({
    methodId: "query",
    inputs: [jsonInput("query", { params: [] })],
  });

  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "missing-sql");
  assert.equal(stub.calls.length, 0);
});

test("query surfaces host errors as plugin error status with the host message", async (t) => {
  const stub = createHostStub({
    failOps: { "storage.flatsql_query_stream": "flatsql query failed: no such table: nope" },
  });
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({
    methodId: "query",
    inputs: [jsonInput("query", { sql: "SELECT * FROM nope" })],
  });

  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "flatsql-query-stream-failed");
  assert.match(String(response.errorMessage), /no such table: nope/);
  assert.equal(response.outputs.length, 0);
});

test("hostcap/flatsql-query WasmEdge run requires the Go host bridge (transitional hostcall path)", async (t) => {
  // storage.flatsql_query_stream is served only by the Go node's storage cap
  // handler today; flatsql becomes an in-wasm component dependency in a later
  // task. Do not fake a server integration here.
  const inspection = await inspectModule(readWasm());
  assert.ok(inspection.imports.some((entry) => entry.module === "space_data_module_host"));
  t.skip("Requires the Go node's storage cap handler (server-only until flatsql in-wasm linkage lands).");
});

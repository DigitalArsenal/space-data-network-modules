import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as flatbuffers from "../../../../spacedatastandards.org/node_modules/flatbuffers/mjs/flatbuffers.js";
import {
  CAQ,
  CAQRequestT,
  CAQT,
  catalogQueryKind,
} from "../../../../spacedatastandards.org/lib/js/CAQ/main.js";
import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT = fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));

const FIXED_NOW_MS = 1_751_500_800_000; // 2025-07-03T00:00:00Z

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function readWasm() {
  return fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH));
}

// Build an SDS CAQ request envelope; QUERY carries the module's host-specific
// query string (JSON overrides for omm_bulk, SQL or {sql,params} for
// data_query) and MAX_COUNT optionally overrides the row limit.
function encodeCaqRequest(query, maxCount = 0) {
  const builder = new flatbuffers.Builder(512);
  const envelope = new CAQT(
    new CAQRequestT(catalogQueryKind.ROWS, query, 0, maxCount, 0),
    null,
  );
  const root = envelope.pack(builder);
  CAQ.finishCAQBuffer(builder, root);
  return builder.asUint8Array();
}

// Canned "ALIGNED size-prefixed FlatBuffer stream": two size-prefixed dummy
// frames. omm_bulk / data_query must pass these bytes through VERBATIM, so
// the frame contents only need to be deterministic.
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

// Host-bridge stub: serves plugin.getConfig / clock.now / the flatsql stream
// ops and records every outgoing hostcall (operation + decoded params) so
// tests can assert the module's resolved query payloads.
function createHostStub({ config = {}, failOps = {}, honorRef = false } = {}) {
  const calls = [];
  const dispatch = (operation, params) => {
    calls.push({ operation, params });
    if (failOps[operation]) {
      throw new Error(failOps[operation]);
    }
    switch (operation) {
      case "plugin.getConfig":
        return config;
      case "clock.now":
        return FIXED_NOW_MS;
      case "storage.flatsql_epoch_stream":
      case "storage.flatsql_query_stream":
        if (honorRef && params.deliver === "ref") {
          // Reference-delivery host (loop C.5c): the stream bytes stay
          // host-side; the module receives only the reference descriptor
          // fields.
          return {
            rows: 2,
            columns: 3,
            frames: 2,
            ref: { token: 41, size: CANNED_STREAM.length, frames: 2, fnv1a64: "00c0ffee00c0ffee" },
          };
        }
        return { rows: 2, columns: 3, stream: CANNED_STREAM };
      default:
        throw new Error(`unexpected hostcall operation: ${operation}`);
    }
  };
  return { calls, dispatch };
}

// Zero-input invokes (omm_bulk with no request frame) must use the command
// surface: a PIV request without payload-arena bytes flips the direct surface
// into plugin-owned external-arena output descriptors, which the non-SAB
// browser harness cannot materialize.
async function createHarness(t, stub, surface = "direct") {
  const harness = await createBrowserModuleHarness({
    wasmSource: readWasm(),
    manifest: readManifest(),
    surface,
    hostcallDispatch: stub.dispatch,
  });
  t.after(() => harness.destroy());
  return harness;
}

function findCall(stub, operation) {
  return stub.calls.find((entry) => entry.operation === operation);
}

function assertStreamOutput(response, portId) {
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.outputs.length, 1);
  const [frame] = response.outputs;
  assert.equal(frame.portId, portId);
  assert.equal(frame.wireFormat, "aligned-binary");
  assert.deepEqual(new Uint8Array(frame.payload), CANNED_STREAM, "stream must pass through verbatim");
  return frame;
}

test("data-source/retrieval artifact passes SDK compliance", async () => {
  const report = await validateArtifactWithStandards({
    manifest: readManifest(),
    wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH),
    standardsRoot: STANDARDS_ROOT,
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("data-source/retrieval artifact exports the canonical ABI and imports only WASI + the sync hostcall bridge", async () => {
  const inspection = await inspectModule(readWasm());
  assert.equal(inspection.profile, "module-host-abi");
  const importedModuleNames = Array.from(new Set(inspection.imports.map((entry) => entry.module))).sort();
  assert.deepEqual(importedModuleNames, ["space_data_module_host", "wasi_snapshot_preview1"]);
  const hostImports = inspection.imports
    .filter((entry) => entry.module === "space_data_module_host")
    .map((entry) => entry.name);
  for (const name of ["call", "response_len", "read_response"]) {
    assert.ok(hostImports.includes(name), `missing hostcall import ${name}`);
  }
  for (const required of [
    "_start",
    "plugin_alloc",
    "plugin_free",
    "plugin_invoke_stream",
    "plugin_get_manifest_flatbuffer",
    "plugin_get_manifest_flatbuffer_size",
  ]) {
    assert.ok(inspection.exports.includes(required), `missing export ${required}`);
  }
});

test("omm_bulk resolves the per-standard profile from module config and streams verbatim", async (t) => {
  const stub = createHostStub({
    config: {
      profiles: {
        "OMM.fbs": {
          profile: "as_of",
          limit: 1234,
          source: "celestrak-gp",
          epoch: 1751500000.25,
        },
      },
    },
  });
  const harness = await createHarness(t, stub, "command");
  const response = await harness.invoke({ methodId: "omm_bulk", inputs: [] });

  const frame = assertStreamOutput(response, "stream");
  assert.equal(frame.typeRef?.schemaName, "OMM.fbs");
  assert.equal(frame.typeRef?.fileIdentifier, "$OMM");

  assert.ok(findCall(stub, "plugin.getConfig"), "module must resolve defaults via plugin.getConfig");
  assert.equal(findCall(stub, "clock.now"), undefined, "config epoch must suppress the clock.now fallback");
  const epochCall = findCall(stub, "storage.flatsql_epoch_stream");
  assert.ok(epochCall, "missing storage.flatsql_epoch_stream hostcall");
  assert.equal(epochCall.params.schema, "OMM.fbs");
  assert.equal(epochCall.params.source, "celestrak-gp");
  assert.equal(epochCall.params.profile, "as_of");
  assert.equal(epochCall.params.limit, 1234);
  assert.ok(Math.abs(epochCall.params.epoch - 1751500000.25) < 1e-6);
});

test("omm_bulk falls back to compiled defaults (nearest / clock.now / 50000) when config is absent", async (t) => {
  const stub = createHostStub({ config: {} });
  const harness = await createHarness(t, stub, "command");
  const response = await harness.invoke({ methodId: "omm_bulk", inputs: [] });

  assertStreamOutput(response, "stream");
  assert.ok(findCall(stub, "clock.now"), "epoch must default to now via the clock.now hostcall");
  const epochCall = findCall(stub, "storage.flatsql_epoch_stream");
  assert.ok(epochCall);
  assert.equal(epochCall.params.schema, "OMM.fbs");
  assert.equal(epochCall.params.source, "");
  assert.equal(epochCall.params.profile, "nearest");
  assert.equal(epochCall.params.limit, 50000);
  assert.ok(Math.abs(epochCall.params.epoch - FIXED_NOW_MS / 1000) < 1e-6);
});

test("omm_bulk request-frame fields override config per call (CAQ QUERY JSON + MAX_COUNT)", async (t) => {
  const stub = createHostStub({
    config: {
      profiles: {
        "OMM.fbs": {
          profile: "as_of",
          limit: 1234,
          source: "celestrak-gp",
          epoch: 1751500000,
        },
      },
    },
  });
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({
    methodId: "omm_bulk",
    inputs: [
      {
        portId: "request",
        typeRef: { schemaName: "CAQ.fbs", fileIdentifier: "$CAQ" },
        payload: encodeCaqRequest(
          JSON.stringify({ profile: "forward", epoch: 123.5 }),
          77,
        ),
      },
    ],
  });

  assertStreamOutput(response, "stream");
  assert.equal(findCall(stub, "clock.now"), undefined);
  const epochCall = findCall(stub, "storage.flatsql_epoch_stream");
  assert.ok(epochCall);
  assert.equal(epochCall.params.profile, "forward", "frame profile must beat config");
  assert.ok(Math.abs(epochCall.params.epoch - 123.5) < 1e-6, "frame epoch must beat config");
  assert.equal(epochCall.params.limit, 77, "CAQ MAX_COUNT must override the limit");
  assert.equal(epochCall.params.source, "celestrak-gp", "config source must survive partial overrides");
});

test("data_query forwards {sql, params} to storage.flatsql_query_stream and streams verbatim", async (t) => {
  const stub = createHostStub();
  const harness = await createHarness(t, stub);
  const request = {
    sql: "SELECT * FROM omm WHERE NORAD_CAT_ID = ?",
    params: [{ t: "i64", v: 25544 }],
  };
  const response = await harness.invoke({
    methodId: "data_query",
    inputs: [
      {
        portId: "query",
        typeRef: { schemaName: "CAQ.fbs", fileIdentifier: "$CAQ" },
        payload: encodeCaqRequest(JSON.stringify(request)),
      },
    ],
  });

  assertStreamOutput(response, "rows");
  const queryCall = findCall(stub, "storage.flatsql_query_stream");
  assert.ok(queryCall, "missing storage.flatsql_query_stream hostcall");
  assert.equal(queryCall.params.sql, request.sql);
  assert.deepEqual(queryCall.params.params, request.params);
});

test("data_query accepts a plain SQL string in CAQRequest.QUERY", async (t) => {
  const stub = createHostStub();
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({
    methodId: "data_query",
    inputs: [
      {
        portId: "query",
        typeRef: { schemaName: "CAQ.fbs", fileIdentifier: "$CAQ" },
        payload: encodeCaqRequest("SELECT COUNT(*) FROM omm"),
      },
    ],
  });

  assertStreamOutput(response, "rows");
  const queryCall = findCall(stub, "storage.flatsql_query_stream");
  assert.ok(queryCall);
  assert.equal(queryCall.params.sql, "SELECT COUNT(*) FROM omm");
  assert.deepEqual(queryCall.params.params, []);
});

test("omm_bulk deliver:ref emits the body-reference descriptor instead of stream bytes", async (t) => {
  const stub = createHostStub({ config: {}, honorRef: true });
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({
    methodId: "omm_bulk",
    inputs: [
      {
        portId: "request",
        typeRef: { schemaName: "CAQ.fbs", fileIdentifier: "$CAQ" },
        payload: encodeCaqRequest(
          JSON.stringify({ deliver: "ref", profile: "nearest", epoch: 123.5, limit: 10 }),
        ),
      },
    ],
  });

  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.outputs.length, 1);
  const [frame] = response.outputs;
  assert.equal(frame.portId, "stream");
  const descriptor = JSON.parse(new TextDecoder().decode(new Uint8Array(frame.payload)));
  assert.equal(descriptor.$sdnbodyref, 1);
  assert.equal(descriptor.token, 41);
  assert.equal(descriptor.size, CANNED_STREAM.length);
  assert.equal(descriptor.frames, 2);
  assert.equal(descriptor.fnv1a64, "00c0ffee00c0ffee");

  const epochCall = findCall(stub, "storage.flatsql_epoch_stream");
  assert.equal(epochCall.params.deliver, "ref", "deliver:ref must forward to the host op");
});

test("omm_bulk deliver:ref falls back to verbatim bytes when the host ignores it", async (t) => {
  const stub = createHostStub({ config: {}, honorRef: false });
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({
    methodId: "omm_bulk",
    inputs: [
      {
        portId: "request",
        typeRef: { schemaName: "CAQ.fbs", fileIdentifier: "$CAQ" },
        payload: encodeCaqRequest(JSON.stringify({ deliver: "ref", epoch: 123.5 })),
      },
    ],
  });
  assertStreamOutput(response, "stream");
});

test("data_query deliver:ref emits the body-reference descriptor", async (t) => {
  const stub = createHostStub({ honorRef: true });
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({
    methodId: "data_query",
    inputs: [
      {
        portId: "query",
        typeRef: { schemaName: "CAQ.fbs", fileIdentifier: "$CAQ" },
        payload: encodeCaqRequest(
          JSON.stringify({ sql: "SELECT _data FROM omm", params: [], deliver: "ref" }),
        ),
      },
    ],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  const [frame] = response.outputs;
  assert.equal(frame.portId, "rows");
  const descriptor = JSON.parse(new TextDecoder().decode(new Uint8Array(frame.payload)));
  assert.equal(descriptor.$sdnbodyref, 1);
  assert.equal(descriptor.token, 41);
  const queryCall = findCall(stub, "storage.flatsql_query_stream");
  assert.equal(queryCall.params.deliver, "ref");
});

test("omm_bulk surfaces host errors as plugin error status with the host message", async (t) => {
  const stub = createHostStub({
    config: {},
    failOps: { "storage.flatsql_epoch_stream": "flatsql exploded: no such table" },
  });
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({ methodId: "omm_bulk", inputs: [] });

  assert.notEqual(response.statusCode, 0, "host error must fail the invoke");
  assert.equal(response.errorCode, "flatsql-epoch-stream-failed");
  assert.match(String(response.errorMessage), /flatsql exploded: no such table/);
  assert.equal(response.outputs.length, 0);
});

test("data-source/retrieval WasmEdge run requires the Go host bridge (lands in loop C.3)", async (t) => {
  // The artifact imports the sync space_data_module_host bridge, which the
  // plain `wasmedge` CLI harness does not provide — only the Go node
  // (sdn-server modulert HostBridge.BuildWasmEdgeHostFuncs) hosts these
  // functions. The Go-host integration test lands with the C.3 HTTP bridge
  // work; do not fake it here.
  const inspection = await inspectModule(readWasm());
  const needsHostBridge = inspection.imports.some(
    (entry) => entry.module === "space_data_module_host",
  );
  assert.equal(needsHostBridge, true);
  t.skip("Requires the Go node's space_data_module_host WasmEdge host functions (loop C.3).");
});

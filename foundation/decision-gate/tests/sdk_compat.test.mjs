import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CAQ } from "../../../../spacedatastandards.org/lib/js/CAQ/main.js";
import * as flatbuffers from "../../../../spacedatastandards.org/node_modules/flatbuffers/mjs/flatbuffers.js";
import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT = fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function readWasm() {
  return fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH));
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// JSON-bytes / raw-bytes frames ride the aligned-binary wire format.
function bytesInput(portId, bytes) {
  const payload = bytes instanceof Uint8Array ? bytes : encoder.encode(bytes);
  return {
    portId,
    typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: payload.byteLength },
    payload,
  };
}

function ommInput(portId, bytes) {
  const payload = bytes instanceof Uint8Array ? bytes : encoder.encode(bytes);
  return {
    portId,
    typeRef: {
      schemaName: "OMM.fbs",
      fileIdentifier: "$OMM",
      rootTypeName: "OMM",
      wireFormat: "aligned-binary",
      requiredAlignment: 8,
      byteLength: payload.byteLength,
    },
    payload,
  };
}

// Canned "ALIGNED size-prefixed FlatBuffer stream" (same deterministic frames
// as the retrieval/http-respond suites) — branch passes it through VERBATIM.
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

async function invoke(t, methodId, inputs) {
  const harness = await createBrowserModuleHarness({
    wasmSource: readWasm(),
    manifest: readManifest(),
    surface: "direct",
  });
  t.after(() => harness.destroy());
  return harness.invoke({ methodId, inputs });
}

function framesByPort(response) {
  assert.equal(response.statusCode, 0, response.errorMessage);
  const byPort = new Map();
  for (const frame of response.outputs) {
    byPort.set(frame.portId, frame);
  }
  return byPort;
}

function decodeCaqQuery(frame) {
  assert.equal(frame.typeRef?.schemaName, "CAQ.fbs");
  assert.equal(frame.typeRef?.fileIdentifier, "$CAQ");
  const bytes = new Uint8Array(frame.payload);
  const envelope = CAQ.getRootAsCAQ(new flatbuffers.ByteBuffer(bytes));
  const request = envelope.REQUEST();
  return request ? request.QUERY() : null;
}

test("foundation/decision-gate artifact passes SDK compliance", async () => {
  const report = await validateArtifactWithStandards({
    manifest: readManifest(),
    wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH),
    standardsRoot: STANDARDS_ROOT,
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("foundation/decision-gate artifact is standalone WASI (pure compute)", async () => {
  const inspection = await inspectModule(readWasm());
  const importedModuleNames = Array.from(new Set(inspection.imports.map((entry) => entry.module))).sort();
  assert.equal(inspection.profile, "standalone");
  assert.deepEqual(importedModuleNames, ["wasi_snapshot_preview1"], "pure compute: WASI imports only");
});

test("dispatch omm_bulk: $CAQ with decision.query JSON plus routed passthrough", async (t) => {
  const decision = JSON.stringify({
    route: "omm_bulk",
    format: "flatbuffer",
    query: { schema: "OMM.fbs", profile: "nearest", epoch: 1751500800, limit: 100 },
  });
  const response = await invoke(t, "dispatch", [bytesInput("decision", decision)]);
  const byPort = framesByPort(response);
  assert.deepEqual([...byPort.keys()].sort(), ["omm_bulk", "routed"]);
  const query = decodeCaqQuery(byPort.get("omm_bulk"));
  assert.deepEqual(JSON.parse(query), {
    // format=flatbuffer: the stream passes through to the body verbatim, so
    // the gate elects out-of-band reference delivery (loop C.5c).
    deliver: "ref",
    schema: "OMM.fbs",
    profile: "nearest",
    epoch: 1751500800,
    limit: 100,
  });
  assert.equal(decoder.decode(byPort.get("routed").payload), decision);
});

test("dispatch omm_bulk format=json keeps byte delivery (no deliver:ref)", async (t) => {
  const decision = JSON.stringify({
    route: "omm_bulk",
    format: "json",
    query: { schema: "OMM.fbs", limit: 5 },
  });
  const response = await invoke(t, "dispatch", [bytesInput("decision", decision)]);
  const byPort = framesByPort(response);
  const query = JSON.parse(decodeCaqQuery(byPort.get("omm_bulk")));
  assert.equal(query.deliver, undefined, "json path needs the bytes in-flow for omm-json");
  assert.equal(query.limit, 5);
});

test("dispatch omm_bulk without a query object emits an empty-QUERY $CAQ", async (t) => {
  const decision = JSON.stringify({ route: "omm_bulk", format: "json" });
  const response = await invoke(t, "dispatch", [bytesInput("decision", decision)]);
  const byPort = framesByPort(response);
  const query = decodeCaqQuery(byPort.get("omm_bulk"));
  assert.ok(query === null || query === "", `expected empty QUERY, got ${query}`);
});

test("dispatch data_query: $CAQ QUERY carries {sql,params} JSON", async (t) => {
  const decision = JSON.stringify({
    route: "data_query",
    format: "flatbuffer",
    sql: "SELECT * FROM omm WHERE NORAD_CAT_ID = ?",
    params: [{ t: "i64", v: 25544 }],
  });
  const response = await invoke(t, "dispatch", [bytesInput("decision", decision)]);
  const byPort = framesByPort(response);
  assert.deepEqual([...byPort.keys()].sort(), ["data_query", "routed"]);
  assert.deepEqual(JSON.parse(decodeCaqQuery(byPort.get("data_query"))), {
    deliver: "ref",
    sql: "SELECT * FROM omm WHERE NORAD_CAT_ID = ?",
    params: [{ t: "i64", v: 25544 }],
  });
});

test("dispatch data_query without SQL degrades to not_found", async (t) => {
  const decision = JSON.stringify({ route: "data_query", format: "flatbuffer" });
  const response = await invoke(t, "dispatch", [bytesInput("decision", decision)]);
  const byPort = framesByPort(response);
  assert.deepEqual([...byPort.keys()], ["not_found"]);
});

test("dispatch not_found passes the decision through on not_found", async (t) => {
  const decision = JSON.stringify({ route: "not_found", format: "flatbuffer", error: "no route" });
  const response = await invoke(t, "dispatch", [bytesInput("decision", decision)]);
  const byPort = framesByPort(response);
  assert.deepEqual([...byPort.keys()], ["not_found"]);
  assert.equal(decoder.decode(byPort.get("not_found").payload), decision);
});

test("dispatch fails without a decision frame", async (t) => {
  const response = await invoke(t, "dispatch", []);
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "missing-required-input");
});

test("branch flatbuffer: verbatim stream + decision + deterministic etag", async (t) => {
  const decision = JSON.stringify({ route: "omm_bulk", format: "flatbuffer" });
  const response = await invoke(t, "branch", [
    bytesInput("decision", decision),
    ommInput("stream", CANNED_STREAM),
  ]);
  const byPort = framesByPort(response);
  assert.deepEqual([...byPort.keys()].sort(), ["decision", "etag", "flatbuffer"]);
  assert.deepEqual(new Uint8Array(byPort.get("flatbuffer").payload), CANNED_STREAM);
  assert.equal(byPort.get("flatbuffer").typeRef?.schemaName, "OMM.fbs");
  assert.equal(byPort.get("flatbuffer").typeRef?.fileIdentifier, "$OMM");
  assert.equal(byPort.get("flatbuffer").typeRef?.rootTypeName, "OMM");
  assert.equal(decoder.decode(byPort.get("decision").payload), decision);
  const etag = decoder.decode(byPort.get("etag").payload);
  assert.match(etag, /^W\/"fnv1a64-[0-9a-f]{16}"$/);

  // Deterministic: the same stream always hashes to the same entity tag.
  const again = await invoke(t, "branch", [
    bytesInput("decision", decision),
    ommInput("stream", CANNED_STREAM),
  ]);
  assert.equal(decoder.decode(framesByPort(again).get("etag").payload), etag);
});

test("branch flatbuffer: body-reference descriptor passes through with the host-computed etag", async (t) => {
  const decision = JSON.stringify({ route: "omm_bulk", format: "flatbuffer" });
  const descriptor = JSON.stringify({
    $sdnbodyref: 1,
    token: 3,
    size: 8_637_212,
    frames: 29_000,
    fnv1a64: "0123456789abcdef",
  });
  const response = await invoke(t, "branch", [
    bytesInput("decision", decision),
    ommInput("stream", descriptor),
  ]);
  const byPort = framesByPort(response);
  assert.deepEqual([...byPort.keys()].sort(), ["decision", "etag", "flatbuffer"]);
  assert.equal(
    decoder.decode(byPort.get("flatbuffer").payload),
    descriptor,
    "reference descriptors pass through verbatim (the stream bytes never enter the flow)",
  );
  assert.equal(
    decoder.decode(byPort.get("etag").payload),
    'W/"fnv1a64-0123456789abcdef"',
    "etag formats the host-computed word-folded FNV-1a 64 exactly like hashed-stream etags",
  );
});

test("branch json: stream routed to the json port", async (t) => {
  const decision = JSON.stringify({ route: "omm_bulk", format: "json" });
  const response = await invoke(t, "branch", [
    bytesInput("decision", decision),
    ommInput("stream", CANNED_STREAM),
  ]);
  const byPort = framesByPort(response);
  assert.deepEqual([...byPort.keys()].sort(), ["decision", "etag", "json"]);
  assert.deepEqual(new Uint8Array(byPort.get("json").payload), CANNED_STREAM);
  assert.equal(byPort.get("json").typeRef?.fileIdentifier, "$OMM");
});

test("branch fails without the stream frame", async (t) => {
  const decision = JSON.stringify({ route: "omm_bulk", format: "flatbuffer" });
  const response = await invoke(t, "branch", [bytesInput("decision", decision)]);
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "missing-required-input");
});

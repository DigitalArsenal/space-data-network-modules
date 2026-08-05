import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { decodeHttpResponse, findHttpHeader } from "space-data-module-sdk/http";
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

// JSON-bytes / raw-bytes frames ride the aligned-binary wire format.
function bytesInput(portId, bytes) {
  const payload = bytes instanceof Uint8Array ? bytes : encoder.encode(bytes);
  return {
    portId,
    typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: payload.byteLength },
    payload,
  };
}

// Canned "ALIGNED size-prefixed FlatBuffer stream" with two frames; respond
// only counts the framing, so deterministic dummy contents suffice.
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

async function invokeRespond(t, inputs) {
  const harness = await createBrowserModuleHarness({
    wasmSource: readWasm(),
    manifest: readManifest(),
    surface: "direct",
  });
  t.after(() => harness.destroy());
  return harness.invoke({ methodId: "respond", inputs });
}

function decodeResponseOutput(response) {
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.outputs.length, 1, "respond must emit exactly one $HTR frame");
  const [frame] = response.outputs;
  assert.equal(frame.portId, "response");
  assert.equal(frame.typeRef?.schemaName, "HttpResponseAbi.fbs");
  assert.equal(frame.typeRef?.fileIdentifier, "$HTR");
  return decodeHttpResponse(new Uint8Array(frame.payload));
}

test("foundation/http-respond artifact passes SDK compliance", async () => {
  const report = await validateArtifactWithStandards({
    manifest: readManifest(),
    wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH),
    standardsRoot: STANDARDS_ROOT,
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("foundation/http-respond artifact is standalone WASI with canonical exports", async () => {
  const inspection = await inspectModule(readWasm());
  const importedModuleNames = Array.from(new Set(inspection.imports.map((entry) => entry.module))).sort();
  assert.equal(inspection.profile, "standalone");
  assert.deepEqual(importedModuleNames, ["wasi_snapshot_preview1"], "pure compute: WASI imports only");
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

test("respond 200 flatbuffer: stream content-type, record count, etag, verbatim body", async (t) => {
  const decision = JSON.stringify({
    route: "omm_bulk",
    format: "flatbuffer",
    query: { schema: "OMM.fbs" },
  });
  const response = await invokeRespond(t, [
    bytesInput("decision", decision),
    bytesInput("body", CANNED_STREAM),
    bytesInput("etag", "W/\"omm-42\""),
  ]);
  const http = decodeResponseOutput(response);
  assert.equal(http.status, 200);
  assert.equal(findHttpHeader(http.headers, "Content-Type"), "application/vnd.sdn.flatbuffers.stream");
  assert.equal(findHttpHeader(http.headers, "X-SDN-Record-Count"), "2");
  assert.equal(findHttpHeader(http.headers, "ETag"), "W/\"omm-42\"");
  assert.deepEqual(new Uint8Array(http.body), CANNED_STREAM, "body must pass through verbatim");
  // $HTR contract: header vector sorted by lower-cased NAME.
  const names = http.headers.map((header) => header.name);
  assert.deepEqual(names, [...names].sort());
  assert.ok(names.every((name) => name === name.toLowerCase()));
});

test("respond 200 flatbuffer with a body-reference descriptor: $HTR BODY_REF fields, no inline body", async (t) => {
  const decision = JSON.stringify({ route: "omm_bulk", format: "flatbuffer" });
  const descriptor = JSON.stringify({
    $sdnbodyref: 1,
    token: 12,
    size: 8_637_212,
    frames: 29_000,
    fnv1a64: "0011223344556677",
  });
  const response = await invokeRespond(t, [
    bytesInput("decision", decision),
    bytesInput("body", descriptor),
    bytesInput("etag", 'W/"fnv1a64-0011223344556677"'),
  ]);
  const http = decodeResponseOutput(response);
  assert.equal(http.status, 200);
  assert.equal(findHttpHeader(http.headers, "Content-Type"), "application/vnd.sdn.flatbuffers.stream");
  assert.equal(findHttpHeader(http.headers, "X-SDN-Record-Count"), "29000",
    "record count comes from the descriptor's frames field");
  assert.equal(findHttpHeader(http.headers, "ETag"), 'W/"fnv1a64-0011223344556677"');
  assert.equal(http.body.length, 0, "referenced bodies carry no inline bytes");
  assert.equal(Number(http.bodyRefToken), 12);
  assert.equal(http.bodyRefSize, 8_637_212);
});

test("respond rejects a body-reference descriptor without token/size", async (t) => {
  const decision = JSON.stringify({ route: "omm_bulk", format: "flatbuffer" });
  const response = await invokeRespond(t, [
    bytesInput("decision", decision),
    bytesInput("body", JSON.stringify({ $sdnbodyref: 1 })),
  ]);
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "invalid-body-ref");
});

test("respond 200 json bare array: application/json, record count from top-level elements, verbatim body", async (t) => {
  const decision = JSON.stringify({ route: "data_query", format: "json", sql: "SELECT 1" });
  // Bare top-level array (the json data surface): count of top-level
  // elements travels in x-sdn-record-count, exactly like the fb stream path.
  const body = JSON.stringify([
    { norad_cat_id: 5, object_name: "VANGUARD 1", tags: ["a,b", "c]d"] },
    { norad_cat_id: 11, object_name: "VANGUARD [2]" },
    42,
  ]);
  const response = await invokeRespond(t, [
    bytesInput("decision", decision),
    bytesInput("body", body),
  ]);
  const http = decodeResponseOutput(response);
  assert.equal(http.status, 200);
  assert.equal(findHttpHeader(http.headers, "content-type"), "application/json");
  assert.equal(findHttpHeader(http.headers, "x-sdn-record-count"), "3");
  assert.equal(findHttpHeader(http.headers, "etag"), null);
  assert.equal(new TextDecoder().decode(http.body), body);
});

test("respond 200 json empty array: record count 0", async (t) => {
  const decision = JSON.stringify({ route: "data_query", format: "json", sql: "SELECT 1" });
  const response = await invokeRespond(t, [
    bytesInput("decision", decision),
    bytesInput("body", "[]"),
  ]);
  const http = decodeResponseOutput(response);
  assert.equal(http.status, 200);
  assert.equal(findHttpHeader(http.headers, "x-sdn-record-count"), "0");
});

test("respond 200 json non-array body: no record count, verbatim body", async (t) => {
  const decision = JSON.stringify({ route: "data_query", format: "json", sql: "SELECT 1" });
  const body = JSON.stringify({ error: "nope" });
  const response = await invokeRespond(t, [
    bytesInput("decision", decision),
    bytesInput("body", body),
  ]);
  const http = decodeResponseOutput(response);
  assert.equal(http.status, 200);
  assert.equal(findHttpHeader(http.headers, "x-sdn-record-count"), null);
  assert.equal(new TextDecoder().decode(http.body), body);
});

test("respond 200 with no body frame: empty body, record count 0", async (t) => {
  const decision = JSON.stringify({ route: "omm_bulk", format: "flatbuffer" });
  const response = await invokeRespond(t, [bytesInput("decision", decision)]);
  const http = decodeResponseOutput(response);
  assert.equal(http.status, 200);
  assert.equal(http.body.length, 0);
  assert.equal(findHttpHeader(http.headers, "x-sdn-record-count"), "0");
});

test("respond 304 when the etag matches decision.ifNoneMatch", async (t) => {
  const decision = JSON.stringify({
    route: "omm_bulk",
    format: "flatbuffer",
    ifNoneMatch: "W/\"omm-42\"",
  });
  const response = await invokeRespond(t, [
    bytesInput("decision", decision),
    bytesInput("body", CANNED_STREAM),
    bytesInput("etag", "W/\"omm-42\""),
  ]);
  const http = decodeResponseOutput(response);
  assert.equal(http.status, 304);
  assert.equal(http.body.length, 0, "304 body must be empty");
  assert.equal(findHttpHeader(http.headers, "etag"), "W/\"omm-42\"");
});

test("respond 200 when the etag does not match If-None-Match", async (t) => {
  const decision = JSON.stringify({
    route: "omm_bulk",
    format: "flatbuffer",
    ifNoneMatch: "W/\"stale\"",
  });
  const response = await invokeRespond(t, [
    bytesInput("decision", decision),
    bytesInput("body", CANNED_STREAM),
    bytesInput("etag", "W/\"omm-42\""),
  ]);
  const http = decodeResponseOutput(response);
  assert.equal(http.status, 200);
  assert.deepEqual(new Uint8Array(http.body), CANNED_STREAM);
});

test("respond 404 on a not_found decision with the routed error message", async (t) => {
  const decision = JSON.stringify({
    route: "not_found",
    format: "flatbuffer",
    error: "no route for GET /nope",
  });
  const response = await invokeRespond(t, [bytesInput("decision", decision)]);
  const http = decodeResponseOutput(response);
  assert.equal(http.status, 404);
  assert.equal(findHttpHeader(http.headers, "content-type"), "application/json");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(http.body)), {
    error: "no route for GET /nope",
  });
});

test("respond 502 when an upstream error frame is present (wins over body)", async (t) => {
  const decision = JSON.stringify({ route: "omm_bulk", format: "flatbuffer" });
  const response = await invokeRespond(t, [
    bytesInput("decision", decision),
    bytesInput("body", CANNED_STREAM),
    bytesInput("error", JSON.stringify({ error: "flatsql exploded: no such table" })),
  ]);
  const http = decodeResponseOutput(response);
  assert.equal(http.status, 502);
  assert.equal(findHttpHeader(http.headers, "content-type"), "application/json");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(http.body)), {
    error: "flatsql exploded: no such table",
  });
});

test("respond fails the invoke when the decision frame is missing", async (t) => {
  const response = await invokeRespond(t, [bytesInput("body", CANNED_STREAM)]);
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "missing-required-input");
  assert.equal(response.outputs.length, 0);
});

test("respond error decision: explicit status + pnm pointer body (loop G.4)", async (t) => {
  const decision = JSON.stringify({
    route: "error",
    format: "flatbuffer",
    status: 503,
    error: "dataset OMM from peer 16Uiu2HAmX is not pinned on this gateway",
    pnm: {
      attribution: "signature",
      batch_id: "batch-new",
      cid: "bafy-manifest-new",
      file_id: "sdn-OMM-full:OMM.fbs:batch-new:part-000001",
      publish_timestamp: "2026-07-06T06:00:00Z",
      schema: "OMM.fbs",
      signature_verified: true,
      standard: "OMM",
    },
  });
  const response = await invokeRespond(t, [bytesInput("decision", decision)]);
  const http = decodeResponseOutput(response);
  assert.equal(http.status, 503);
  assert.equal(findHttpHeader(http.headers, "content-type"), "application/json");
  const body = JSON.parse(new TextDecoder().decode(http.body));
  assert.match(body.error, /not pinned/);
  assert.equal(body.pnm.cid, "bafy-manifest-new");
  assert.equal(body.pnm.publish_timestamp, "2026-07-06T06:00:00Z");
  assert.equal(body.pnm.signature_verified, true);
});

test("respond error decision: out-of-range or missing status clamps to 503; 406 passes (loop G.4)", async (t) => {
  const noStatus = decodeResponseOutput(await invokeRespond(t, [
    bytesInput("decision", JSON.stringify({ route: "error", format: "json", error: "nope" })),
  ]));
  assert.equal(noStatus.status, 503);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(noStatus.body)), { error: "nope" });

  const tooBig = decodeResponseOutput(await invokeRespond(t, [
    bytesInput("decision", JSON.stringify({ route: "error", format: "json", status: 700, error: "nope" })),
  ]));
  assert.equal(tooBig.status, 503);

  const notAcceptable = decodeResponseOutput(await invokeRespond(t, [
    bytesInput("decision", JSON.stringify({
      route: "error", format: "json", status: 406,
      error: "format=json is not available for cat on this surface",
    })),
  ]));
  assert.equal(notAcceptable.status, 406);
});

/*
 * Flow-level tests for the compiled data-retrieval flow (loop C.3c).
 *
 * Loads the LINKED-DIRECT flow bundle emitted by
 * `space-data-module flow compile` (../dist/isomorphic/module.wasm) into the
 * SDK's JS flow host (createFlowRuntimeHost — the same
 * space_data_module_runtime_* ABI the Go host binds), pumps real $HTQ
 * HttpRequest envelopes at the http-request trigger, and reads the $HTR
 * responses from the host-model egress sink. Every inter-node frame
 * (route -> gate -> retrieval -> branch -> [omm-json] -> respond) stays
 * inside the artifact's linear memory; the ONLY host surface is the
 * capability hostcall bridge (space_data_module_host.call/response_len/
 * read_response), stubbed here with the canned-envelope pattern from
 * data-source/retrieval/tests.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as flatbuffers from "../../../../spacedatastandards.org/node_modules/flatbuffers/mjs/flatbuffers.js";
import { OMM } from "../../../../spacedatastandards.org/lib/js/OMM/main.js";
import { createFlowRuntimeHost, decodeFlowProgram } from "space-data-module-sdk/flow";
import { decodeHttpResponse, encodeHttpRequest, findHttpHeader } from "space-data-module-sdk/http";

const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const ARTIFACT_PATH = new URL("../dist/artifact.json", import.meta.url);
const MANIFEST_PATH = new URL("../dist/plugin-manifest.json", import.meta.url);

const FIXED_NOW_MS = 1_782_950_400_000; // 2026-07-02T00:00:00Z
const EPOCH_SECONDS = 1_782_950_400;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function readWasm() {
  return new Uint8Array(fs.readFileSync(fileURLToPath(WASM_PATH)));
}

// ---------------------------------------------------------------------------
// Real $OMM stream (canonical spacedatastandards.org JS encoder) — the
// canned retrieval result. The flow must pass these bytes through VERBATIM
// on the flatbuffer path and field-extract them exactly on the json path.
// ---------------------------------------------------------------------------

const RECORDS = [
  {
    norad_cat_id: 25544,
    object_name: "ISS (ZARYA)",
    object_id: "1998-067A",
    epoch: "2026-07-01T12:00:00.000000Z",
    mean_motion: 15.49309239,
    eccentricity: 0.0007976,
    inclination: 51.6416,
  },
  {
    norad_cat_id: 33591,
    object_name: "NOAA 19",
    object_id: "2009-005A",
    epoch: "2026-07-01T00:00:00.000000Z",
    mean_motion: 14.12501077,
    eccentricity: 0.0013872,
    inclination: 99.1943,
  },
];

function encodeOmm(record) {
  const builder = new flatbuffers.Builder(512);
  const objectName = builder.createString(record.object_name);
  const objectId = builder.createString(record.object_id);
  const epoch = builder.createString(record.epoch);
  OMM.startOMM(builder);
  OMM.addObjectName(builder, objectName);
  OMM.addObjectId(builder, objectId);
  OMM.addEpoch(builder, epoch);
  OMM.addMeanMotion(builder, record.mean_motion);
  OMM.addEccentricity(builder, record.eccentricity);
  OMM.addInclination(builder, record.inclination);
  OMM.addNoradCatId(builder, record.norad_cat_id);
  OMM.finishOMMBuffer(builder, OMM.endOMM(builder));
  return builder.asUint8Array();
}

function buildOmmStream(records) {
  const frames = records.map(encodeOmm);
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

const OMM_STREAM = buildOmmStream(RECORDS);

// ---------------------------------------------------------------------------
// Hostcall bridge stub — the canned-envelope pattern from
// data-source/retrieval/tests, at the wasm import level: the hostcall wire
// envelope is [u32le metaLen][meta JSON][u32le segCount]([u32le segLen][seg])*.
// ---------------------------------------------------------------------------

function encodeHostcallEnvelope(meta, segments = []) {
  const metaBytes = encoder.encode(JSON.stringify(meta));
  const total =
    4 + metaBytes.length + 4 + segments.reduce((sum, segment) => sum + 4 + segment.length, 0);
  const envelope = new Uint8Array(total);
  const view = new DataView(envelope.buffer);
  let offset = 0;
  view.setUint32(offset, metaBytes.length, true);
  envelope.set(metaBytes, offset + 4);
  offset += 4 + metaBytes.length;
  view.setUint32(offset, segments.length, true);
  offset += 4;
  for (const segment of segments) {
    view.setUint32(offset, segment.length, true);
    envelope.set(segment, offset + 4);
    offset += 4 + segment.length;
  }
  return envelope;
}

function decodeHostcallRequestMeta(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const metaLength = view.getUint32(0, true);
  const metaText = decoder.decode(bytes.subarray(4, 4 + metaLength));
  return metaText ? JSON.parse(metaText) : {};
}

function createHostcallStub({ failOps = {} } = {}) {
  const calls = [];
  let memoryRef = { memory: null };
  let response = new Uint8Array(0);

  const respond = (operation, params) => {
    if (failOps[operation]) {
      return encodeHostcallEnvelope({ ok: false, message: failOps[operation] });
    }
    switch (operation) {
      case "plugin.getConfig":
        return encodeHostcallEnvelope({ ok: false, message: "no module config" });
      case "clock.now":
        return encodeHostcallEnvelope({ ok: true, result: FIXED_NOW_MS });
      case "storage.flatsql_epoch_stream":
      case "storage.flatsql_query_stream":
        return encodeHostcallEnvelope(
          { ok: true, result: { rows: RECORDS.length, columns: 3 } },
          [OMM_STREAM],
        );
      default:
        return encodeHostcallEnvelope({ ok: false, message: `unexpected hostcall ${operation}` });
    }
  };

  const imports = {
    space_data_module_host: {
      call(opPtr, opLen, payloadPtr, payloadLen) {
        const heap = new Uint8Array(memoryRef.memory.buffer);
        const operation = decoder.decode(heap.subarray(opPtr, opPtr + opLen));
        const payload = heap.slice(payloadPtr, payloadPtr + payloadLen);
        const params = decodeHostcallRequestMeta(payload);
        calls.push({ operation, params });
        response = respond(operation, params);
        return 0;
      },
      response_len() {
        return response.length;
      },
      read_response(dstPtr, dstLen) {
        const heap = new Uint8Array(memoryRef.memory.buffer);
        const length = Math.min(dstLen, response.length);
        heap.set(response.subarray(0, length), dstPtr);
        return length;
      },
    },
  };

  return { calls, imports, memoryRef };
}

// ---------------------------------------------------------------------------
// Flow runner: fresh artifact instance per request sequence; $HTQ in via the
// http-request trigger, $HTR out via the host-model egress sink.
// ---------------------------------------------------------------------------

async function createFlow(options = {}) {
  const stub = createHostcallStub(options);
  const host = await createFlowRuntimeHost({
    wasmSource: readWasm(),
    extraImports: stub.imports,
  });
  stub.memoryRef.memory = host.memory;
  return { host, stub };
}

async function pumpRequest(flow, request) {
  const responses = [];
  flow.host.enqueueTriggerFrame(0, {
    portId: "request",
    bytes: encodeHttpRequest(request),
  });
  const drain = await flow.host.drain(
    {
      "sdn.flow.egress:emit": ({ frames }) => {
        responses.push(...frames);
        return { statusCode: 0 };
      },
    },
    { maxIterations: 100 },
  );
  assert.equal(responses.length, 1, `expected exactly one $HTR frame (drain=${JSON.stringify(drain)})`);
  assert.equal(responses[0].portId, "response");
  return decodeHttpResponse(responses[0].bytes);
}

// ---------------------------------------------------------------------------
// Artifact shape
// ---------------------------------------------------------------------------

test("compiled flow bundle: descriptor tables, capability union, embedded FLOW program", async () => {
  const artifact = JSON.parse(fs.readFileSync(fileURLToPath(ARTIFACT_PATH), "utf8"));
  assert.deepEqual(artifact.capabilities, ["storage_query"], "capability union = union of node capabilities");
  const manifest = JSON.parse(fs.readFileSync(fileURLToPath(MANIFEST_PATH), "utf8"));
  assert.deepEqual(manifest.capabilities, ["storage_query"]);
  assert.equal(manifest.pluginFamily, "flow");
  assert.deepEqual(
    manifest.dependencies.map((dependency) => dependency.pluginId),
    [
      "com.digitalarsenal.foundation.http-route",
      "com.digitalarsenal.foundation.decision-gate",
      "com.digitalarsenal.data-source.retrieval",
      "com.digitalarsenal.foundation.omm-json",
      "com.digitalarsenal.foundation.http-respond",
    ],
  );

  const flow = await createFlow();
  assert.equal(flow.host.nodeCount, 8);
  assert.equal(flow.host.edgeCount, 13);
  assert.equal(flow.host.triggerCount, 1);
  assert.equal(flow.host.dependencyCount, 5, "retrieval linked once for both of its nodes");
  assert.equal(flow.host.getNodeDispatchDescriptor(0).dispatchModel, "linked-direct");
  assert.equal(flow.host.getNodeDispatchDescriptor(7).dispatchModel, "host");
  assert.equal(flow.host.getNodeDispatchDescriptor(7).pluginId, "sdn.flow.egress");

  const exports = flow.host.instance.exports;
  const ptr = exports.flow_get_manifest_flatbuffer();
  const size = exports.flow_get_manifest_flatbuffer_size();
  const program = decodeFlowProgram(new Uint8Array(flow.host.memory.buffer, ptr, size).slice());
  assert.equal(program.programId, "com.digitalarsenal.flows.data-retrieval");
  assert.equal(program.nodes.length, 8);
});

// ---------------------------------------------------------------------------
// $HTQ /omm/bulk -> $HTR with the verbatim retrieval stream
// ---------------------------------------------------------------------------

test("GET /omm/bulk streams the $OMM aligned stream verbatim (200 flatbuffer)", async () => {
  const flow = await createFlow();
  const http = await pumpRequest(flow, {
    method: "GET",
    path: "/omm/bulk",
    query: `epoch=${EPOCH_SECONDS}&limit=100&profile=nearest`,
  });

  assert.equal(http.status, 200);
  assert.equal(findHttpHeader(http.headers, "content-type"), "application/vnd.sdn.flatbuffers.stream");
  assert.equal(findHttpHeader(http.headers, "x-sdn-record-count"), "2");
  assert.match(findHttpHeader(http.headers, "etag"), /^W\/"fnv1a64-[0-9a-f]{16}"$/);
  assert.deepEqual(new Uint8Array(http.body), OMM_STREAM, "stream must pass through verbatim");

  // The ONLY hostcalls that left the sandbox are capability ops; the
  // retrieval node resolved the epoch profile from the request frame.
  assert.deepEqual(
    flow.stub.calls.map((call) => call.operation),
    ["plugin.getConfig", "storage.flatsql_epoch_stream"],
  );
  const epochCall = flow.stub.calls[1];
  assert.equal(epochCall.params.schema, "OMM.fbs");
  assert.equal(epochCall.params.profile, "nearest");
  assert.equal(epochCall.params.limit, 100);
  assert.equal(Math.trunc(epochCall.params.epoch), EPOCH_SECONDS);
});

test("GET /omm/bulk without an epoch defaults through clock.now", async () => {
  const flow = await createFlow();
  const http = await pumpRequest(flow, { method: "GET", path: "/omm/bulk", query: "" });
  assert.equal(http.status, 200);
  assert.deepEqual(
    flow.stub.calls.map((call) => call.operation),
    ["plugin.getConfig", "clock.now", "storage.flatsql_epoch_stream"],
  );
  assert.equal(Math.trunc(flow.stub.calls[2].params.epoch), FIXED_NOW_MS / 1000);
  assert.equal(flow.stub.calls[2].params.limit, 50000, "compiled fallback limit");
});

// ---------------------------------------------------------------------------
// format=json -> JSON body via omm-json
// ---------------------------------------------------------------------------

test("GET /omm/bulk?format=json returns the omm-json encoding (200 json)", async () => {
  const flow = await createFlow();
  const http = await pumpRequest(flow, {
    method: "GET",
    path: "/omm/bulk",
    query: `format=json&epoch=${EPOCH_SECONDS}`,
  });

  assert.equal(http.status, 200);
  assert.equal(findHttpHeader(http.headers, "content-type"), "application/json");
  assert.equal(findHttpHeader(http.headers, "x-sdn-record-count"), null);
  const body = JSON.parse(decoder.decode(http.body));
  assert.equal(body.count, 2);
  assert.equal(body.records.length, 2);
  assert.deepEqual(
    body.records.map((record) => [record.norad_cat_id, record.object_name, record.epoch]),
    RECORDS.map((record) => [record.norad_cat_id, record.object_name, record.epoch]),
  );
  assert.equal(body.records[0].mean_motion, RECORDS[0].mean_motion, "field extraction is exact");
});

// ---------------------------------------------------------------------------
// If-None-Match -> 304
// ---------------------------------------------------------------------------

test("GET /omm/bulk with a matching If-None-Match returns 304 with an empty body", async () => {
  const flow = await createFlow();
  const first = await pumpRequest(flow, {
    method: "GET",
    path: "/omm/bulk",
    query: `epoch=${EPOCH_SECONDS}`,
  });
  assert.equal(first.status, 200);
  const etag = findHttpHeader(first.headers, "etag");
  assert.match(etag, /^W\/"fnv1a64-/);

  const second = await pumpRequest(flow, {
    method: "GET",
    path: "/omm/bulk",
    query: `epoch=${EPOCH_SECONDS}`,
    headers: { "if-none-match": etag },
  });
  assert.equal(second.status, 304);
  assert.equal(second.body.length, 0, "304 body must be empty");
  assert.equal(findHttpHeader(second.headers, "etag"), etag);

  const third = await pumpRequest(flow, {
    method: "GET",
    path: "/omm/bulk",
    query: `epoch=${EPOCH_SECONDS}`,
    headers: { "if-none-match": 'W/"stale"' },
  });
  assert.equal(third.status, 200, "stale validator revalidates to 200");
  assert.deepEqual(new Uint8Array(third.body), OMM_STREAM);
});

// ---------------------------------------------------------------------------
// data_query route
// ---------------------------------------------------------------------------

test("POST /query forwards {sql,params} to storage.flatsql_query_stream and streams verbatim", async () => {
  const flow = await createFlow();
  const sql = "SELECT * FROM omm WHERE NORAD_CAT_ID = ?";
  const params = [{ t: "i64", v: 25544 }];
  const http = await pumpRequest(flow, {
    method: "POST",
    path: "/query",
    query: "",
    body: JSON.stringify({ sql, params }),
  });

  assert.equal(http.status, 200);
  assert.equal(findHttpHeader(http.headers, "content-type"), "application/vnd.sdn.flatbuffers.stream");
  assert.deepEqual(new Uint8Array(http.body), OMM_STREAM, "rows pass through verbatim");
  assert.deepEqual(
    flow.stub.calls.map((call) => call.operation),
    ["storage.flatsql_query_stream"],
  );
  assert.equal(flow.stub.calls[0].params.sql, sql);
  assert.deepEqual(flow.stub.calls[0].params.params, params);
});

// ---------------------------------------------------------------------------
// not_found route
// ---------------------------------------------------------------------------

test("GET /nope routes to 404 without touching storage", async () => {
  const flow = await createFlow();
  const http = await pumpRequest(flow, { method: "GET", path: "/nope", query: "" });
  assert.equal(http.status, 404);
  assert.equal(findHttpHeader(http.headers, "content-type"), "application/json");
  const body = JSON.parse(decoder.decode(http.body));
  assert.ok(typeof body.error === "string" && body.error.length > 0);
  assert.deepEqual(flow.stub.calls, [], "no hostcalls for unroutable requests");
});

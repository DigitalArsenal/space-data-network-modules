/*
 * Flow-level tests for the compiled node-activity flow (M2 node-activity
 * flow) — BRIDGE mode. The SAME artifact a daemon mounts at
 * GET /api/v1/node/activity is instantiated in the JS flow runtime host
 * (browser parity): a $HTQ HttpRequest enters the route_node_activity node,
 * the route -> node-activity activity -> http-respond chain runs
 * linked-direct inside the artifact's linear memory, and the ONLY host
 * crossing is the declared node_activity_read.activity hostcall — stubbed
 * here with the Go-host response dialect (same wire envelope shape
 * flows/node-status/tests/flow.test.mjs uses).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createFlowRuntimeHost } from "space-data-module-sdk/flow";
import { decodeHttpResponse, encodeHttpRequest } from "space-data-module-sdk/http";

const ACTIVITY_WASM = new URL("../dist/activity/runtime.wasm", import.meta.url);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ---------------------------------------------------------------------------
// Hostcall wire helpers (Go-host dialect: [u32le metaLen][meta JSON][u32le
// segCount]([u32le segLen][bytes])* — node_activity_read carries NO binary
// segments, so segCount is always 0 here).
// ---------------------------------------------------------------------------

function encodeHostcallEnvelope(meta) {
  const metaBytes = encoder.encode(JSON.stringify(meta));
  const total = 4 + metaBytes.length + 4;
  const envelope = new Uint8Array(total);
  const view = new DataView(envelope.buffer);
  view.setUint32(0, metaBytes.length, true);
  envelope.set(metaBytes, 4);
  view.setUint32(4 + metaBytes.length, 0, true);
  return envelope;
}

function decodeHostcallEnvelope(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const metaLen = view.getUint32(0, true);
  const meta = JSON.parse(decoder.decode(bytes.subarray(4, 4 + metaLen)));
  return { meta };
}

const ACTIVITY_RESULT = {
  count: 3,
  events: [
    { ts: "2026-07-11T00:00:09Z", kind: "grant_issued", peer_id: "16Uiu2HAmY", detail: "read grant issued" },
    { ts: "2026-07-11T00:00:05Z", kind: "peer_connected", peer_id: "16Uiu2HAmX", detail: "inbound stream opened" },
    { ts: "2026-07-11T00:00:01Z", kind: "record_stored", detail: "1 OMM record ingested" },
  ],
};

// ---------------------------------------------------------------------------
// Hostcall stub.
// ---------------------------------------------------------------------------

function createActivityStub({ result, fail } = {}) {
  const calls = [];
  const memoryRef = { memory: null };
  let response = new Uint8Array(0);

  const imports = {
    space_data_module_host: {
      call(opPtr, opLen, payloadPtr, payloadLen) {
        const heap = new Uint8Array(memoryRef.memory.buffer);
        const operation = decoder.decode(heap.subarray(opPtr, opPtr + opLen));
        const payload = Uint8Array.from(heap.subarray(payloadPtr, payloadPtr + payloadLen));
        const { meta: requestPayload } = decodeHostcallEnvelope(payload);
        calls.push({ operation, payload: requestPayload });

        if (operation === "node_activity_read.activity") {
          if (fail) {
            response = encodeHostcallEnvelope({ ok: false, error: { message: fail } });
            return 1;
          }
          response = encodeHostcallEnvelope({ ok: true, result });
          return 0;
        }
        response = encodeHostcallEnvelope({ ok: false, error: { message: `unexpected op ${operation}` } });
        return 1;
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

async function pumpRequest(stub, request) {
  const host = await createFlowRuntimeHost({
    wasmSource: new Uint8Array(fs.readFileSync(fileURLToPath(ACTIVITY_WASM))),
    extraImports: stub.imports,
  });
  stub.memoryRef.memory = host.memory;

  const responses = [];
  host.enqueueTriggerFrame(0, {
    portId: "request",
    bytes: encodeHttpRequest(request),
  });
  await host.drain(
    {
      "sdn.flow.egress:emit": ({ frames }) => {
        for (const frame of frames) {
          responses.push(decodeHttpResponse(frame.bytes));
        }
        return { statusCode: 0 };
      },
    },
    { maxIterations: 100 },
  );
  assert.equal(responses.length, 1, "expected exactly one $HTR frame");
  return responses[0];
}

function header(http, name) {
  for (const entry of http.headers ?? []) {
    if (entry.name === name) return entry.value;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

test("node activity: GET returns 200 with the hostcall result object verbatim as a bare JSON object", async () => {
  const stub = createActivityStub({ result: ACTIVITY_RESULT });
  const http = await pumpRequest(stub, { method: "GET", path: "/api/v1/node/activity", query: "" });
  assert.equal(http.status, 200);
  assert.equal(header(http, "content-type"), "application/json");
  assert.deepEqual(JSON.parse(decoder.decode(http.body)), ACTIVITY_RESULT);
  // Object-shaped body: the bare-array record-count header must not appear.
  assert.equal(header(http, "x-sdn-record-count"), undefined);

  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].operation, "node_activity_read.activity");
  assert.deepEqual(stub.calls[0].payload, { limit: 50 }, "the default clamped limit forwards as 50");
});

test("node activity: GET ?limit=5 forwards limit=5 to the hostcall", async () => {
  const stub = createActivityStub({ result: ACTIVITY_RESULT });
  const http = await pumpRequest(stub, { method: "GET", path: "/api/v1/node/activity", query: "limit=5" });
  assert.equal(http.status, 200);
  assert.equal(stub.calls.length, 1);
  assert.deepEqual(stub.calls[0].payload, { limit: 5 });
});

test("node activity: GET ?limit out of range clamps to [1, 256]", async () => {
  const stub = createActivityStub({ result: ACTIVITY_RESULT });
  const over = await pumpRequest(stub, { method: "GET", path: "/api/v1/node/activity", query: "limit=9000" });
  assert.equal(over.status, 200);
  assert.deepEqual(stub.calls.at(-1).payload, { limit: 256 });

  const under = await pumpRequest(stub, { method: "GET", path: "/api/v1/node/activity", query: "limit=0" });
  assert.equal(under.status, 200);
  assert.deepEqual(stub.calls.at(-1).payload, { limit: 1 });
});

test("node activity: HEAD is routed like GET (route=activity)", async () => {
  const stub = createActivityStub({ result: ACTIVITY_RESULT });
  const http = await pumpRequest(stub, { method: "HEAD", path: "/api/v1/node/activity", query: "" });
  assert.equal(http.status, 200);
  assert.equal(stub.calls.length, 1);
  assert.deepEqual(stub.calls[0].payload, { limit: 50 });
});

test("node activity: non-GET/HEAD methods answer 405 without reaching the host", async () => {
  const stub = createActivityStub({ result: ACTIVITY_RESULT });
  const http = await pumpRequest(stub, { method: "POST", path: "/api/v1/node/activity", query: "" });
  assert.equal(http.status, 405);
  assert.equal(header(http, "content-type"), "application/json");
  const body = JSON.parse(decoder.decode(http.body));
  assert.match(body.error, /POST/);
  assert.equal(stub.calls.length, 0, "non-GET/HEAD must never reach the host");
});

test("node activity: a node_activity_read.activity hostcall failure answers an honest 503", async () => {
  const stub = createActivityStub({ fail: "node activity log unavailable" });
  const http = await pumpRequest(stub, { method: "GET", path: "/api/v1/node/activity", query: "" });
  assert.equal(http.status, 503);
  assert.equal(header(http, "content-type"), "application/json");
  const body = JSON.parse(decoder.decode(http.body));
  assert.match(body.error, /unavailable/);
});

test("node activity bundle carries the api block for the OpenAPI generator", () => {
  const flow = JSON.parse(
    fs.readFileSync(fileURLToPath(new URL("../dist/activity/flow.json", import.meta.url)), "utf8"),
  );
  assert.equal(flow.api.basePath, "/api/v1/node/activity");
  assert.deepEqual(
    flow.api.routes.map((route) => [route.method, route.path, route.anonymous]),
    [["GET", "", false]],
  );
  assert.ok(flow.api.routes[0].responses["405"], "non-GET rejection documented");
  assert.ok(flow.api.routes[0].responses["503"], "hostcall-unavailable rejection documented");
  const limitParam = flow.api.routes[0].params?.find((param) => param.name === "limit");
  assert.ok(limitParam, "?limit query param documented");
  assert.equal(limitParam.in, "query");
  assert.equal(limitParam.schema.minimum, 1);
  assert.equal(limitParam.schema.maximum, 256);
  assert.equal(limitParam.schema.default, 50);
});

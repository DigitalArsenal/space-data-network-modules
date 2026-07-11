/*
 * Flow-level tests for the compiled node-status flow (M1 node-status flow) —
 * BRIDGE mode. The SAME artifact a daemon mounts at GET /api/v1/node/status
 * is instantiated in the JS flow runtime host (browser parity): a $HTQ
 * HttpRequest enters the route_node_status node, the route -> node-status
 * status -> http-respond chain runs linked-direct inside the artifact's
 * linear memory, and the ONLY host crossing is the declared
 * node_status_read.status hostcall — stubbed here with the Go-host response
 * dialect (same wire envelope shape flows/public-query/tests/flow.test.mjs
 * uses).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createFlowRuntimeHost } from "space-data-module-sdk/flow";
import { decodeHttpResponse, encodeHttpRequest } from "space-data-module-sdk/http";

const STATUS_WASM = new URL("../dist/status/runtime.wasm", import.meta.url);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ---------------------------------------------------------------------------
// Hostcall wire helpers (Go-host dialect: [u32le metaLen][meta JSON][u32le
// segCount]([u32le segLen][bytes])* — node_status_read carries NO binary
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

const STATUS_RESULT = {
  uptime_seconds: 98765,
  started_at: "2026-07-01T00:00:00Z",
  store: { total_bytes: 104857600, total_records: 4213, storage_path: "/var/lib/sdn/store" },
  disk: { capacity_bytes: 500000000000, free_bytes: 250000000000, available_bytes: 240000000000 },
  service: { state: "running", mode: "daemon", autostart_known: false },
  bandwidth: {
    total_in_bytes: 1024,
    total_out_bytes: 2048,
    rate_in_bps: 12.5,
    rate_out_bps: 25.0,
    history: [],
  },
};

// ---------------------------------------------------------------------------
// Hostcall stub.
// ---------------------------------------------------------------------------

function createStatusStub({ result, fail } = {}) {
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

        if (operation === "node_status_read.status") {
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
    wasmSource: new Uint8Array(fs.readFileSync(fileURLToPath(STATUS_WASM))),
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

test("node status: GET returns 200 with the hostcall result object verbatim as a bare JSON object", async () => {
  const stub = createStatusStub({ result: STATUS_RESULT });
  const http = await pumpRequest(stub, { method: "GET", path: "/api/v1/node/status", query: "" });
  assert.equal(http.status, 200);
  assert.equal(header(http, "content-type"), "application/json");
  assert.deepEqual(JSON.parse(decoder.decode(http.body)), STATUS_RESULT);
  // Object-shaped body: the bare-array record-count header must not appear.
  assert.equal(header(http, "x-sdn-record-count"), undefined);

  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].operation, "node_status_read.status");
  assert.deepEqual(stub.calls[0].payload, {}, "the hostcall input carries no fields");
});

test("node status: HEAD is routed like GET (route=status)", async () => {
  const stub = createStatusStub({ result: STATUS_RESULT });
  const http = await pumpRequest(stub, { method: "HEAD", path: "/api/v1/node/status", query: "" });
  assert.equal(http.status, 200);
  assert.equal(stub.calls.length, 1);
});

test("node status: non-GET/HEAD methods answer 405 without reaching the host", async () => {
  const stub = createStatusStub({ result: STATUS_RESULT });
  const http = await pumpRequest(stub, { method: "POST", path: "/api/v1/node/status", query: "" });
  assert.equal(http.status, 405);
  assert.equal(header(http, "content-type"), "application/json");
  const body = JSON.parse(decoder.decode(http.body));
  assert.match(body.error, /POST/);
  assert.equal(stub.calls.length, 0, "non-GET/HEAD must never reach the host");
});

test("node status: a node_status_read.status hostcall failure answers an honest 503", async () => {
  const stub = createStatusStub({ fail: "node status snapshot unavailable" });
  const http = await pumpRequest(stub, { method: "GET", path: "/api/v1/node/status", query: "" });
  assert.equal(http.status, 503);
  assert.equal(header(http, "content-type"), "application/json");
  const body = JSON.parse(decoder.decode(http.body));
  assert.match(body.error, /unavailable/);
});

test("node status bundle carries the api block for the OpenAPI generator", () => {
  const flow = JSON.parse(
    fs.readFileSync(fileURLToPath(new URL("../dist/status/flow.json", import.meta.url)), "utf8"),
  );
  assert.equal(flow.api.basePath, "/api/v1/node/status");
  assert.deepEqual(
    flow.api.routes.map((route) => [route.method, route.path, route.anonymous]),
    [["GET", "", false]],
  );
  assert.ok(flow.api.routes[0].responses["405"], "non-GET rejection documented");
  assert.ok(flow.api.routes[0].responses["503"], "hostcall-unavailable rejection documented");
});

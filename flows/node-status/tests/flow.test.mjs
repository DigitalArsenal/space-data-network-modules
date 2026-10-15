/*
 * Flow-level tests for the compiled node-status flow (typed contracts 1.0). The SAME artifact a daemon mounts at
 * GET /api/v1/node/status is instantiated in the JS flow runtime host: a $HTQ enters route_node_status, the $APR
 * decision and the $NHS answer travel route -> node-status -> http-respond linked-direct inside the artifact, and the
 * only host crossings are the node's typed $PIV hostcalls (node_status_read.status, node.peerId, clock.now), answered
 * here on the wire the way a typed host answers them.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createFlowRuntimeHost } from "space-data-module-sdk/flow";
import { decodeHttpResponse, encodeHttpRequest } from "space-data-module-sdk/http";
import { decodeHostCall, encodeHostCallResult } from "space-data-module-sdk/runtime-contracts";

const FLOW_WASM = new URL("../dist/status/runtime.wasm", import.meta.url);
const STANDARDS_ROOT = process.env.SPACE_DATA_STANDARDS_ROOT ?? fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));

async function loadStandard(code) {
  const esbuild = await import(pathToFileURL(path.join(STANDARDS_ROOT, "node_modules", "esbuild", "lib", "main.js")).href);
  const flatbuffersEntry = fs.realpathSync(path.join(STANDARDS_ROOT, "node_modules", "flatbuffers", "mjs", "flatbuffers.js"));
  const out = await esbuild.build({ entryPoints: [path.join(STANDARDS_ROOT, "lib", "ts", code, "main.ts")], bundle: true, format: "esm", write: false, platform: "neutral", alias: { flatbuffers: flatbuffersEntry }, logLevel: "silent" });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
}
const flatbuffers = await import(pathToFileURL(fs.realpathSync(path.join(STANDARDS_ROOT, "node_modules", "flatbuffers", "mjs", "flatbuffers.js"))).href);
const { NHS, nhsServiceState } = await loadStandard("NHS");
const { APR } = await loadStandard("APR");

const NOW_MS = 1791900000123n;
const REPORT = {
  UPTIME_S: 98765n, STARTED_MS: 1791801235000n, STORE_TOTAL_BYTES: 104857600n, STORE_TOTAL_RECORDS: 4213n, STORAGE_PATH: "/var/lib/sdn/store",
  HAS_DISK: true, DISK_CAPACITY_BYTES: 500000000000n, DISK_FREE_BYTES: 250000000000n, DISK_AVAILABLE_BYTES: 240000000000n,
  SERVICE_STATE: "running", SERVICE_MODE: "daemon", HAS_BANDWIDTH: true, TOTAL_IN_BYTES: 1024n, TOTAL_OUT_BYTES: 2048n, RATE_IN_BPS: 12.5, RATE_OUT_BPS: 25,
};
const HISTORY = [{ TS_MS: 1791899990000n, TOTAL_IN_BYTES: 1000n, TOTAL_OUT_BYTES: 2000n, RATE_IN_BPS: 10, RATE_OUT_BPS: 20 }];

// A typed host on the wire: each $PIV call is decoded and answered with a $PIV response.
function typedHost({ fail } = {}) {
  const calls = [];
  const memoryRef = { memory: null };
  let response = new Uint8Array(0);
  const answer = (call) => {
    if (call.op === "node_status_read.status") {
      if (fail) throw Object.assign(new Error(fail), { code: "failed" });
      return { result: REPORT, lists: { bandwidth_history: HISTORY } };
    }
    if (call.op === "node.peerId") return { raw: { value: "16Uiu2HAmSelfNode" } };
    if (call.op === "clock.now") return { result: { UNIX_MS: NOW_MS } };
    throw Object.assign(new Error(`unexpected op ${call.op}`), { code: "unsupported" });
  };
  const imports = {
    space_data_module_host: {
      call(opPtr, opLen, ptr, len) {
        const call = decodeHostCall(new Uint8Array(memoryRef.memory.buffer).slice(ptr, ptr + len));
        calls.push(call);
        let out;
        try { out = { ok: true, op: call.op, ...answer(call) }; } catch (error) { out = { ok: false, error: { code: error.code, message: error.message } }; }
        response = encodeHostCallResult(out);
        return 0;
      },
      response_len: () => response.length,
      read_response(dst, len) {
        const n = Math.min(len, response.length);
        new Uint8Array(memoryRef.memory.buffer).set(response.subarray(0, n), dst);
        return n;
      },
    },
  };
  return { calls, imports, memoryRef };
}

async function serve(host, request) {
  const runtime = await createFlowRuntimeHost({ wasmSource: new Uint8Array(fs.readFileSync(fileURLToPath(FLOW_WASM))), extraImports: host.imports, runtimeTarget: "wasmedge" });
  host.memoryRef.memory = runtime.memory;
  const responses = [];
  runtime.enqueueTriggerFrame(0, { portId: "request", bytes: encodeHttpRequest(request) });
  await runtime.drain({ "sdn.flow.egress:emit": ({ frames }) => { for (const f of frames) responses.push(decodeHttpResponse(f.bytes)); return { statusCode: 0 }; } }, { maxIterations: 100 });
  assert.equal(responses.length, 1, "exactly one $HTR");
  const [http] = responses;
  http.header = (name) => http.headers.find((h) => h.name === name)?.value;
  http.json = () => JSON.parse(new TextDecoder().decode(http.body));
  return http;
}

test("GET answers the node's $NHS verbatim as FlatBuffers", async () => {
  const host = typedHost();
  const http = await serve(host, { method: "GET", path: "/api/v1/node/status" });
  assert.equal(http.status, 200);
  assert.equal(http.header("content-type"), "application/x-flatbuffers");
  assert.equal(http.header("x-sdn-file-identifier"), "$NHS");
  const bb = new flatbuffers.ByteBuffer(http.body);
  assert.ok(NHS.bufferHasIdentifier(bb));
  const nhs = NHS.getRootAsNHS(bb).unpack();
  assert.equal(nhs.NODE_ID, "16Uiu2HAmSelfNode");
  assert.equal(BigInt(nhs.GENERATED_AT_MS), NOW_MS);
  assert.equal(nhs.SERVICE_STATE, nhsServiceState.Running);
  assert.deepEqual([BigInt(nhs.UPTIME_S), BigInt(nhs.STARTED_AT_MS), nhs.STORAGE_PATH, BigInt(nhs.DISK_FREE_BYTES), nhs.HAS_NETWORK, nhs.RATE_OUT_BPS], [98765n, 1791801235000n, "/var/lib/sdn/store", 250000000000n, true, 25]);
  assert.equal(nhs.THROUGHPUT_HISTORY.length, 1);
  assert.deepEqual(host.calls.map((c) => c.op).sort(), ["clock.now", "node.peerId", "node_status_read.status"]);
});

test("?format=json (or Accept: application/json) renders the same $NHS with its IDL field names", async () => {
  const http = await serve(typedHost(), { method: "GET", path: "/api/v1/node/status", query: "format=json" });
  assert.equal(http.header("content-type"), "application/json");
  const body = http.json();
  assert.deepEqual([body.NODE_ID, body.SERVICE_STATE, body.UPTIME_S, body.STORE_TOTAL_RECORDS, body.HAS_DISK, body.RATE_IN_BPS], ["16Uiu2HAmSelfNode", "Running", 98765, 4213, true, 12.5]);
  assert.deepEqual(body.THROUGHPUT_HISTORY, [{ TIME_MS: 1791899990000, TOTAL_IN_BYTES: 1000, TOTAL_OUT_BYTES: 2000, RATE_IN_BPS: 10, RATE_OUT_BPS: 20 }]);
  const byAccept = await serve(typedHost(), { method: "HEAD", path: "/api/v1/node/status", headers: { Accept: "application/json" } });
  assert.deepEqual([byAccept.status, byAccept.header("content-type")], [200, "application/json"]);
});

test("a non-GET method answers 405 without reaching the host", async () => {
  const host = typedHost();
  const http = await serve(host, { method: "POST", path: "/api/v1/node/status", query: "format=json" });
  assert.equal(http.status, 405);
  assert.deepEqual(http.json(), { error: "no POST route for node status (GET only)", code: "method-not-allowed" });
  assert.equal(host.calls.length, 0);
  const fb = await serve(typedHost(), { method: "DELETE", path: "/api/v1/node/status" });
  assert.equal(fb.status, 405);
  assert.equal(APR.getRootAsAPR(new flatbuffers.ByteBuffer(fb.body)).ERROR_CODE(), "method-not-allowed", "the refusal record itself, as FlatBuffers");
});

test("a node_status_read failure answers an honest 503", async () => {
  const http = await serve(typedHost({ fail: "node status snapshot unavailable" }), { method: "GET", path: "/api/v1/node/status", query: "format=json" });
  assert.equal(http.status, 503);
  assert.equal(http.json().code, "status-unavailable");
  assert.match(http.json().error, /unavailable/);
});

test("the bundle carries the api block for the OpenAPI generator", () => {
  const flow = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../dist/status/flow.json", import.meta.url)), "utf8"));
  assert.equal(flow.api.basePath, "/api/v1/node/status");
  assert.deepEqual(flow.api.routes.map((r) => [r.method, r.path, r.anonymous]), [["GET", "", false]]);
  assert.deepEqual(Object.keys(flow.api.routes[0].responses["200"].content).sort(), ["application/json", "application/x-flatbuffers"]);
  assert.ok(flow.api.routes[0].responses["405"] && flow.api.routes[0].responses["503"]);
});

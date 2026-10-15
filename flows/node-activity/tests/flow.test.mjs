/*
 * Flow-level tests for the compiled node-activity flow (typed contracts 1.0). The SAME artifact a daemon mounts at
 * GET /api/v1/node/activity is instantiated in the JS flow runtime host: a $HTQ enters route_node_activity, the $APR
 * decision and the $NEV answer travel route -> node-activity -> http-respond linked-direct inside the artifact, and the
 * only host crossings are the node's typed $PIV hostcalls (node_activity_read.activity, node.peerId, clock.now), answered
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

const FLOW_WASM = new URL("../dist/activity/runtime.wasm", import.meta.url);
const STANDARDS_ROOT = process.env.SPACE_DATA_STANDARDS_ROOT ?? fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));

async function loadStandard(code) {
  const esbuild = await import(pathToFileURL(path.join(STANDARDS_ROOT, "node_modules", "esbuild", "lib", "main.js")).href);
  const flatbuffersEntry = fs.realpathSync(path.join(STANDARDS_ROOT, "node_modules", "flatbuffers", "mjs", "flatbuffers.js"));
  const out = await esbuild.build({ entryPoints: [path.join(STANDARDS_ROOT, "lib", "ts", code, "main.ts")], bundle: true, format: "esm", write: false, platform: "neutral", alias: { flatbuffers: flatbuffersEntry }, logLevel: "silent" });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
}
const flatbuffers = await import(pathToFileURL(fs.realpathSync(path.join(STANDARDS_ROOT, "node_modules", "flatbuffers", "mjs", "flatbuffers.js"))).href);
const { NEV, nevEventKind } = await loadStandard("NEV");
const { APR } = await loadStandard("APR");

const NOW_MS = 1791900000123n;
// The host's activity log, newest first (node_activity_read.activity: list "events" of NodeActivityEvent).
const EVENTS = [
  { TS_MS: 1783728009000n, KIND: "grant_issued", PEER_ID: "16Uiu2HAmY", DETAIL: "read grant issued" },
  { TS_MS: 1783728005000n, KIND: "peer_connected", PEER_ID: "16Uiu2HAmX", DETAIL: "inbound stream opened" },
  { TS_MS: 1783728003000n, KIND: "pnm_publication", PEER_ID: "", DETAIL: "OMM batch announced" },
  { TS_MS: 1783728002000n, KIND: "peer_disconnected", PEER_ID: "16Uiu2HAmX", DETAIL: "stream closed" },
  { TS_MS: 1783728001000n, KIND: "record_stored", PEER_ID: "", DETAIL: "1 OMM record ingested" },
  { TS_MS: 1783728000000n, KIND: "relay_reserved", PEER_ID: "16Uiu2HAmZ", DETAIL: "circuit relay slot" },
];

// A typed host on the wire: each $PIV call is decoded and answered with a $PIV response.
function typedHost({ fail } = {}) {
  const calls = [];
  const memoryRef = { memory: null };
  let response = new Uint8Array(0);
  const answer = (call) => {
    if (call.op === "node_activity_read.activity") {
      if (fail) throw Object.assign(new Error(fail), { code: "failed" });
      return { lists: { events: EVENTS.slice(0, call.params?.LIMIT || 50) } };
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

test("GET answers the node's $NEV (newest first, the host's kinds mapped) as FlatBuffers", async () => {
  const host = typedHost();
  const http = await serve(host, { method: "GET", path: "/api/v1/node/activity" });
  assert.equal(http.status, 200);
  assert.deepEqual([http.header("content-type"), http.header("x-sdn-file-identifier")], ["application/x-flatbuffers", "$NEV"]);
  const bb = new flatbuffers.ByteBuffer(http.body);
  assert.ok(NEV.bufferHasIdentifier(bb));
  const nev = NEV.getRootAsNEV(bb).unpack();
  assert.equal(nev.NODE_ID, "16Uiu2HAmSelfNode");
  assert.equal(BigInt(nev.GENERATED_AT_MS), NOW_MS);
  assert.deepEqual(nev.EVENTS.map((e) => e.KIND), [nevEventKind.GrantIssued, nevEventKind.PeerConnected, nevEventKind.PublicationSent, nevEventKind.PeerDisconnected, nevEventKind.RecordsStored, nevEventKind.Other]);
  assert.deepEqual([BigInt(nev.EVENTS[1].TIME_MS), nev.EVENTS[1].PEER_ID, nev.EVENTS[1].DETAIL], [1783728005000n, "16Uiu2HAmX", "inbound stream opened"]);
  assert.match(nev.EVENTS[5].DETAIL, /relay_reserved/, "an unknown kind keeps its name in DETAIL");
  const call = host.calls.find((c) => c.op === "node_activity_read.activity");
  assert.equal(call.params.LIMIT, 50, "the default limit");
});

test("?limit is clamped in-wasm and reaches the host as NodeActivityParams.LIMIT; JSON on request", async () => {
  const host = typedHost();
  const http = await serve(host, { method: "GET", path: "/api/v1/node/activity", query: "limit=2&format=json" });
  assert.equal(host.calls.find((c) => c.op === "node_activity_read.activity").params.LIMIT, 2);
  const body = http.json();
  assert.equal(http.header("content-type"), "application/json");
  assert.deepEqual(body.EVENTS.map((e) => [e.KIND, e.PEER_ID, e.DETAIL]), [["GrantIssued", "16Uiu2HAmY", "read grant issued"], ["PeerConnected", "16Uiu2HAmX", "inbound stream opened"]]);
  assert.equal(body.NODE_ID, "16Uiu2HAmSelfNode");
  for (const [query, limit] of [["limit=9999", 256], ["limit=0", 1], ["limit=12abc", 50]]) {
    const h = typedHost();
    await serve(h, { method: "GET", path: "/api/v1/node/activity", query });
    assert.equal(h.calls.find((c) => c.op === "node_activity_read.activity").params.LIMIT, limit, query);
  }
});

test("a non-GET method answers 405 without reaching the host", async () => {
  const host = typedHost();
  const http = await serve(host, { method: "PUT", path: "/api/v1/node/activity", query: "format=json" });
  assert.equal(http.status, 405);
  assert.deepEqual(http.json(), { error: "no PUT route for node activity (GET only)", code: "method-not-allowed" });
  assert.equal(host.calls.length, 0);
});

test("a node_activity_read failure answers an honest 503", async () => {
  const http = await serve(typedHost({ fail: "activity log unavailable" }), { method: "GET", path: "/api/v1/node/activity", query: "format=json" });
  assert.equal(http.status, 503);
  assert.deepEqual([http.json().code, http.json().error], ["activity-unavailable", "activity log unavailable"]);
});

test("the bundle carries the api block for the OpenAPI generator", () => {
  const flow = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../dist/activity/flow.json", import.meta.url)), "utf8"));
  assert.equal(flow.api.basePath, "/api/v1/node/activity");
  assert.deepEqual(flow.api.routes.map((r) => [r.method, r.path, r.anonymous]), [["GET", "", false]]);
  assert.deepEqual(Object.keys(flow.api.routes[0].responses["200"].content).sort(), ["application/json", "application/x-flatbuffers"]);
  assert.ok(flow.api.routes[0].responses["405"] && flow.api.routes[0].responses["503"]);
});

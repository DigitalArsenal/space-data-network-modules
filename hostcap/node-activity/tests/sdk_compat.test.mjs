import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

// hostcap/node-activity on the typed contracts (1.0): one $APR in, the $APR + one $NEV out, the host reads SDS $PIV
// hostcalls, answered through the SDK harness (its typed adapters carry list "events" and raw "value").
const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT = process.env.SPACE_DATA_STANDARDS_ROOT ?? fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));

const readManifest = () => JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
const readWasm = () => fs.readFileSync(fileURLToPath(WASM_PATH));

// The standards' own generated TypeScript bindings, bundled with the standards repo's esbuild.
const FLATBUFFERS_PATH = fs.realpathSync(path.join(STANDARDS_ROOT, "node_modules", "flatbuffers", "mjs", "flatbuffers.js"));
const flatbuffers = await import(pathToFileURL(FLATBUFFERS_PATH).href);
async function loadStandard(code) {
  const esbuild = await import(pathToFileURL(path.join(STANDARDS_ROOT, "node_modules", "esbuild", "lib", "main.js")).href);
  const out = await esbuild.build({ entryPoints: [path.join(STANDARDS_ROOT, "lib", "ts", code, "main.ts")], bundle: true, format: "esm", write: false, platform: "neutral", alias: { flatbuffers: FLATBUFFERS_PATH }, logLevel: "silent" });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
}
const aprLib = await loadStandard("APR");
const nevLib = await loadStandard("NEV");

const APR_TYPE = { schemaName: "APR.fbs", fileIdentifier: "$APR", rootTypeName: "APR", wireFormat: "flatbuffer" };
function encodeApr(fields) {
  const apr = Object.assign(new aprLib.APRT(), fields);
  if (fields.PARAMETERS) apr.PARAMETERS = fields.PARAMETERS.map(([NAME, VALUE]) => Object.assign(new aprLib.APRParameterT(), { NAME, VALUE }));
  const b = new flatbuffers.Builder(256);
  b.finish(apr.pack(b), "$APR");
  return b.asUint8Array();
}
const decodeApr = (bytes) => {
  const bb = new flatbuffers.ByteBuffer(bytes);
  assert.ok(aprLib.APR.bufferHasIdentifier(bb), "the decision is an $APR");
  return aprLib.APR.getRootAsAPR(bb).unpack();
};
const decodeNev = (bytes) => {
  const bb = new flatbuffers.ByteBuffer(bytes);
  assert.ok(nevLib.NEV.bufferHasIdentifier(bb), "the body is an $NEV");
  return nevLib.NEV.getRootAsNEV(bb).unpack();
};
const decision = (fields) => ({ portId: "decision", typeRef: APR_TYPE, payload: encodeApr(fields) });
const GET_ACTIVITY = (limit) => ({ METHOD: aprLib.aprMethod.GET, PATH: "/api/v1/node/activity", ROUTE: "activity", ...(limit === undefined ? {} : { PARAMETERS: [["limit", limit]] }) });

const EVENTS = [
  { TS_MS: 1782950409000n, KIND: "grant_issued", PEER_ID: "16Uiu2HAmY", DETAIL: "read grant issued" },
  { TS_MS: 1782950405000n, KIND: "peer_connected", PEER_ID: "16Uiu2HAmX", DETAIL: "inbound stream opened" },
  { TS_MS: 1782950404000n, KIND: "peer_disconnected", PEER_ID: "16Uiu2HAmW", DETAIL: "stream closed" },
  { TS_MS: 1782950403000n, KIND: "pnm_publication", PEER_ID: "", DETAIL: "OMM.fbs published" },
  { TS_MS: 1782950401000n, KIND: "record_stored", PEER_ID: "", DETAIL: "1 OMM record ingested" },
  { TS_MS: 1782950400500n, KIND: "quota_warning", PEER_ID: "", DETAIL: "store 92% full" },
];
const NOW_MS = 1782950400123n;
const PEER_ID = "12D3KooWNodeActivitySelf";

// The host: the SDK harness's hostcallDispatch, answering each op in the Go node's handler shape (the SDK's typed
// adapters turn it into list "events", node.peerId's raw "value", clock.now's TimeValue). The handler sees the module's
// LIMIT as `limit`. `fail` names ops that throw ({ code, message } -> STATUS FAILED with that code).
function hostStub({ fail = {} } = {}) {
  const calls = [];
  const dispatch = (op, params) => {
    calls.push({ op, params });
    if (fail[op]) throw Object.assign(new Error(fail[op].message), { hostcallCode: fail[op].code });
    if (op === "node_activity_read.activity") {
      return { events: EVENTS.slice(0, params.limit).map((e) => ({ ts: Number(e.TS_MS), kind: e.KIND, detail: e.DETAIL, peer_id: e.PEER_ID })) };
    }
    if (op === "node.peerId") return PEER_ID;
    if (op === "clock.now") return Number(NOW_MS);
    throw Object.assign(new Error(`unexpected hostcall ${op}`), { hostcallCode: "unsupported" });
  };
  return { calls, dispatch };
}
async function harnessFor(t, stub) {
  const harness = await createBrowserModuleHarness({ wasmSource: readWasm(), manifest: readManifest(), surface: "direct", hostcallDispatch: stub.dispatch });
  t.after(() => harness.destroy());
  return harness;
}
const outputsOf = (result) => {
  assert.equal(result.statusCode, 0, result.errorMessage);
  return Object.fromEntries(result.outputs.map((frame) => [frame.portId, frame.payload]));
};

test("hostcap/node-activity passes SDK compliance with typed ports", async () => {
  const report = await validateArtifactWithStandards({ manifest: readManifest(), wasmPath: fileURLToPath(WASM_PATH), standardsRoot: STANDARDS_ROOT });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
  const [method] = readManifest().methods;
  const ids = {};
  for (const port of [...method.inputPorts, ...method.outputPorts]) {
    assert.equal(port.acceptedTypeSets.length, 1, port.portId);
    assert.equal(port.acceptedTypeSets[0].allowedTypes.length, 1, port.portId);
    const [type] = port.acceptedTypeSets[0].allowedTypes;
    assert.equal(type.acceptsAnyFlatbuffer, undefined, port.portId);
    assert.equal(type.wireFormat, "flatbuffer", port.portId);
    ids[`${method.inputPorts.includes(port) ? "in" : "out"}.${port.portId}`] = type.fileIdentifier;
  }
  assert.deepEqual(ids, { "in.decision": "$APR", "out.decision": "$APR", "out.activity": "$NEV" });
});

test("hostcap/node-activity imports only WASI and the sync hostcall bridge", async () => {
  const inspection = await inspectModule(readWasm());
  assert.equal(inspection.profile, "module-host-abi");
  assert.deepEqual(Array.from(new Set(inspection.imports.map((e) => e.module))).sort(), ["space_data_module_host", "wasi_snapshot_preview1"]);
});

test("an \"activity\" decision reads node_activity_read.activity and emits the $NEV beside the $APR verbatim", async (t) => {
  const stub = hostStub();
  const harness = await harnessFor(t, stub);
  const input = decision(GET_ACTIVITY("10"));
  const out = outputsOf(await harness.invoke({ methodId: "activity", inputs: [input] }));
  assert.deepEqual(out.decision, input.payload, "the decision passes through verbatim");
  const nev = decodeNev(out.activity);
  assert.equal(nev.NODE_ID, PEER_ID);
  assert.equal(nev.GENERATED_AT_MS, NOW_MS);
  assert.equal(nev.TOTAL_EVENTS, 0n, "the host does not report its total: unknown, never a guess");
  const K = nevLib.nevEventKind;
  assert.deepEqual(nev.EVENTS.map((e) => [e.TIME_MS, e.KIND, e.PEER_ID, e.DETAIL]), [
    [1782950409000n, K.GrantIssued, "16Uiu2HAmY", "read grant issued"],
    [1782950405000n, K.PeerConnected, "16Uiu2HAmX", "inbound stream opened"],
    [1782950404000n, K.PeerDisconnected, "16Uiu2HAmW", "stream closed"],
    [1782950403000n, K.PublicationSent, null, "OMM.fbs published"],
    [1782950401000n, K.RecordsStored, null, "1 OMM record ingested"],
    [1782950400500n, K.Other, null, "quota_warning: store 92% full"],
  ], "newest first, kinds mapped, no PEER_ID when the event concerns none, an unknown kind kept in DETAIL");
  assert.deepEqual(stub.calls.map((c) => c.op), ["node_activity_read.activity", "node.peerId", "clock.now"]);
  assert.equal(stub.calls[0].params.limit, 10);
});

test("the limit is re-clamped to [1, 256] with default 50; garbage falls back to the default", async (t) => {
  const stub = hostStub();
  const harness = await harnessFor(t, stub);
  for (const limit of [undefined, "0", "-5", "999", "12abc", "256", "1"]) {
    outputsOf(await harness.invoke({ methodId: "activity", inputs: [decision(GET_ACTIVITY(limit))] }));
  }
  assert.deepEqual(stub.calls.filter((c) => c.op === "node_activity_read.activity").map((c) => c.params.limit), [50, 1, 1, 256, 50, 256, 1]);
});

test("a refused decision passes through untouched with no hostcall; a route not owned answers 404", async (t) => {
  const stub = hostStub();
  const harness = await harnessFor(t, stub);
  const refused = decision({ METHOD: aprLib.aprMethod.DELETE, PATH: "/api/v1/node/activity", STATUS: 405, ERROR_CODE: "method-not-allowed", ERROR_MESSAGE: "no DELETE route for node activity (GET only)" });
  const passed = outputsOf(await harness.invoke({ methodId: "activity", inputs: [refused] }));
  assert.deepEqual(Object.keys(passed), ["decision"], "no body beside a refusal");
  assert.deepEqual(passed.decision, refused.payload);

  const other = outputsOf(await harness.invoke({ methodId: "activity", inputs: [decision({ ...GET_ACTIVITY(), ROUTE: "status" })] }));
  assert.deepEqual(Object.keys(other), ["decision"]);
  const apr = decodeApr(other.decision);
  assert.deepEqual([apr.STATUS, apr.ERROR_CODE, apr.ROUTE, apr.PATH], [404, "no-route", "status", "/api/v1/node/activity"]);
  assert.equal(stub.calls.length, 0, "neither reached the host");
});

test("a node_activity_read.activity failure answers the $APR with STATUS 503 and the host message, no body", async (t) => {
  const stub = hostStub({ fail: { "node_activity_read.activity": { code: "not-authorized", message: "node_activity_read not granted" } } });
  const out = outputsOf(await (await harnessFor(t, stub)).invoke({ methodId: "activity", inputs: [decision(GET_ACTIVITY("5"))] }));
  assert.deepEqual(Object.keys(out), ["decision"]);
  const apr = decodeApr(out.decision);
  assert.deepEqual([apr.STATUS, apr.ERROR_CODE, apr.ERROR_MESSAGE, apr.ROUTE], [503, "activity-unavailable", "node_activity_read not granted", "activity"]);
  assert.deepEqual(apr.PARAMETERS.map((p) => [p.NAME, p.VALUE]), [["limit", "5"]]);
});

test("an unavailable host clock leaves GENERATED_AT_MS 0 and still serves the log", async (t) => {
  const stub = hostStub({ fail: { "clock.now": { code: "not-authorized", message: "clock not granted" } } });
  const out = outputsOf(await (await harnessFor(t, stub)).invoke({ methodId: "activity", inputs: [decision(GET_ACTIVITY())] }));
  const nev = decodeNev(out.activity);
  assert.equal(nev.GENERATED_AT_MS, 0n);
  assert.equal(nev.EVENTS.length, EVENTS.length);
});

test("a frame that is not an $APR is refused", async (t) => {
  const harness = await harnessFor(t, hostStub());
  const result = await harness.invoke({ methodId: "activity", inputs: [{ portId: "decision", typeRef: APR_TYPE, payload: new TextEncoder().encode("{\"route\":\"activity\",\"limit\":50}") }] });
  assert.notEqual(result.statusCode, 0);
  assert.equal(result.errorCode, "invalid-decision-frame");
});

// The compiled flow runtime drains a node's queue port-blind (maxStreams is declarative only), so a surplus frame on
// the single-stream port is refused by name rather than silently destroyed (graph: modules-guest-nodes-drop-batched-frames).
test("surplus decision frames are refused, never dropped", async (t) => {
  const stub = hostStub();
  const result = await (await harnessFor(t, stub)).invoke({ methodId: "activity", inputs: [decision(GET_ACTIVITY()), decision(GET_ACTIVITY())] });
  assert.equal(result.errorCode, "batched-input-frames");
  assert.match(result.errorMessage, /2 frames on single-stream input port "decision"/);
  assert.equal(result.outputs.length, 0);
  assert.equal(stub.calls.length, 0);
});

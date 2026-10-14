import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

// hostcap/node-status on the typed contracts (1.0): one $APR in, the $APR + one $NHS out, the host reads SDS $PIV
// hostcalls, answered through the SDK harness (its typed adapters carry list "bandwidth_history" and raw "value").
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
const nhsLib = await loadStandard("NHS");

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
const decodeNhs = (bytes) => {
  const bb = new flatbuffers.ByteBuffer(bytes);
  assert.ok(nhsLib.NHS.bufferHasIdentifier(bb), "the body is an $NHS");
  return nhsLib.NHS.getRootAsNHS(bb).unpack();
};
const decision = (fields) => ({ portId: "decision", typeRef: APR_TYPE, payload: encodeApr(fields) });
const GET_STATUS = { METHOD: aprLib.aprMethod.GET, PATH: "/api/v1/node/status", ROUTE: "status" };

const REPORT = {
  UPTIME_S: 98765n, STARTED_MS: 1782864000000n, STORE_TOTAL_BYTES: 104857600n, STORE_TOTAL_RECORDS: 4213n, STORAGE_PATH: "/var/lib/sdn/store",
  HAS_DISK: true, DISK_CAPACITY_BYTES: 500000000000n, DISK_FREE_BYTES: 250000000000n, DISK_AVAILABLE_BYTES: 240000000000n,
  SERVICE_STATE: "Running", SERVICE_MODE: "daemon", HAS_BANDWIDTH: true, TOTAL_IN_BYTES: 1024n, TOTAL_OUT_BYTES: 2048n, RATE_IN_BPS: 12.5, RATE_OUT_BPS: 25,
};
const SAMPLES = [
  { TS_MS: 1782950000000n, TOTAL_IN_BYTES: 512n, TOTAL_OUT_BYTES: 1024n, RATE_IN_BPS: 10, RATE_OUT_BPS: 20 },
  { TS_MS: 1782950060000n, TOTAL_IN_BYTES: 1024n, TOTAL_OUT_BYTES: 2048n, RATE_IN_BPS: 12.5, RATE_OUT_BPS: 25 },
];
const NOW_MS = 1782950400123n;
const PEER_ID = "12D3KooWNodeStatusSelf";

// The host: the SDK harness's hostcallDispatch, answering each op in the Go node's handler shape (the SDK's typed
// adapters turn it into the NodeStatusReport record + list "bandwidth_history", node.peerId's raw "value", clock.now's
// TimeValue). `fail` names ops that throw ({ code, message } -> STATUS FAILED with that code).
const HANDLER_REPORT = {
  uptime_seconds: Number(REPORT.UPTIME_S), started_at: Number(REPORT.STARTED_MS),
  store: { total_bytes: Number(REPORT.STORE_TOTAL_BYTES), total_records: Number(REPORT.STORE_TOTAL_RECORDS), storage_path: REPORT.STORAGE_PATH },
  disk: { capacity_bytes: Number(REPORT.DISK_CAPACITY_BYTES), free_bytes: Number(REPORT.DISK_FREE_BYTES), available_bytes: Number(REPORT.DISK_AVAILABLE_BYTES) },
  service: { state: REPORT.SERVICE_STATE, mode: REPORT.SERVICE_MODE },
  bandwidth: {
    total_in_bytes: Number(REPORT.TOTAL_IN_BYTES), total_out_bytes: Number(REPORT.TOTAL_OUT_BYTES), rate_in_bps: REPORT.RATE_IN_BPS, rate_out_bps: REPORT.RATE_OUT_BPS,
    history: SAMPLES.map((s) => ({ ts: Number(s.TS_MS), total_in_bytes: Number(s.TOTAL_IN_BYTES), total_out_bytes: Number(s.TOTAL_OUT_BYTES), rate_in_bps: s.RATE_IN_BPS, rate_out_bps: s.RATE_OUT_BPS })),
  },
};
function hostStub({ fail = {} } = {}) {
  const calls = [];
  const dispatch = (op, params) => {
    calls.push({ op, params });
    if (fail[op]) throw Object.assign(new Error(fail[op].message), { hostcallCode: fail[op].code });
    if (op === "node_status_read.status") return HANDLER_REPORT;
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

test("hostcap/node-status passes SDK compliance with typed ports", async () => {
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
  assert.deepEqual(ids, { "in.decision": "$APR", "out.decision": "$APR", "out.status": "$NHS" });
});

test("hostcap/node-status imports only WASI and the sync hostcall bridge", async () => {
  const inspection = await inspectModule(readWasm());
  assert.equal(inspection.profile, "module-host-abi");
  assert.deepEqual(Array.from(new Set(inspection.imports.map((e) => e.module))).sort(), ["space_data_module_host", "wasi_snapshot_preview1"]);
});

test("a \"status\" decision reads node_status_read.status and emits the $NHS beside the $APR verbatim", async (t) => {
  const stub = hostStub();
  const harness = await harnessFor(t, stub);
  const input = decision(GET_STATUS);
  const out = outputsOf(await harness.invoke({ methodId: "status", inputs: [input] }));
  assert.deepEqual(out.decision, input.payload, "the decision passes through verbatim");
  const nhs = decodeNhs(out.status);
  assert.equal(nhs.NODE_ID, PEER_ID);
  assert.equal(nhs.GENERATED_AT_MS, NOW_MS);
  assert.equal(nhs.STARTED_AT_MS, REPORT.STARTED_MS);
  assert.equal(nhs.UPTIME_S, REPORT.UPTIME_S);
  assert.equal(nhs.SERVICE_STATE, nhsLib.nhsServiceState.Running, "the state string maps case-insensitively");
  assert.equal(nhs.SERVICE_MODE, "daemon");
  assert.equal(nhs.STORAGE_PATH, REPORT.STORAGE_PATH);
  assert.deepEqual([nhs.STORE_TOTAL_RECORDS, nhs.STORE_TOTAL_BYTES], [REPORT.STORE_TOTAL_RECORDS, REPORT.STORE_TOTAL_BYTES]);
  assert.deepEqual([nhs.HAS_DISK, nhs.DISK_CAPACITY_BYTES, nhs.DISK_FREE_BYTES, nhs.DISK_AVAILABLE_BYTES], [true, REPORT.DISK_CAPACITY_BYTES, REPORT.DISK_FREE_BYTES, REPORT.DISK_AVAILABLE_BYTES]);
  assert.deepEqual([nhs.HAS_NETWORK, nhs.TOTAL_IN_BYTES, nhs.TOTAL_OUT_BYTES, nhs.RATE_IN_BPS, nhs.RATE_OUT_BPS], [true, 1024n, 2048n, 12.5, 25]);
  assert.deepEqual(nhs.THROUGHPUT_HISTORY.map((s) => [s.TIME_MS, s.TOTAL_IN_BYTES, s.TOTAL_OUT_BYTES, s.RATE_IN_BPS, s.RATE_OUT_BPS]),
    SAMPLES.map((s) => [s.TS_MS, s.TOTAL_IN_BYTES, s.TOTAL_OUT_BYTES, s.RATE_IN_BPS, s.RATE_OUT_BPS]), "the bandwidth history, oldest first");
  assert.equal(nhs.HAS_COMPUTE, false, "compute is not measured, never a confident zero");
  assert.deepEqual(stub.calls.map((c) => c.op), ["node_status_read.status", "node.peerId", "clock.now"]);
  assert.deepEqual(stub.calls[0].params, {}, "node_status_read.status takes no params");
});

test("an unavailable host clock leaves GENERATED_AT_MS 0 and still serves the snapshot", async (t) => {
  const stub = hostStub({ fail: { "clock.now": { code: "not-authorized", message: "clock not granted" } } });
  const out = outputsOf(await (await harnessFor(t, stub)).invoke({ methodId: "status", inputs: [decision(GET_STATUS)] }));
  const nhs = decodeNhs(out.status);
  assert.equal(nhs.GENERATED_AT_MS, 0n);
  assert.equal(nhs.UPTIME_S, REPORT.UPTIME_S);
});

test("a refused decision passes through untouched with no hostcall; a route not owned answers 404", async (t) => {
  const stub = hostStub();
  const harness = await harnessFor(t, stub);
  const refused = decision({ METHOD: aprLib.aprMethod.POST, PATH: "/api/v1/node/status", STATUS: 405, ERROR_CODE: "method-not-allowed", ERROR_MESSAGE: "no POST route for node status (GET only)" });
  const passed = outputsOf(await harness.invoke({ methodId: "status", inputs: [refused] }));
  assert.deepEqual(Object.keys(passed), ["decision"], "no body beside a refusal");
  assert.deepEqual(passed.decision, refused.payload);

  const other = outputsOf(await harness.invoke({ methodId: "status", inputs: [decision({ ...GET_STATUS, ROUTE: "activity", PARAMETERS: [["limit", "50"]] })] }));
  assert.deepEqual(Object.keys(other), ["decision"]);
  const apr = decodeApr(other.decision);
  assert.deepEqual([apr.STATUS, apr.ERROR_CODE, apr.ROUTE, apr.PATH], [404, "no-route", "activity", "/api/v1/node/status"]);
  assert.deepEqual(apr.PARAMETERS.map((p) => [p.NAME, p.VALUE]), [["limit", "50"]], "the rest of the decision is kept");
  assert.equal(stub.calls.length, 0, "neither reached the host");
});

test("a node_status_read.status failure answers the $APR with STATUS 503 and the host message, no body", async (t) => {
  const stub = hostStub({ fail: { "node_status_read.status": { code: "failed", message: "node status snapshot unavailable" } } });
  const out = outputsOf(await (await harnessFor(t, stub)).invoke({ methodId: "status", inputs: [decision(GET_STATUS)] }));
  assert.deepEqual(Object.keys(out), ["decision"]);
  const apr = decodeApr(out.decision);
  assert.deepEqual([apr.STATUS, apr.ERROR_CODE, apr.ERROR_MESSAGE, apr.ROUTE], [503, "status-unavailable", "node status snapshot unavailable", "status"]);
});

test("a frame that is not an $APR is refused", async (t) => {
  const harness = await harnessFor(t, hostStub());
  const result = await harness.invoke({ methodId: "status", inputs: [{ portId: "decision", typeRef: APR_TYPE, payload: new TextEncoder().encode("{\"route\":\"status\",\"format\":\"json\"}") }] });
  assert.notEqual(result.statusCode, 0);
  assert.equal(result.errorCode, "invalid-decision-frame");
});

// The compiled flow runtime drains a node's queue port-blind (maxStreams is declarative only), so a surplus frame on
// the single-stream port is refused by name rather than silently destroyed (graph: modules-guest-nodes-drop-batched-frames).
test("surplus decision frames are refused, never dropped", async (t) => {
  const stub = hostStub();
  const result = await (await harnessFor(t, stub)).invoke({ methodId: "status", inputs: [decision(GET_STATUS), decision(GET_STATUS)] });
  assert.equal(result.errorCode, "batched-input-frames");
  assert.match(result.errorMessage, /2 frames on single-stream input port "decision"/);
  assert.equal(result.outputs.length, 0);
  assert.equal(stub.calls.length, 0);
});

// hostcap/node-status SDK-compat tests (M1 node-status flow): the capability
// node forwards the routing decision to node_status_read.status (empty
// payload) and emits the RAW hostcall "result" object as JSON on "body"
// plus the decision passthrough on "decision".

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT = fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const STATUS_RESULT = {
  uptime_seconds: 12345,
  started_at: "2026-07-01T00:00:00Z",
  store: { total_bytes: 104857600, total_records: 4213, storage_path: "/var/lib/sdn/store" },
  disk: { capacity_bytes: 500000000000, free_bytes: 250000000000, available_bytes: 240000000000 },
  service: { state: "running", mode: "daemon", autostart_known: false },
  bandwidth: {
    total_in_bytes: 1024,
    total_out_bytes: 2048,
    rate_in_bps: 12.5,
    rate_out_bps: 25.0,
    history: [{ ts: "2026-07-01T00:00:00Z", total_in_bytes: 1024, total_out_bytes: 2048, rate_in_bps: 12.5, rate_out_bps: 25.0 }],
  },
};

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function readWasm() {
  return fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH));
}

function jsonInput(portId, value) {
  const payload = encoder.encode(JSON.stringify(value));
  // SDS PIV/TAB aligned typeRefs REQUIRE requiredAlignment and byteLength — see
  // graph task modules-guest-nodes-drop-batched-frames. Without them the SDK
  // invoke codec throws before the wasm is entered and every behavioural test
  // in this suite is dead while looking like a harness fault.
  return {
    portId,
    typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: payload.byteLength },
    payload,
  };
}

function createStub({ result, fail } = {}) {
  const calls = [];
  const dispatch = (operation, params) => {
    calls.push({ operation, params });
    if (fail) throw new Error(fail);
    return result;
  };
  return { calls, dispatch };
}

async function createHarness(t, stub) {
  const harness = await createBrowserModuleHarness({
    wasmSource: readWasm(),
    manifest: readManifest(),
    surface: "direct",
    hostcallDispatch: stub.dispatch,
  });
  t.after(() => harness.destroy());
  return harness;
}

function outputsByPort(response) {
  assert.equal(response.statusCode, 0, response.errorMessage);
  return new Map(response.outputs.map((frame) => [frame.portId, frame]));
}

test("hostcap/node-status artifact passes SDK compliance", async () => {
  const report = await validateArtifactWithStandards({
    manifest: readManifest(),
    wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH),
    standardsRoot: STANDARDS_ROOT,
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("hostcap/node-status artifact imports only WASI + the sync hostcall bridge", async () => {
  const inspection = await inspectModule(readWasm());
  const importedModuleNames = Array.from(new Set(inspection.imports.map((entry) => entry.module))).sort();
  assert.deepEqual(importedModuleNames, ["space_data_module_host", "wasi_snapshot_preview1"]);
  for (const required of [
    "plugin_alloc",
    "plugin_free",
    "plugin_invoke_stream",
    "plugin_get_manifest_flatbuffer",
    "plugin_get_manifest_flatbuffer_size",
  ]) {
    assert.ok(inspection.exports.includes(required), `missing export ${required}`);
  }
});

test("status forwards route=status to node_status_read.status with an empty payload and emits the result object verbatim", async (t) => {
  const stub = createStub({ result: STATUS_RESULT });
  const harness = await createHarness(t, stub);
  const decision = { route: "status", format: "json" };
  const response = await harness.invoke({
    methodId: "status",
    inputs: [jsonInput("decision", decision)],
  });
  const byPort = outputsByPort(response);
  assert.ok(byPort.has("decision"), "decision passthrough frame missing");
  assert.ok(byPort.has("body"), "body frame missing");

  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].operation, "node_status_read.status");
  assert.deepEqual(stub.calls[0].params, {}, "the hostcall input carries no fields");

  assert.deepEqual(JSON.parse(decoder.decode(byPort.get("decision").payload)), decision);
  assert.deepEqual(JSON.parse(decoder.decode(byPort.get("body").payload)), STATUS_RESULT);
});

test("a non-status decision short-circuits: no hostcall, decision forwarded unchanged, no body", async (t) => {
  const stub = createStub({ result: STATUS_RESULT });
  const harness = await createHarness(t, stub);
  const decision = { route: "error", status: 405, format: "json", error: "no POST route for node status (GET only)" };
  const response = await harness.invoke({
    methodId: "status",
    inputs: [jsonInput("decision", decision)],
  });
  const byPort = outputsByPort(response);
  assert.equal(stub.calls.length, 0, "a not-owned route must never reach the host");
  assert.deepEqual(JSON.parse(decoder.decode(byPort.get("decision").payload)), decision);
  assert.equal(byPort.has("body"), false, "no body frame on a not-owned route");
});

test("a node_status_read.status hostcall failure rewrites the decision to an honest 503", async (t) => {
  const stub = createStub({ fail: "node status snapshot unavailable" });
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({
    methodId: "status",
    inputs: [jsonInput("decision", { route: "status", format: "json" })],
  });
  const byPort = outputsByPort(response);
  assert.equal(stub.calls.length, 1);
  const decision = JSON.parse(decoder.decode(byPort.get("decision").payload));
  assert.equal(decision.route, "error");
  assert.equal(decision.status, 503);
  assert.match(decision.error, /unavailable/);
  assert.equal(byPort.has("body"), false, "no body frame on hostcall failure");
});

test("a missing/non-object hostcall result also answers an honest 503 (never a silent empty body)", async (t) => {
  // dispatch returning undefined -> the SDK harness envelope encodes
  // result:null (JSON has no "result":{...} object to splice).
  const stub = createStub({});
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({
    methodId: "status",
    inputs: [jsonInput("decision", { route: "status", format: "json" })],
  });
  const byPort = outputsByPort(response);
  const decision = JSON.parse(decoder.decode(byPort.get("decision").payload));
  assert.equal(decision.route, "error");
  assert.equal(decision.status, 503);
  assert.equal(byPort.has("body"), false);
});

test("a missing decision frame is a node error, zero hostcalls", async (t) => {
  const stub = createStub({ result: STATUS_RESULT });
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({ methodId: "status", inputs: [] });
  assert.notEqual(response.statusCode, 0);
  assert.equal(stub.calls.length, 0);
});

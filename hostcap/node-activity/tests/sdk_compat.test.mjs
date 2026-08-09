// hostcap/node-activity SDK-compat tests (M2 node-activity flow): the
// capability node forwards the routing decision's clamped "limit" as
// {"limit":N} to node_activity_read.activity and emits the RAW hostcall
// "result" object as JSON on "body" plus the decision passthrough on
// "decision".

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

const ACTIVITY_RESULT = {
  count: 2,
  events: [
    { ts: "2026-07-11T00:00:05Z", kind: "peer_connected", peer_id: "16Uiu2HAmX", detail: "inbound stream opened" },
    { ts: "2026-07-11T00:00:01Z", kind: "record_stored", detail: "1 OMM record ingested" },
  ],
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

test("hostcap/node-activity artifact passes SDK compliance", async () => {
  const report = await validateArtifactWithStandards({
    manifest: readManifest(),
    wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH),
    standardsRoot: STANDARDS_ROOT,
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("hostcap/node-activity artifact imports only WASI + the sync hostcall bridge", async () => {
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

test("activity forwards route=activity with the decision's limit and emits the result object verbatim", async (t) => {
  const stub = createStub({ result: ACTIVITY_RESULT });
  const harness = await createHarness(t, stub);
  const decision = { route: "activity", format: "json", limit: 25 };
  const response = await harness.invoke({
    methodId: "activity",
    inputs: [jsonInput("decision", decision)],
  });
  const byPort = outputsByPort(response);
  assert.ok(byPort.has("decision"), "decision passthrough frame missing");
  assert.ok(byPort.has("body"), "body frame missing");

  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].operation, "node_activity_read.activity");
  assert.deepEqual(stub.calls[0].params, { limit: 25 });

  assert.deepEqual(JSON.parse(decoder.decode(byPort.get("decision").payload)), decision);
  assert.deepEqual(JSON.parse(decoder.decode(byPort.get("body").payload)), ACTIVITY_RESULT);
});

test("activity defaults the hostcall limit to 50 when the decision carries none", async (t) => {
  const stub = createStub({ result: ACTIVITY_RESULT });
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({
    methodId: "activity",
    inputs: [jsonInput("decision", { route: "activity", format: "json" })],
  });
  outputsByPort(response);
  assert.equal(stub.calls.length, 1);
  assert.deepEqual(stub.calls[0].params, { limit: 50 });
});

test("activity defensively re-clamps an out-of-range decision limit to [1, 256]", async (t) => {
  const stub = createStub({ result: ACTIVITY_RESULT });

  const over = await createHarness(t, stub);
  await over.invoke({
    methodId: "activity",
    inputs: [jsonInput("decision", { route: "activity", format: "json", limit: 9000 })],
  });
  assert.deepEqual(stub.calls.at(-1).params, { limit: 256 });

  const under = await createHarness(t, stub);
  await under.invoke({
    methodId: "activity",
    inputs: [jsonInput("decision", { route: "activity", format: "json", limit: -3 })],
  });
  assert.deepEqual(stub.calls.at(-1).params, { limit: 1 });
});

test("a non-activity decision short-circuits: no hostcall, decision forwarded unchanged, no body", async (t) => {
  const stub = createStub({ result: ACTIVITY_RESULT });
  const harness = await createHarness(t, stub);
  const decision = { route: "error", status: 405, format: "json", error: "no POST route for node activity (GET only)" };
  const response = await harness.invoke({
    methodId: "activity",
    inputs: [jsonInput("decision", decision)],
  });
  const byPort = outputsByPort(response);
  assert.equal(stub.calls.length, 0, "a not-owned route must never reach the host");
  assert.deepEqual(JSON.parse(decoder.decode(byPort.get("decision").payload)), decision);
  assert.equal(byPort.has("body"), false, "no body frame on a not-owned route");
});

test("a node_activity_read.activity hostcall failure rewrites the decision to an honest 503", async (t) => {
  const stub = createStub({ fail: "node activity log unavailable" });
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({
    methodId: "activity",
    inputs: [jsonInput("decision", { route: "activity", format: "json", limit: 50 })],
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
    methodId: "activity",
    inputs: [jsonInput("decision", { route: "activity", format: "json", limit: 50 })],
  });
  const byPort = outputsByPort(response);
  const decision = JSON.parse(decoder.decode(byPort.get("decision").payload));
  assert.equal(decision.route, "error");
  assert.equal(decision.status, 503);
  assert.equal(byPort.has("body"), false);
});

test("a missing decision frame is a node error, zero hostcalls", async (t) => {
  const stub = createStub({ result: ACTIVITY_RESULT });
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({ methodId: "activity", inputs: [] });
  assert.notEqual(response.statusCode, 0);
  assert.equal(stub.calls.length, 0);
});

// hostcap/p2p-discovery SDK-compat tests (gateway loop G.2): the capability
// node forwards the discovery routing decision to p2p.peers_snapshot /
// p2p.standards_snapshot and emits the RAW hostcall response envelope on
// "snapshot" plus the decision passthrough on "decision".

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

// Hostcall wire envelope decoder (same layout as the SDK host/hostcallWire.js
// and the Go host's encodeHostcallEnvelope — mirrored locally like the
// celestrak-ingest flow tests do; the subpath is not exported).
function decodeHostcallEnvelope(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  const metaLen = view.getUint32(offset, true);
  offset += 4;
  const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(offset, offset + metaLen)));
  offset += metaLen;
  const segmentCount = view.getUint32(offset, true);
  offset += 4;
  const segments = [];
  for (let i = 0; i < segmentCount; i++) {
    const segmentLen = view.getUint32(offset, true);
    offset += 4;
    segments.push(Uint8Array.from(bytes.subarray(offset, offset + segmentLen)));
    offset += segmentLen;
  }
  return { meta, segments };
}

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT = fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Two fake size-prefixed frames (content is opaque to this node).
const EPM_STREAM = Uint8Array.from([3, 0, 0, 0, 0xaa, 0xbb, 0xcc, 0x00, 2, 0, 0, 0, 0x11, 0x22]);

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function readWasm() {
  return fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH));
}

function jsonInput(portId, value) {
  return { portId, typeRef: { wireFormat: "aligned-binary" }, payload: encoder.encode(JSON.stringify(value)) };
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
  const byPort = new Map(response.outputs.map((frame) => [frame.portId, frame]));
  assert.ok(byPort.has("decision"), "decision passthrough frame missing");
  assert.ok(byPort.has("snapshot"), "snapshot envelope frame missing");
  return byPort;
}

test("hostcap/p2p-discovery artifact passes SDK compliance", async () => {
  const report = await validateArtifactWithStandards({
    manifest: readManifest(),
    wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH),
    standardsRoot: STANDARDS_ROOT,
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("peers forwards the peerId filter and emits the raw envelope + passthrough", async (t) => {
  const stub = createStub({
    result: {
      self: "16Uiu2SELF",
      peers: [
        { peer_id: "16Uiu2SELF", addrs: [], connected: true, self: true, standards: ["OMM"], epm_index: 0 },
      ],
      records: EPM_STREAM,
    },
  });
  const harness = await createHarness(t, stub);
  const decision = { route: "peer_get", format: "json", peerId: "16Uiu2SELF" };
  const response = await harness.invoke({
    methodId: "peers_snapshot",
    inputs: [jsonInput("request", decision)],
  });
  const byPort = outputsByPort(response);

  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].operation, "p2p.peers_snapshot");
  assert.equal(stub.calls[0].params.peer_id, "16Uiu2SELF");

  assert.deepEqual(JSON.parse(decoder.decode(byPort.get("decision").payload)), decision);

  const envelope = decodeHostcallEnvelope(byPort.get("snapshot").payload);
  assert.equal(envelope.meta.ok, true);
  assert.equal(envelope.meta.result.self, "16Uiu2SELF");
  assert.deepEqual(envelope.meta.result.records, { $bin: 0 });
  assert.deepEqual(Array.from(envelope.segments[0]), Array.from(EPM_STREAM));
});

test("standards issues p2p.standards_snapshot without a peer filter", async (t) => {
  const stub = createStub({
    result: { entries: [], records: new Uint8Array(0) },
  });
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({
    methodId: "standards_snapshot",
    inputs: [jsonInput("request", { route: "standards", format: "flatbuffer" })],
  });
  outputsByPort(response);
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].operation, "p2p.standards_snapshot");
  assert.equal(stub.calls[0].params.peer_id, undefined);
});

test("a not_found decision short-circuits: no hostcall, empty-result envelope", async (t) => {
  const stub = createStub({ result: {} });
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({
    methodId: "peers_snapshot",
    inputs: [jsonInput("request", { route: "not_found", format: "flatbuffer", error: "no route" })],
  });
  const byPort = outputsByPort(response);
  assert.equal(stub.calls.length, 0, "not_found must not reach the host");
  const envelope = decodeHostcallEnvelope(byPort.get("snapshot").payload);
  assert.equal(envelope.meta.ok, true);
  assert.deepEqual(envelope.meta.result, {});
  assert.equal(envelope.segments.length, 0);
});

test("host failures surface as node errors", async (t) => {
  const stub = createStub({ fail: "p2p registry unavailable" });
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({
    methodId: "peers_snapshot",
    inputs: [jsonInput("request", { route: "peers_list", format: "json" })],
  });
  assert.notEqual(response.statusCode, 0);
  assert.match(response.errorMessage ?? "", /unavailable|hostcall failed/i);
});

test("a missing request frame is a node error, zero hostcalls", async (t) => {
  const stub = createStub({ result: {} });
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({ methodId: "peers_snapshot", inputs: [] });
  assert.notEqual(response.statusCode, 0);
  assert.equal(stub.calls.length, 0);
});

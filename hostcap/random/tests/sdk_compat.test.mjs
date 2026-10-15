import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createNodeHost } from "space-data-module-sdk";
import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { createBrowserHost } from "space-data-module-sdk/host/browser";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

import { STANDARDS_ROOT, loadStandard } from "./sds_bindings.mjs";

// hostcap/random on the typed contracts (1.0): an optional $RND request in, one $RND out; random.bytes and clock.now
// are SDS $PIV hostcalls the SDK host bridge decodes into the host's own calls.
const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const { RND, rndSource, flatbuffers } = await loadStandard("RND");

const RND_TYPE = { schemaName: "RND.fbs", fileIdentifier: "$RND", rootTypeName: "RND", wireFormat: "flatbuffer" };
const FIXED_NOW_MS = 1_782_950_400_123;

const readManifest = () => JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
const readWasm = () => fs.readFileSync(fileURLToPath(WASM_PATH));

function encodeRequest({ length = 0, source = rndSource.Unspecified } = {}) {
  const b = new flatbuffers.Builder(64);
  RND.startRND(b);
  RND.addLength(b, length);
  RND.addSource(b, source);
  RND.finishRNDBuffer(b, RND.endRND(b));
  return b.asUint8Array();
}
const requestFrame = (request) => ({ portId: "request", typeRef: RND_TYPE, payload: encodeRequest(request) });

// The SDK JS host's built-ins as the bridge calls them: random.bytes({length}) -> Uint8Array, clock.now -> Unix ms.
function hostStub({ failOps = {}, shortBy = 0 } = {}) {
  const calls = [];
  const dispatch = (operation, params) => {
    calls.push({ operation, params });
    if (failOps[operation]) throw Object.assign(new Error(failOps[operation]), { name: "HostCapabilityError" });
    if (operation === "random.bytes") return Uint8Array.from({ length: params.length - shortBy }, (_, i) => (i * 37 + 11) & 0xff);
    if (operation === "clock.now") return FIXED_NOW_MS;
    throw new Error(`unexpected hostcall ${operation}`);
  };
  return { calls, dispatch };
}
async function harnessFor(t, options, surface = "direct") {
  const harness = await createBrowserModuleHarness({ wasmSource: readWasm(), manifest: readManifest(), surface, ...options });
  t.after(() => harness.destroy());
  return harness;
}
function decodeRandom(result) {
  assert.equal(result.statusCode, 0, result.errorMessage);
  assert.equal(result.outputs.length, 1);
  const [frame] = result.outputs;
  assert.equal(frame.portId, "bytes");
  const bb = new flatbuffers.ByteBuffer(frame.payload);
  assert.ok(RND.bufferHasIdentifier(bb), "the frame is a $RND");
  const rnd = RND.getRootAsRND(bb);
  return { length: rnd.LENGTH(), bytes: rnd.bytesArray() ?? new Uint8Array(), source: rnd.SOURCE(), generatedAtMs: Number(rnd.GENERATED_AT_MS()) };
}
const expectedBytes = (n) => Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff);

test("hostcap/random passes SDK compliance with $RND ports", async () => {
  const report = await validateArtifactWithStandards({ manifest: readManifest(), wasmPath: fileURLToPath(WASM_PATH), standardsRoot: STANDARDS_ROOT });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
  const [method] = readManifest().methods;
  assert.deepEqual(method.inputPorts[0].acceptedTypeSets[0].allowedTypes, [RND_TYPE]);
  assert.deepEqual(method.outputPorts[0].acceptedTypeSets[0].allowedTypes, [RND_TYPE]);
});

test("hostcap/random imports only WASI and the sync hostcall bridge", async () => {
  const inspection = await inspectModule(readWasm());
  assert.equal(inspection.profile, "module-host-abi");
  assert.deepEqual(Array.from(new Set(inspection.imports.map((e) => e.module))).sort(), ["space_data_module_host", "wasi_snapshot_preview1"]);
});

test("a $RND request for LENGTH bytes answers a $RND with the host's bytes verbatim", async (t) => {
  const stub = hostStub();
  const harness = await harnessFor(t, { hostcallDispatch: stub.dispatch });
  const out = decodeRandom(await harness.invoke({ methodId: "bytes", inputs: [requestFrame({ length: 100 })] }));
  assert.equal(out.length, 100);
  assert.deepEqual(out.bytes, expectedBytes(100));
  assert.equal(out.source, rndSource.SystemCsprng);
  assert.equal(out.generatedAtMs, FIXED_NOW_MS);
  assert.deepEqual(stub.calls, [{ operation: "random.bytes", params: { length: 100 } }, { operation: "clock.now", params: stub.calls[1].params }]);
});

test("no request, or LENGTH 0, asks for 32 bytes", async (t) => {
  const stub = hostStub();
  const command = await harnessFor(t, { hostcallDispatch: stub.dispatch }, "command");
  assert.equal(decodeRandom(await command.invoke({ methodId: "bytes", inputs: [] })).bytes.length, 32);
  const direct = await harnessFor(t, { hostcallDispatch: stub.dispatch });
  assert.equal(decodeRandom(await direct.invoke({ methodId: "bytes", inputs: [requestFrame({ length: 0 })] })).length, 32);
  assert.deepEqual(stub.calls.filter((c) => c.operation === "random.bytes").map((c) => c.params.length), [32, 32]);
});

test("LENGTH 8192 is served; 8193 is refused before any hostcall", async (t) => {
  const stub = hostStub();
  const harness = await harnessFor(t, { hostcallDispatch: stub.dispatch });
  assert.equal(decodeRandom(await harness.invoke({ methodId: "bytes", inputs: [requestFrame({ length: 8192 })] })).bytes.length, 8192);
  const calls = stub.calls.length;
  const refused = await harness.invoke({ methodId: "bytes", inputs: [requestFrame({ length: 8193 })] });
  assert.notEqual(refused.statusCode, 0);
  assert.equal(refused.errorCode, "invalid-length");
  assert.match(String(refused.errorMessage), /between 1 and 8192/);
  assert.equal(refused.outputs.length, 0);
  assert.equal(stub.calls.length, calls, "no hostcall for a refused length");
});

test("a request for a source the host does not have is refused", async (t) => {
  const stub = hostStub();
  const harness = await harnessFor(t, { hostcallDispatch: stub.dispatch });
  const result = await harness.invoke({ methodId: "bytes", inputs: [requestFrame({ length: 8, source: rndSource.Beacon })] });
  assert.equal(result.errorCode, "unsupported-source");
  assert.equal(stub.calls.length, 0);
});

test("a request frame that is not a $RND is refused", async (t) => {
  const harness = await harnessFor(t, { hostcallDispatch: hostStub().dispatch });
  const result = await harness.invoke({ methodId: "bytes", inputs: [{ portId: "request", typeRef: RND_TYPE, payload: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) }] });
  assert.equal(result.errorCode, "invalid-request");
  assert.equal(result.outputs.length, 0);
});

test("a host failure or a short answer fails closed", async (t) => {
  const failing = await harnessFor(t, { hostcallDispatch: hostStub({ failOps: { "random.bytes": "random capability not granted" } }).dispatch });
  const failed = await failing.invoke({ methodId: "bytes", inputs: [requestFrame({ length: 16 })] });
  assert.equal(failed.errorCode, "random-unavailable");
  assert.match(String(failed.errorMessage), /random capability not granted/);
  assert.equal(failed.outputs.length, 0);
  const short = await harnessFor(t, { hostcallDispatch: hostStub({ shortBy: 1 }).dispatch });
  const shorted = await short.invoke({ methodId: "bytes", inputs: [requestFrame({ length: 16 })] });
  assert.equal(shorted.errorCode, "random-unavailable");
  assert.match(String(shorted.errorMessage), /15 bytes for a request of 16/);
});

test("bytes works against the real SDK NodeHost and BrowserHost (capability-gated)", async (t) => {
  for (const host of [createNodeHost({ capabilities: ["random", "clock"] }), createBrowserHost({ capabilities: ["random", "clock"] })]) {
    const harness = await harnessFor(t, { host });
    const before = Date.now();
    const a = decodeRandom(await harness.invoke({ methodId: "bytes", inputs: [requestFrame({ length: 64 })] }));
    const b = decodeRandom(await harness.invoke({ methodId: "bytes", inputs: [requestFrame({ length: 64 })] }));
    assert.equal(a.bytes.length, 64);
    assert.notDeepEqual(a.bytes, b.bytes, "two draws differ");
    assert.ok(a.generatedAtMs >= before && a.generatedAtMs <= Date.now());
  }
  const denied = await harnessFor(t, { host: createNodeHost({ capabilities: ["clock"] }) });
  const result = await denied.invoke({ methodId: "bytes", inputs: [requestFrame({ length: 8 })] });
  assert.equal(result.errorCode, "random-unavailable");
});

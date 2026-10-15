import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";
import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { decodeHostCall } from "space-data-module-sdk/runtime-contracts";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

// hostcap/storage-write on the typed contracts (1.0): ONE $IRM record in, ONE $PNM (the CID it was stored under) out,
// and the host call an SDS $PIV storage.write (StorageWriteParams + raw data -> StorageWriteResult CID).
const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT = process.env.SPACE_DATA_STANDARDS_ROOT ?? fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));
// The standard's own generated reader (and the flatbuffers runtime it is generated against).
const { PNM } = await import(pathToFileURL(path.join(STANDARDS_ROOT, "lib/js/PNM/PNM.js")).href);
const flatbuffers = await import(pathToFileURL(path.join(STANDARDS_ROOT, "node_modules/flatbuffers/mjs/flatbuffers.js")).href);

const readManifest = () => JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
const readWasm = () => fs.readFileSync(fileURLToPath(WASM_PATH));

// THE BEHAVIOUR LEG. The shipped artifact declares runtimeTargets [wasmedge] (storage_write is browser-incompatible:
// a browser has no node store), and the SDK's browser harness rightly refuses to load it; this machine has no WasmEdge,
// and WasmEdge has no JS hostcall dispatch to observe the typed call with. So the behaviour tests run a TWIN compiled
// here from the SAME source with the SAME build options. Its manifest differs only where the browser leg demands:
// runtimeTargets admit "browser", and the storage_write capability (browser-incompatible, refused by manifest
// validation) and its host interface are left out - the guest never reads them, and the test's hostcallDispatch stands
// in for the host. Compliance and the import contract are checked on the shipped artifact itself.
let twin;
async function twinWasm() {
  twin ??= (async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hostcap-storage-write-twin-"));
    const manifest = { ...readManifest(), runtimeTargets: ["browser", "wasmedge"], capabilities: [], externalInterfaces: [] };
    const outputPath = path.join(dir, "module.wasm");
    const compilation = await compileModuleFromSource({
      manifest, sourceCode: fs.readFileSync(fileURLToPath(new URL("../src/storage_write_module.cpp", import.meta.url)), "utf8"),
      language: "c++", outputPath, threadModel: "single-thread", allowUndefinedImports: true,
    });
    assert.equal(compilation.report?.ok, true, JSON.stringify(compilation.report?.issues ?? []));
    const bytes = fs.readFileSync(outputPath);
    fs.rmSync(dir, { recursive: true, force: true });
    return { manifest, bytes };
  })();
  return twin;
}
const IRM_REF = { schemaName: "IRM.fbs", fileIdentifier: "$IRM", rootTypeName: "IRM", wireFormat: "flatbuffer" };
const CID = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";

// A FlatBuffer root carrying file identifier `$CODE` and `extra` bytes of payload after it (an empty table).
function record(code, extra = 0) {
  const b = new Uint8Array(16 + extra), v = new DataView(b.buffer);
  v.setUint32(0, 12, true);
  b.set(new TextEncoder().encode(`$${code}`), 4);
  v.setUint16(8, 4, true); v.setUint16(10, 4, true);
  v.setInt32(12, 4, true);
  for (let i = 0; i < extra; i++) b[16 + i] = (i * 31 + 7) & 0xff;
  return b;
}
const MARK = record("IRM", 24);
const recordFrame = (payload, typeRef = IRM_REF) => ({ portId: "record", typeRef, payload });

function decodeNotice(bytes) {
  const bb = new flatbuffers.ByteBuffer(bytes);
  assert.equal(bb.getBufferIdentifier(), "$PNM");
  const pnm = PNM.getRootAsPNM(bb);
  return { cid: pnm.CID(), fileName: pnm.FILE_NAME(), fileId: pnm.FILE_ID(), timestamp: pnm.PUBLISH_TIMESTAMP() };
}

function hostStub({ fail, answer } = {}) {
  const calls = [];
  const wire = [];
  const dispatch = (operation, params) => {
    calls.push({ operation, params: { ...params, data: params.data ? Uint8Array.from(params.data) : undefined } });
    if (operation !== "storage.write") throw new Error(`unexpected hostcall ${operation}`);
    if (fail) throw fail;
    return answer ?? { cid: CID };
  };
  return { calls, wire, dispatch };
}
// The harness hands the stub the host's decoded arguments; the $PIV request itself is read from guest memory.
async function harnessFor(t, stub) {
  await twinWasm();  // compiled before instantiate is wrapped: the compiler instantiates wasm of its own
  const instantiate = WebAssembly.instantiate;
  WebAssembly.instantiate = async (module, imports) => {
    let memory;
    const host = imports.space_data_module_host;
    const wrapped = { ...imports, space_data_module_host: { ...host, call: (op, opLen, ptr, len) => {
      stub.wire.push(decodeHostCall(new Uint8Array(memory.buffer, ptr, len).slice()));
      return host.call(op, opLen, ptr, len);
    } } };
    const instance = await instantiate(module, wrapped);
    memory = instance.exports.memory;
    return instance;
  };
  let harness;
  try {
    const { manifest, bytes } = await twinWasm();
    harness = await createBrowserModuleHarness({ wasmSource: bytes, manifest, surface: "direct", hostcallDispatch: stub.dispatch });
  } finally {
    WebAssembly.instantiate = instantiate;
  }
  t.after(() => harness.destroy());
  return harness;
}

test("hostcap/storage-write passes SDK compliance with typed ports", async () => {
  const report = await validateArtifactWithStandards({ manifest: readManifest(), wasmPath: fileURLToPath(WASM_PATH), standardsRoot: STANDARDS_ROOT });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
  const [method] = readManifest().methods;
  assert.deepEqual(method.inputPorts.map((p) => p.portId), ["record"]);
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[0].fileIdentifier, "$IRM");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[0].fileIdentifier, "$PNM");
});

test("hostcap/storage-write imports only WASI and the sync hostcall bridge", async () => {
  const inspection = await inspectModule(readWasm());
  assert.equal(inspection.profile, "module-host-abi");
  assert.deepEqual(Array.from(new Set(inspection.imports.map((e) => e.module))).sort(), ["space_data_module_host", "wasi_snapshot_preview1"]);
});

test("an $IRM record becomes one typed storage.write; the result is a $PNM with the host's CID", async (t) => {
  const stub = hostStub();
  const harness = await harnessFor(t, stub);
  const response = await harness.invoke({ methodId: "write_record", inputs: [recordFrame(MARK)] });
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.outputs.length, 1);
  assert.equal(response.outputs[0].portId, "result");
  assert.deepEqual(decodeNotice(response.outputs[0].payload), { cid: CID, fileName: "IRM.fbs", fileId: null, timestamp: null });

  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].operation, "storage.write");
  assert.equal(stub.calls[0].params.schema, "IRM.fbs");
  assert.deepEqual(stub.calls[0].params.data, MARK, "the record reaches the host verbatim, as bytes");
  const [call] = stub.wire;
  assert.equal(call.params.SCHEMA, "IRM.fbs");
  assert.deepEqual(Object.keys(call.raw), ["data"]);
});

test("a frame typed one standard over a record of another is refused, never filed under either", async (t) => {
  const stub = hostStub();
  const harness = await harnessFor(t, stub);
  const response = await harness.invoke({ methodId: "write_record", inputs: [recordFrame(record("OMM"))] });
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "record-type-disagreement");
  assert.match(response.errorMessage, /typed "\$IRM" but the record's own file identifier is "\$OMM"/);
  assert.equal(stub.calls.length, 0);
});

test("a host refusal or failure fails the node with the host's code and message", async (t) => {
  const denied = hostStub({ fail: Object.assign(new Error("requires the storage_write capability grant"), { name: "HostCapabilityError" }) });
  const response = await (await harnessFor(t, denied)).invoke({ methodId: "write_record", inputs: [recordFrame(MARK)] });
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "write-failed");
  assert.equal(response.errorMessage, "not-authorized: requires the storage_write capability grant");
  assert.equal(response.outputs.length, 0);

  const noCid = hostStub({ answer: {} });
  const empty = await (await harnessFor(t, noCid)).invoke({ methodId: "write_record", inputs: [recordFrame(MARK)] });
  assert.equal(empty.errorCode, "write-failed");
  assert.match(empty.errorMessage, /without a CID/);
});

test("surplus records are refused, never dropped; a missing record is refused", async (t) => {
  const stub = hostStub();
  const harness = await harnessFor(t, stub);
  const twice = await harness.invoke({ methodId: "write_record", inputs: [recordFrame(MARK), recordFrame(record("IRM", 8))] });
  assert.equal(twice.errorCode, "batched-input-frames");
  assert.match(twice.errorMessage, /2 frames on single-stream input port "record"/);
  assert.equal(twice.outputs.length, 0);
  const none = await harness.invoke({ methodId: "write_record", inputs: [] });
  assert.notEqual(none.statusCode, 0);
  assert.equal(stub.calls.length, 0);
});

test("the source contains no port-blind plugin_get_input_frame(0)", () => {
  const source = fs.readFileSync(fileURLToPath(new URL("../src/storage_write_module.cpp", import.meta.url)), "utf8");
  const offenders = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line) && line.includes("plugin_get_input_frame(0)"));
  assert.deepEqual(offenders, []);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createNodeHost } from "space-data-module-sdk";
import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { createBrowserModuleHarness, createWorkerModuleHarness } from "space-data-module-sdk/testing";

import { STANDARDS_ROOT, loadStandard } from "./sds_bindings.mjs";

// hostcap/file on the typed contracts (1.0): $FIL in, $FIL out; the filesystem and clock reads are SDS $PIV hostcalls
// the SDK host bridge decodes into the host's own filesystem.* / clock.now calls.
const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const { FIL, filEntryKind, flatbuffers } = await loadStandard("FIL");

const FIL_TYPE = { schemaName: "FIL.fbs", fileIdentifier: "$FIL", rootTypeName: "FIL", wireFormat: "flatbuffer" };
const FIXED_NOW_MS = 1_782_950_400_123;
const FIXED_MTIME_MS = 1_782_000_000_456;

const readManifest = () => JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
const readWasm = () => fs.readFileSync(fileURLToPath(WASM_PATH));
const text = (s) => new TextEncoder().encode(s);

function encodeFile({ filePath, content = null, append = false }) {
  const b = new flatbuffers.Builder(256);
  const pathOffset = filePath == null ? 0 : b.createString(filePath);
  const contentOffset = content == null ? 0 : FIL.createContentVector(b, content);
  FIL.startFIL(b);
  if (pathOffset) FIL.addPath(b, pathOffset);
  if (contentOffset) FIL.addContent(b, contentOffset);
  if (append) FIL.addAppend(b, true);
  FIL.finishFILBuffer(b, FIL.endFIL(b));
  return b.asUint8Array();
}
const fileFrame = (portId, file) => ({ portId, typeRef: FIL_TYPE, payload: encodeFile(file) });

function decodeFile(result, port) {
  assert.equal(result.statusCode, 0, result.errorMessage);
  assert.equal(result.outputs.length, 1);
  const [frame] = result.outputs;
  assert.equal(frame.portId, port);
  const bb = new flatbuffers.ByteBuffer(frame.payload);
  assert.ok(FIL.bufferHasIdentifier(bb), "the frame is a $FIL");
  const fil = FIL.getRootAsFIL(bb);
  return {
    path: fil.PATH(),
    name: fil.NAME(),
    kind: fil.KIND(),
    size: Number(fil.SIZE()),
    content: fil.contentArray(),
    append: fil.APPEND(),
    modifiedAtMs: Number(fil.MODIFIED_AT_MS()),
    writtenAtMs: Number(fil.WRITTEN_AT_MS()),
  };
}

// The SDK JS host's built-ins as the bridge calls them: filesystem.readFile({path}) -> bytes, writeFile / appendFile
// ({path, value}), stat({path}) -> {size, mtimeMs, ...}, clock.now -> Unix ms.
function hostStub({ files = {}, failOps = {} } = {}) {
  const calls = [];
  const dispatch = (operation, params) => {
    calls.push({ operation, params });
    if (failOps[operation]) throw Object.assign(new Error(failOps[operation]), { name: "HostCapabilityError" });
    switch (operation) {
      case "filesystem.readFile":
        if (!(params.path in files)) throw new Error(`ENOENT: ${params.path}`);
        return files[params.path];
      case "filesystem.stat":
        return { size: files[params.path]?.length ?? 0, isFile: true, isDirectory: false, ctimeMs: FIXED_MTIME_MS, mtimeMs: FIXED_MTIME_MS };
      case "filesystem.writeFile":
        files[params.path] = Uint8Array.from(params.value);
        return undefined;
      case "filesystem.appendFile":
        files[params.path] = Uint8Array.from([...(files[params.path] ?? []), ...params.value]);
        return undefined;
      case "clock.now":
        return FIXED_NOW_MS;
      default:
        throw new Error(`unexpected hostcall ${operation}`);
    }
  };
  return { calls, files, dispatch };
}
async function harnessFor(t, options) {
  const harness = await createBrowserModuleHarness({ wasmSource: readWasm(), manifest: readManifest(), surface: "direct", ...options });
  t.after(() => harness.destroy());
  return harness;
}

test("hostcap/file passes SDK compliance with $FIL ports", async () => {
  const report = await validateArtifactWithStandards({ manifest: readManifest(), wasmPath: fileURLToPath(WASM_PATH), standardsRoot: STANDARDS_ROOT });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
  for (const method of readManifest().methods) {
    for (const port of [...method.inputPorts, ...method.outputPorts]) assert.deepEqual(port.acceptedTypeSets[0].allowedTypes, [FIL_TYPE]);
  }
});

test("hostcap/file imports only WASI and the sync hostcall bridge", async () => {
  const inspection = await inspectModule(readWasm());
  assert.equal(inspection.profile, "module-host-abi");
  assert.deepEqual(Array.from(new Set(inspection.imports.map((e) => e.module))).sort(), ["space_data_module_host", "wasi_snapshot_preview1"]);
});

test("read_file answers a $FIL with the content verbatim, its size and modification time", async (t) => {
  const bytes = Uint8Array.from({ length: 300 }, (_, i) => (i * 7) & 0xff);
  const stub = hostStub({ files: { "data/blob.bin": bytes } });
  const harness = await harnessFor(t, { hostcallDispatch: stub.dispatch });
  const out = decodeFile(await harness.invoke({ methodId: "read_file", inputs: [fileFrame("request", { filePath: "data/blob.bin" })] }), "file");
  assert.equal(out.path, "data/blob.bin");
  assert.equal(out.name, "blob.bin");
  assert.equal(out.kind, filEntryKind.File);
  assert.equal(out.size, 300);
  assert.deepEqual(out.content, bytes);
  assert.equal(out.modifiedAtMs, FIXED_MTIME_MS);
  assert.deepEqual(stub.calls.map((c) => [c.operation, c.params.path]), [["filesystem.readFile", "data/blob.bin"], ["filesystem.stat", "data/blob.bin"]]);
});

test("read_file keeps the content when stat is unavailable (MODIFIED_AT_MS 0)", async (t) => {
  const stub = hostStub({ files: { "a.txt": text("hello") }, failOps: { "filesystem.stat": "stat not supported" } });
  const harness = await harnessFor(t, { hostcallDispatch: stub.dispatch });
  const out = decodeFile(await harness.invoke({ methodId: "read_file", inputs: [fileFrame("request", { filePath: "a.txt" })] }), "file");
  assert.deepEqual(out.content, text("hello"));
  assert.equal(out.modifiedAtMs, 0);
});

test("read_file fails closed on a missing file, a missing PATH or a frame that is not a $FIL", async (t) => {
  const harness = await harnessFor(t, { hostcallDispatch: hostStub().dispatch });
  const missing = await harness.invoke({ methodId: "read_file", inputs: [fileFrame("request", { filePath: "nope.txt" })] });
  assert.equal(missing.errorCode, "file-read-failed");
  assert.match(String(missing.errorMessage), /ENOENT/);
  assert.equal(missing.outputs.length, 0);
  const noPath = await harness.invoke({ methodId: "read_file", inputs: [fileFrame("request", { filePath: null })] });
  assert.equal(noPath.errorCode, "missing-path");
  const garbage = await harness.invoke({ methodId: "read_file", inputs: [{ portId: "request", typeRef: FIL_TYPE, payload: new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9]) }] });
  assert.equal(garbage.errorCode, "invalid-request");
});

test("write_file writes CONTENT and answers a $FIL without content", async (t) => {
  const stub = hostStub();
  const harness = await harnessFor(t, { hostcallDispatch: stub.dispatch });
  const body = text("line one\n");
  const out = decodeFile(await harness.invoke({ methodId: "write_file", inputs: [fileFrame("file", { filePath: "out/log.txt", content: body })] }), "result");
  assert.deepEqual(stub.files["out/log.txt"], body);
  assert.equal(out.path, "out/log.txt");
  assert.equal(out.name, "log.txt");
  assert.equal(out.size, body.length);
  assert.equal(out.content, null, "the answer does not repeat the content");
  assert.equal(out.append, false);
  assert.equal(out.writtenAtMs, FIXED_NOW_MS);
  assert.deepEqual(stub.calls.map((c) => c.operation), ["filesystem.writeFile", "clock.now"]);
});

test("write_file with APPEND appends through filesystem.appendFile", async (t) => {
  const stub = hostStub({ files: { "log.txt": text("a\n") } });
  const harness = await harnessFor(t, { hostcallDispatch: stub.dispatch });
  const out = decodeFile(await harness.invoke({ methodId: "write_file", inputs: [fileFrame("file", { filePath: "log.txt", content: text("b\n"), append: true })] }), "result");
  assert.deepEqual(stub.files["log.txt"], text("a\nb\n"));
  assert.equal(out.size, 2, "SIZE is the bytes written, not the file size");
  assert.equal(out.append, true);
  assert.equal(stub.calls[0].operation, "filesystem.appendFile");
});

test("write_file fails closed on a host refusal and keeps a zero write time without the clock", async (t) => {
  const refused = await harnessFor(t, { hostcallDispatch: hostStub({ failOps: { "filesystem.writeFile": "filesystem capability not granted" } }).dispatch });
  const failed = await refused.invoke({ methodId: "write_file", inputs: [fileFrame("file", { filePath: "x.txt", content: text("x") })] });
  assert.equal(failed.errorCode, "file-write-failed");
  assert.match(String(failed.errorMessage), /filesystem capability not granted/);
  assert.equal(failed.outputs.length, 0);
  const noClock = await harnessFor(t, { hostcallDispatch: hostStub({ failOps: { "clock.now": "clock not granted" } }).dispatch });
  const out = decodeFile(await noClock.invoke({ methodId: "write_file", inputs: [fileFrame("file", { filePath: "x.txt", content: text("x") })] }), "result");
  assert.equal(out.writtenAtMs, 0);
  assert.equal(out.size, 1);
});

// The SDK NodeHost's filesystem.* are async, so the guest runs in the worker harness (its sync hostcalls block on a
// SharedArrayBuffer channel while the NodeHost resolves them on this thread).
async function workerHarnessFor(t, host) {
  const harness = await createWorkerModuleHarness({ wasmSource: readWasm(), host, harnessOptions: { manifest: readManifest(), surface: "direct" } });
  t.after(() => harness.destroy());
  return harness;
}

test("write_file then read_file round-trip through the real SDK NodeHost sandbox", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hostcap-file-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const host = createNodeHost({ capabilities: ["filesystem", "clock"], filesystemRoot: root });
  const harness = await workerHarnessFor(t, host);
  const body = Uint8Array.from({ length: 4096 }, (_, i) => (i * 131 + 3) & 0xff);
  const before = Date.now();
  const written = decodeFile(await harness.invoke({ methodId: "write_file", inputs: [fileFrame("file", { filePath: "blob.bin", content: body })] }), "result");
  assert.equal(written.size, 4096);
  assert.ok(written.writtenAtMs >= before && written.writtenAtMs <= Date.now());
  assert.deepEqual(new Uint8Array(fs.readFileSync(path.join(root, "blob.bin"))), body, "the bytes landed under the sandbox root");
  decodeFile(await harness.invoke({ methodId: "write_file", inputs: [fileFrame("file", { filePath: "blob.bin", content: text("tail"), append: true })] }), "result");
  const read = decodeFile(await harness.invoke({ methodId: "read_file", inputs: [fileFrame("request", { filePath: "blob.bin" })] }), "file");
  assert.equal(read.size, 4100);
  assert.deepEqual(read.content, Uint8Array.from([...body, ...text("tail")]));
  assert.equal(read.modifiedAtMs, Math.trunc(fs.statSync(path.join(root, "blob.bin")).mtimeMs));
  const denied = await workerHarnessFor(t, createNodeHost({ capabilities: [], filesystemRoot: root }));
  const refused = await denied.invoke({ methodId: "read_file", inputs: [fileFrame("request", { filePath: "blob.bin" })] });
  assert.equal(refused.errorCode, "file-read-failed");
});

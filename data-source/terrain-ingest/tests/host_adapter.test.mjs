// The Moon flow's IPFS adapter (host-adapter/): pack's typed files and names in, one $PNM (CID + FILE_NAME) per file
// out, with the node's ipfs.add answered here the way the host answers it - [u32 length][JSON] - and the bytes it was
// asked to add checked against the file frames. An add the host refuses stops the batch.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

import { composeAdapter } from "../host-adapter/source.mjs";

import { flatbuffers, STANDARDS_ROOT } from "../../terrain-source/typed-frames.mjs";

const PNM_LIB = await import(new URL(`file://${STANDARDS_ROOT}/lib/js/PNM/main.js`).href);
// The shipped adapter declares wasmedge and the ipfs capability, which the SDK browser harness (rightly) refuses to
// load, so the test compiles THE SAME source once under a manifest the harness admits - browser leg, no declared
// capability - and answers the hostcall bridge itself: the substitution build-parity.mjs makes for terrain-source.
const { manifest, sourceCode } = await composeAdapter();
const browserManifest = { ...manifest, capabilities: [], runtimeTargets: ["browser", "wasmedge"] };
const testWasm = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "terrain-adapter-")), "module.wasm");
const compiled = await compileModuleFromSource({ manifest: browserManifest, sourceCode, language: "c++", outputPath: testWasm, threadModel: "wasi-sequential", allowUndefinedImports: true });
if (!compiled.report?.ok) throw new Error(JSON.stringify(compiled.report?.issues));
test.after(() => fs.rmSync(path.dirname(testWasm), { recursive: true, force: true }));
const DTT = { schemaName: "DTT.fbs", fileIdentifier: "$DTT", rootTypeName: "DTT", wireFormat: "flatbuffer" };
const PNM = { schemaName: "PNM.fbs", fileIdentifier: "$PNM", rootTypeName: "PNM", wireFormat: "flatbuffer" };

// The adapter with ipfs.add answered by `add(bytes) -> {ok, result}`; every other host op is refused.
async function adapter(add) {
  const instantiate = WebAssembly.instantiate;
  let memory, pending = null;
  WebAssembly.instantiate = async (module, imports) => {
    const host = imports.space_data_module_host;
    const wrapped = { ...imports, space_data_module_host: { ...host,
      call: (opPtr, opLen, ptr, len) => {
        const op = Buffer.from(new Uint8Array(memory.buffer, opPtr, opLen)).toString("utf8");
        const request = Buffer.from(new Uint8Array(memory.buffer, ptr, len));
        const meta = JSON.parse(request.subarray(4, 4 + request.readUInt32LE(0)).toString("utf8"));
        const answer = op === "ipfs.add" ? add(Buffer.from(meta.base64, "base64")) : { ok: false, error: `unexpected ${op}` };
        const json = Buffer.from(JSON.stringify(answer));
        pending = Buffer.concat([Buffer.alloc(4), json]);
        pending.writeUInt32LE(json.length, 0);
        return 0;
      },
      response_len: () => pending.length,
      read_response: (dst, n) => { new Uint8Array(memory.buffer, dst, n).set(pending.subarray(0, n)); return n; },
    } };
    const instance = await instantiate(module, wrapped);
    memory = (instance.instance ?? instance).exports.memory;
    return instance;
  };
  try {
    return await createBrowserModuleHarness({ wasmSource: fs.readFileSync(testWasm), manifest: browserManifest, surface: "direct" });
  } finally {
    WebAssembly.instantiate = instantiate;
  }
}

function names(list) {
  const parts = list.map((name) => {
    const b = new flatbuffers.Builder(128);
    const n = b.createString(name);
    PNM_LIB.PNM.startPNM(b);
    PNM_LIB.PNM.addFileName(b, n);
    PNM_LIB.PNM.finishSizePrefixedPNMBuffer(b, PNM_LIB.PNM.endPNM(b));
    return b.asUint8Array().slice();
  });
  return { portId: "names", typeRef: PNM, payload: Uint8Array.from(Buffer.concat(parts)) };
}
const file = (bytes) => ({ portId: "file", typeRef: DTT, payload: Uint8Array.from(bytes) });
const cidOf = (bytes) => `bafk${createHash("sha256").update(bytes).digest("hex").slice(0, 52)}`;

test("each packed file is added to IPFS and announced as a $PNM with its CID and name", async (t) => {
  const added = [];
  const harness = await adapter((bytes) => { added.push(bytes); return { ok: true, result: { Hash: cidOf(bytes), Size: String(bytes.length) } }; });
  t.after(() => harness.destroy());
  const files = [Buffer.from("root file bytes"), Buffer.from("block 7/1_2 bytes")];
  const response = await harness.invoke({ methodId: "publish_files", inputs: [file(files[0]), file(files[1]), names(["terrain/301/root.dtts", "terrain/301/7/1_2.dtts"])] });
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.deepEqual(added.map((b) => b.toString()), files.map((b) => b.toString()));
  const out = response.outputs.filter((o) => o.portId === "added").map((o) =>
    PNM_LIB.PNM.getSizePrefixedRootAsPNM(new flatbuffers.ByteBuffer(new Uint8Array(o.payload))).unpack());
  assert.deepEqual(out.map((p) => [p.FILE_NAME, p.CID]), [["terrain/301/root.dtts", cidOf(files[0])], ["terrain/301/7/1_2.dtts", cidOf(files[1])]]);
});

test("a refused add, a name that is not a safe relative path, or a names frame that does not match stops the batch", async (t) => {
  const refusing = await adapter(() => ({ ok: false, error: "repo full" }));
  t.after(() => refusing.destroy());
  assert.equal((await refusing.invoke({ methodId: "publish_files", inputs: [file(Buffer.from("x")), names(["terrain/301/root.dtts"])] })).errorCode, "terrain-host-adapter");
  const harness = await adapter((bytes) => ({ ok: true, result: { Hash: cidOf(bytes) } }));
  t.after(() => harness.destroy());
  for (const inputs of [
    [file(Buffer.from("x")), names(["../etc/passwd"])],
    [file(Buffer.from("x")), names(["/terrain/301/root.dtts"])],
    [file(Buffer.from("x")), file(Buffer.from("y")), names(["terrain/301/root.dtts"])],
  ]) {
    const response = await harness.invoke({ methodId: "publish_files", inputs });
    assert.equal(response.errorCode, "terrain-host-adapter");
    assert.equal(response.outputs.filter((o) => o.portId === "added").length, 0, "nothing is announced");
  }
});

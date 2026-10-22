import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { validateArtifactWithStandards } from 'space-data-module-sdk/compliance';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';
import { sealRequest, checkLayout, decodeFileContent } from './lib/wire.mjs';
const wasmPath = fileURLToPath(new URL('../dist/isomorphic/module.wasm', import.meta.url));
const wasmSource = fs.readFileSync(wasmPath);
const manifest = JSON.parse(fs.readFileSync(new URL('../plugin-manifest.json', import.meta.url)));
const standardsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.resolve('spacedatastandards.org'))));

test('published artifact passes SDK standards compliance and has only WASI imports', async () => {
  const report = await validateArtifactWithStandards({ manifest, wasmPath, standardsRoot });
  assert.equal(report.ok, true, JSON.stringify(report.issues));
  const imports = WebAssembly.Module.imports(await WebAssembly.compile(wasmSource));
  assert.ok(imports.every(i => i.module === 'wasi_snapshot_preview1'));
  assert.ok(imports.some(i => i.name === 'random_get'), 'runtime CSPRNG import is mandatory');
  assert.equal(manifest.pluginId, 'com.digitalarsenal.licensing.publication-seal');
  assert.deepEqual(manifest.runtimeTargets, ['browser', 'wasmedge']);
});

test('typed inputs, empty files, validation failures, and fresh randomness', async () => {
  const harness = await createBrowserModuleHarness({ wasmSource, surface: 'direct' });
  const key = randomBytes(32);
  const request = (files = [new Uint8Array()], names = ['empty']) => sealRequest(files, key, 'test', names);
  const invoke = async req => {
    try { return await harness.invoke(req); }
    finally { req.inputs.find(x => x.portId === 'release_key')?.payload.fill(0); }
  };
  const refuse = async req => {
    const r = await invoke(req);
    assert.notEqual(r.statusCode, 0); assert.equal(r.outputs.length, 0);
  };
  try {
    const a = await invoke(request()), b = await invoke(request());
    assert.equal(a.statusCode, 0, a.errorMessage); assert.equal(b.statusCode, 0, b.errorMessage);
    const aBytes = decodeFileContent(a.outputs[0].payload), bBytes = decodeFileContent(b.outputs[0].payload);
    checkLayout(aBytes, 0, 'test/empty');
    assert.notEqual(Buffer.from(aBytes).toString('hex'), Buffer.from(bBytes).toString('hex'), 'separate invocations use fresh entropy');
    await refuse(request([new Uint8Array()], ['a', 'b']));
    await refuse(request([new Uint8Array(), new Uint8Array()], ['a', 'a']));
    await refuse(request([new Uint8Array()], ['']));
    await refuse(sealRequest([new Uint8Array()], new Uint8Array(31), 'test', ['a']));
    await refuse(sealRequest([new Uint8Array()], key, '', ['a']));
    const missing = request(); missing.inputs = missing.inputs.filter(x => x.portId !== 'options'); await refuse(missing);
    const wrong = request(); wrong.inputs[0].typeRef.fileIdentifier = '$KMF'; await refuse(wrong);
  } finally { key.fill(0); await harness.destroy(); }
});

test('missing runtime entropy fails closed, including after one file was staged', async () => {
  const { createBrowserWasiShim } = await import('space-data-module-sdk/host/wasi-shim');
  const { encodePluginInvokeRequest, decodePluginInvokeResponse } = await import('space-data-module-sdk/invoke');
  for (const successfulCalls of [0, 2]) {
    // Fault injection is entirely host-side: the shipped module has only its
    // ordinary WASI random_get import and no entropy override or seed option.
    const shim = createBrowserWasiShim();
    let calls = 0;
    const original = shim.imports.wasi_snapshot_preview1.random_get;
    shim.imports.wasi_snapshot_preview1.random_get = (...args) => calls++ < successfulCalls ? original(...args) : 52;
    const { instance } = await WebAssembly.instantiate(wasmSource, shim.imports);
    const e = instance.exports; shim.setMemory(e.memory); e._initialize();
    const key = randomBytes(32);
    const req = sealRequest([new Uint8Array([1]), new Uint8Array([2])], key, 'entropy-test', ['a', 'b']);
    const encoded = encodePluginInvokeRequest(req);
    const ptr = e.plugin_alloc(encoded.length), lenPtr = e.plugin_alloc(4);
    let resultPtr = 0, resultLength = 0;
    try {
      new Uint8Array(e.memory.buffer, ptr, encoded.length).set(encoded);
      resultPtr = e.plugin_invoke_stream(ptr, encoded.length, lenPtr);
      resultLength = new DataView(e.memory.buffer).getUint32(lenPtr, true);
      const r = decodePluginInvokeResponse(new Uint8Array(e.memory.buffer, resultPtr, resultLength));
      assert.notEqual(r.statusCode, 0);
      assert.equal(r.errorCode, 'entropy-unavailable');
      assert.equal(r.outputs.length, 0, 'no partial batch on late entropy failure');
    } finally {
      new Uint8Array(e.memory.buffer, ptr, encoded.length).fill(0);
      e.plugin_free(ptr, encoded.length); e.plugin_free(lenPtr, 4);
      if (resultPtr) e.plugin_free(resultPtr, resultLength);
      key.fill(0); encoded.fill(0); req.inputs.find(x => x.portId === 'release_key').payload.fill(0);
    }
  }
});

import "../test/manifestContract.test.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { validateArtifactWithStandards } from "space-data-module-sdk";

test("canonical SDK artifact and browser adapter use identical standalone bytes", async () => {
  const wasm = fs.readFileSync(new URL("../dist/isomorphic/module.wasm", import.meta.url));
  assert.deepEqual(wasm, fs.readFileSync(new URL("../dist/browser/module.wasm", import.meta.url)));
  assert.deepEqual(wasm, fs.readFileSync(new URL("../dist/access.wasm", import.meta.url)));
  const module = new WebAssembly.Module(wasm);
  const names = new Set(WebAssembly.Module.exports(module).map((entry) => entry.name));
  for (const name of ["_start", "plugin_invoke_stream", "plugin_alloc", "plugin_free", "plugin_get_manifest_flatbuffer", "plugin_get_manifest_flatbuffer_size"]) assert.ok(names.has(name), name);
  assert.ok(WebAssembly.Module.imports(module).every((entry) => entry.module === "wasi_snapshot_preview1"));
  const manifest = JSON.parse(fs.readFileSync(new URL("../plugin-manifest.json", import.meta.url)));
  const report = await validateArtifactWithStandards({ manifest, wasmBytes: wasm });
  assert.equal(report.ok, true, JSON.stringify(report.issues));
});

// The committed build, as the module catalog will publish it: its embedded $PLG
// names this package. Its behaviour is held to known answers through the same
// artifact in the SDK browser harness by tests/serve.test.mjs.
// The artifact imports the space_data_module_host bridge, which the SDK's
// WasmEdge lanes cannot link, so no tri-runtime lane runs it.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { embeddedPlgManifest } from "space-data-module-sdk/host/runtime-target-gate";

test("the built artifact embeds this manifest's plugin id and version", () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("../plugin-manifest.json", import.meta.url), "utf8"));
  const wasm = fs.readFileSync(new URL("../dist/isomorphic/module.wasm", import.meta.url));
  const embedded = embeddedPlgManifest(new WebAssembly.Module(wasm));
  assert.equal(embedded?.pluginId, manifest.pluginId);
  assert.equal(embedded?.version, manifest.version);
});

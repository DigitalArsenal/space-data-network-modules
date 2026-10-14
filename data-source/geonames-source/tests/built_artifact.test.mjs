// The committed build, as the module catalog will publish it: its embedded $PLG names this package. Its behaviour is
// held to known answers through the same artifact in the SDK browser harness by tests/parse.test.mjs and
// tests/batched_inputs.test.mjs.
//
// On the typed contracts the artifact imports the space_data_module_host bridge (its one hostcall is plugin.getConfig,
// for the geonames_limit record cap that used to ride on the JSON job frame), which the SDK's WasmEdge parity lanes
// cannot link - so, like geonames-ingest and every other module that reads its node config, no tri-runtime lane runs it.
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

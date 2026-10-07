// The committed builds, as the module catalog will publish them: each embedded
// $PLG names the package it was built from. The portable artifact's behaviour in
// browser, native and container WasmEdge is held to known answers by
// tests/parity.test.mjs (SDN_RUN_EPHEMERIS_PARITY=1).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {embeddedPlgManifest} from 'space-data-module-sdk/host/runtime-target-gate';

for (const dir of ['../', '../host-adapter/']) {
  test(`${dir}dist/isomorphic/module.wasm embeds its manifest's plugin id and version`, () => {
    const manifest = JSON.parse(fs.readFileSync(new URL(`${dir}plugin-manifest.json`, import.meta.url), 'utf8'));
    const embedded = embeddedPlgManifest(new WebAssembly.Module(fs.readFileSync(new URL(`${dir}dist/isomorphic/module.wasm`, import.meta.url))));
    assert.equal(embedded?.pluginId, manifest.pluginId);
    assert.equal(embedded?.version, manifest.version);
  });
}

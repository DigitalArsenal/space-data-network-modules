import assert from "node:assert/strict";
import test from "node:test";

import { loadSGP4Plugin, metadata } from "../index.js";

test("sgp4 direct entry loads the shipped wasm module", async (t) => {
  const plugin = await loadSGP4Plugin({ autoInit: true, noInitialRun: true });
  t.after(async () => {
    await plugin.destroy?.();
  });

  assert.equal(plugin.manifest.pluginId, metadata.id);
  assert.equal(typeof plugin.streamInvoke, "function");
  assert.equal(typeof plugin.plugin_init, "function");
});

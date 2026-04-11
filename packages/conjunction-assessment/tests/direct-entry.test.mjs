import assert from "node:assert/strict";
import test from "node:test";

import { createConjunctionAssessmentPlugin, metadata } from "../index.js";

test("conjunction-assessment direct entry loads the shipped wasm module", async (t) => {
  const plugin = await createConjunctionAssessmentPlugin();
  t.after(async () => {
    await plugin.destroy?.();
  });

  assert.equal(plugin.manifest.pluginId, metadata.id);
  assert.equal(typeof plugin.invoke, "function");
  assert.equal(typeof plugin.streamInvoke, "function");
});

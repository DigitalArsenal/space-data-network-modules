import assert from "node:assert/strict";
import test from "node:test";

import { createHPOPPropagator, metadata } from "../index.js";

test("hpop direct entry loads the shipped browser/isomorphic module", async (t) => {
  const plugin = await createHPOPPropagator();
  t.after(async () => {
    await plugin.destroy?.();
  });

  assert.equal(plugin.manifest.pluginId, metadata.id);
  assert.equal(typeof plugin.invoke, "function");
  assert.equal(typeof plugin.streamInvoke, "function");
});

import assert from "node:assert/strict";
import test from "node:test";

import { createViewshedShaderPlugin, metadata } from "../index.js";

test("viewshed-shader direct entry loads and seeds shader sources", async (t) => {
  const plugin = await createViewshedShaderPlugin();
  t.after(async () => {
    await plugin.destroy?.();
  });

  assert.equal(plugin.manifest.pluginId, metadata.id);
  assert.match(plugin.getVertexSource?.() ?? "", /#version 300 es/);
  assert.match(plugin.getFragmentSource?.() ?? "", /precision/);
  assert.equal(typeof plugin.streamInvoke, "function");
});

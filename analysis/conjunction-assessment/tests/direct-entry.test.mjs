import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildWasmEdgeEmscriptenPthreadRunner } from "space-data-module-sdk/testing";
import { createConjunctionAssessmentPlugin, metadata } from "../index.js";

test("conjunction-assessment direct entry loads the shipped pthread wasm module", async (t) => {
  const plugin = await createConjunctionAssessmentPlugin({
    runtimeKind: "wasmedge",
    enableThreads: true,
  });
  t.after(async () => {
    await plugin.destroy?.();
  });

  assert.equal(plugin.manifest.pluginId, metadata.id);
  assert.equal(typeof plugin.invoke, "function");
  assert.equal(typeof plugin.streamInvoke, "function");
});

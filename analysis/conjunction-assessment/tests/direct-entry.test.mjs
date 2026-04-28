import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildWasmEdgeEmscriptenPthreadRunner } from "space-data-module-sdk/testing";
import { createConjunctionAssessmentPlugin, metadata } from "../index.js";

async function buildThreadedWasmEdgeRunner(t) {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "conjunction-direct-entry-runner-"),
  );
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const outputPath = path.join(tempDir, "wasmedge-pthread-runner");
  try {
    return await buildWasmEdgeEmscriptenPthreadRunner({ outputPath });
  } catch (error) {
    if (
      /WasmEdge include|WasmEdge library|not found|startup probe timed out|failed startup probe/i.test(
        String(error),
      )
    ) {
      t.skip("Install a working WasmEdge C API library to verify the pthread direct entry.");
      return null;
    }
    throw error;
  }
}

test("conjunction-assessment direct entry loads the shipped pthread wasm module", async (t) => {
  const runnerBinary = await buildThreadedWasmEdgeRunner(t);
  if (!runnerBinary) {
    return;
  }

  const plugin = await createConjunctionAssessmentPlugin({
    runtimeKind: "wasmedge",
    wasmEdgeRunnerBinary: runnerBinary,
    enableThreads: true,
  });
  t.after(async () => {
    await plugin.destroy?.();
  });

  assert.equal(plugin.manifest.pluginId, metadata.id);
  assert.equal(typeof plugin.invoke, "function");
  assert.equal(typeof plugin.streamInvoke, "function");
});

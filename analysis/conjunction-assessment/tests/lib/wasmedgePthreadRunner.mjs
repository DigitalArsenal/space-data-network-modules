import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildWasmEdgeEmscriptenPthreadRunner } from "space-data-module-sdk/testing";

export async function buildThreadedWasmEdgeRunner(t, prefix) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), prefix));
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
      t.skip("Install a working WasmEdge C API library to verify the pthread runner.");
      return null;
    }
    throw error;
  }
}

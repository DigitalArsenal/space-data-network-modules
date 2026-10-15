/**
 * The module is built with pthreads (wasi-threads) on an imported shared
 * memory: tests instantiate it through the SDK's harness (Node worker_threads
 * for its threads) and read its memory as `x.memory`.
 */
import { createBrowserModuleHarness } from "space-data-module-sdk/host/browser-module";

export async function threadedExports(bytes, options = {}) {
  const harness = await createBrowserModuleHarness({
    wasmSource: bytes,
    surface: "direct",
    maxThreads: options.threads ?? 4,
    wasiThreadPoolSize: options.threads ?? 4,
  });
  return { ...harness.instance.exports, memory: harness.memory, harness };
}

// The Worker of test/browser-pool.e2e.mjs that hosts the module: shared memory with a warm thread pool, driven by the SDK's browser host.
import { createBrowserModuleHarness } from "space-data-module-sdk/host/browser-module";
import { rowsJob, apJob, framesJob } from "./core.mjs";

const fetchBytes = async (url) => new Uint8Array(await (await fetch(url)).arrayBuffer());

self.onmessage = async (e) => {
  const { job, args } = e.data;
  try {
    const meta = await (await fetch("/data/meta.json")).json();
    const wasmSource = await fetchBytes("/module.wasm");
    const threads = args.threads;
    const H = await createBrowserModuleHarness({
      wasmSource, surface: "direct", enableBrowserWasiThreads: threads > 0, maxThreads: Math.max(1, threads),
      ...(threads > 0 ? { wasiThreadPoolSize: threads } : {}),
      wasiThreadWorkerUrl: new URL("/wasi-thread-worker.js", self.location.href).href,
    });
    const x = H.instance.exports;
    const running = threads > 0 ? x.sdnap_threads(threads) : 0;
    const ctx = { H, x, threads, meta, running };
    const result = { crossOriginIsolated: self.crossOriginIsolated, sharedMemory: H.memory.buffer instanceof SharedArrayBuffer, running };
    if (job === "all") {
      result.rows = await rowsJob(ctx, await fetchBytes("/data/rows.bin"), meta.rows);
      result.ap = await apJob(ctx, await fetchBytes("/data/ap.bin"), meta.ap);
      result.frames = await framesJob(ctx, meta.ap, 8);
    }
    self.postMessage({ type: "result", result });
  } catch (err) {
    self.postMessage({ type: "error", error: `${err?.name}: ${err?.message}`, stack: String(err?.stack).split("\n").slice(0, 6).join("\n") });
  }
};
self.postMessage({ type: "booted" });

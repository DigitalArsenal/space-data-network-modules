// The Node host runs separately so the parent can time out a synchronous guest call.
import { parentPort, workerData } from "node:worker_threads";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { rowsJob, apJob, framesJob } from "./core.mjs";
const { threads, wasmPath, rows, apBytes, meta, ROWS, AP } = workerData;
const h = await createStandaloneHarness("browser", wasmPath, { surface: "direct", maxThreads: Math.max(1, threads), enableBrowserWasiThreads: threads > 0 });
try {
  const x = h.instance.exports;
  if (threads > 0 && x.sdnap_threads(threads) !== threads) throw new Error(`Node: sdnap_threads(${threads})`);
  const ctx = { H: h, x, threads, meta }, result = {};
  for (const [name, run] of [
    ["rows", () => rowsJob(ctx, new Uint8Array(rows), ROWS)],
    ["AP and covariance", () => apJob(ctx, new Uint8Array(apBytes), AP)],
    ["frames", () => framesJob(ctx, AP, 500)],
  ]) {
    parentPort.postMessage({ case: name });
    result[name === "AP and covariance" ? "ap" : name] = await run();
  }
  parentPort.postMessage({ result });
} finally { await h.destroy?.(); }

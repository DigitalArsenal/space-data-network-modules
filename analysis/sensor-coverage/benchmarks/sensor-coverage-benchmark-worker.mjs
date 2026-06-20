import { performance } from "node:perf_hooks";
import { parentPort, workerData } from "node:worker_threads";

import {
  createStandaloneHarness,
} from "../../../tests/lib/isomorphicHarness.mjs";
import {
  invokeCoverageBenchmarkRequest,
} from "./sensor-coverage-benchmark.mjs";

const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);

async function runWorkerTasks() {
  const { runtimeKind, requestEntry, tasks } = workerData;
  const harness = await createStandaloneHarness(
    runtimeKind,
    WASM_PATH,
    runtimeKind === "browser" ? { surface: "direct" } : {},
  );
  try {
    const results = [];
    for (const task of tasks) {
      const before = performance.now();
      const outputSummary = await invokeCoverageBenchmarkRequest(harness, {
        scenario: requestEntry.scenario,
        grid: requestEntry.grid,
        mode: requestEntry.mode,
        requestFormat: requestEntry.requestFormat ?? "scv",
        startSeconds: task.window.startSeconds,
        stopSeconds: task.window.stopSeconds,
      });
      results.push({
        index: task.index,
        durationMs: performance.now() - before,
        outputSummary,
      });
    }
    return results;
  } finally {
    await harness.destroy?.();
  }
}

runWorkerTasks()
  .then((results) => {
    parentPort.postMessage({ results });
  })
  .catch((error) => {
    parentPort.postMessage({
      error: {
        message: error.message,
        stack: error.stack,
      },
    });
  });

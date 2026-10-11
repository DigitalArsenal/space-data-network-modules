// Runs a study task over items in worker threads (at most `workers`, never
// more than 6: other lanes share the machine). The task module exports
// `run(item, context)`; results come back in item order.
import os from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function runPool(taskUrl, items, context, { workers = 6, onDone } = {}) {
  const count = Math.max(1, Math.min(workers, 6, items.length));
  const results = new Array(items.length);
  let next = 0, done = 0;
  await Promise.all(Array.from({ length: count }, () => new Promise((resolve, reject) => {
    const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { taskUrl: String(taskUrl), context } });
    const feed = () => {
      if (next >= items.length) { worker.terminate().then(resolve); return; }
      const index = next++;
      worker.postMessage({ index, item: items[index] });
    };
    worker.on('message', (m) => {
      if (m.error) { worker.terminate(); reject(new Error(m.error)); return; }
      results[m.index] = m.result;
      onDone?.(++done, items.length, items[m.index]);
      feed();
    });
    worker.on('error', reject);
    feed();
  })));
  return results;
}

export const loadAverage = () => os.loadavg()[0];

// Pause while the 1-minute load is above `limit` (the archive importer fails
// above ~60; this lane pauses new work at 45).
export async function waitForLoad(limit = 45, log = () => {}) {
  while (loadAverage() > limit) {
    log(`load ${loadAverage().toFixed(1)} > ${limit}: waiting`);
    await new Promise((ok) => setTimeout(ok, 30000));
  }
}

if (!isMainThread) {
  const task = await import(workerData.taskUrl.startsWith('file:') ? workerData.taskUrl : pathToFileURL(workerData.taskUrl).href);
  parentPort.on('message', async ({ index, item }) => {
    try {
      parentPort.postMessage({ index, result: await task.run(item, workerData.context) });
    } catch (e) {
      parentPort.postMessage({ index, error: String(e.stack ?? e) });
    }
  });
}

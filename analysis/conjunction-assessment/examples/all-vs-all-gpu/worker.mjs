// All-vs-all conjunction screening of a whole catalog in a browser, one
// propagator per run, over consecutive time windows (gpu/catalogScreen.mjs).
// The pair search runs on the GPU when WebGPU is available (or unless the page
// asks for cpu), otherwise in the module on the CPU; every reported number
// comes from the conjunction-assessment module (WASM). Runs on a dedicated
// Worker, where the threaded module may block.
//
// Message in:  { propagator: 'sgp4'|'hpop', cpu, wasmUrl, catalogUrl, startJd,
//                durationDays, windowHours, thresholdKm, coarseStepSec, workers,
//                threadWorkerBaseUrl }
// Messages out: { type: 'progress', stage, done, total } ... then
//               { type: 'result', ... } or { type: 'error', message }
import { createConjunctionAssessmentPlugin } from '../../index.js';
import { createGpuScreener } from '../../gpu/gpuScreen.mjs';
import { eventSummary, screenCatalog, screenWindows, splitCatalog } from '../../gpu/catalogScreen.mjs';
import kernelSource from '../../gpu/screen_kernel.wgsl';

// The runner's window file: u32 JSON length, JSON, then each $PRW record as
// u32 length + bytes, every part padded to 8 bytes.
function splitWindow(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pad = (n) => n + ((8 - (n % 8)) % 8);
  const jsonLength = view.getUint32(0, true);
  const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + jsonLength)));
  const frames = [];
  for (let at = pad(4 + jsonLength); at < bytes.length;) {
    const n = view.getUint32(at, true);
    frames.push(bytes.subarray(at + 4, at + 4 + n));
    at = pad(at + 4 + n);
  }
  return { frames, dropped: meta.dropped };
}

async function gpuScreener(cpu) {
  if (cpu || !navigator.gpu) return { screener: null, adapter: 'CPU (module search)' };
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) return { screener: null, adapter: 'CPU (module search; no WebGPU adapter)' };
  const device = await adapter.requestDevice({ requiredLimits: {
    maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize, maxBufferSize: adapter.limits.maxBufferSize } });
  return { screener: createGpuScreener({ device, kernelSource }),
    adapter: adapter.info ? `${adapter.info.vendor} ${adapter.info.architecture}`.trim() : 'WebGPU' };
}

self.onmessage = async ({ data }) => {
  let plugin = null, screener = null;
  const post = (message) => self.postMessage(message);
  try {
    const gpu = await gpuScreener(data.cpu);
    screener = gpu.screener;
    const workers = data.workers ?? Math.max(1, navigator.hardwareConcurrency - 1);
    const wasmBytes = new Uint8Array(await (await fetch(data.wasmUrl)).arrayBuffer());
    plugin = await createConjunctionAssessmentPlugin({ wasmBytes, surface: 'direct', threadCount: workers,
      wasiThreadWorkerBaseUrl: data.threadWorkerBaseUrl });
    const hpop = data.propagator === 'hpop';
    const result = await screenCatalog({
      invoke: (methodId, inputs) => plugin.invoke({ methodId, inputs }),
      propagator: hpop ? 'trajectories' : 'sgp4',
      catalog: hpop ? undefined : splitCatalog(new Uint8Array(await (await fetch(data.catalogUrl)).arrayBuffer())),
      trajectories: hpop ? {
        objects: await (await fetch('objects')).json(),
        window: async (k) => splitWindow(new Uint8Array(await (await fetch(`window/${k}`)).arrayBuffer())),
      } : undefined,
      windows: screenWindows(data.startJd, data.durationDays, data.windowHours),
      controls: { thresholdKm: data.thresholdKm, coarseStepSec: data.coarseStepSec, workers },
      screener,
      onProgress: (stage, done, total) => post({ type: 'progress', stage, done, total }),
    });
    post({
      type: 'result', propagator: data.propagator, adapter: gpu.adapter,
      workers, objects: result.objects, windows: result.windows, candidates: result.candidates, excluded: result.excluded,
      timings: result.timings,
      events: result.events.map(eventSummary).sort((a, b) => a.missM - b.missM),
    });
  } catch (error) {
    post({ type: 'error', message: String(error?.stack ?? error) });
  } finally {
    screener?.destroy();
    await plugin?.destroy?.();
  }
};

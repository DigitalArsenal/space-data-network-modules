// All-vs-all conjunction screening of a whole catalog over consecutive time
// windows, one propagator per run. Refinement and every reported number come
// from the conjunction-assessment module (WASM); the pair search runs on the
// GPU (WebGPU). Runs on a dedicated Worker, where the threaded module may
// block.
//
//   sgp4: the catalog's element sets, loaded once as SGP4 sources; every
//         window screens that index.
//   hpop: each window's trajectories come from the runner's HPOP farm as the
//         $PRW records propagator/hpop exports, loaded through the
//         trajectories port and released after the window.
//
// Message in:  { propagator, wasmUrl, catalogUrl, startJd, durationDays, windowHours,
//                thresholdKm, coarseStepSec, workers, threadWorkerBaseUrl }
// Messages out: { type: 'progress', stage, done, total } ... then
//               { type: 'result', ... } or { type: 'error', message }
import * as flatbuffers from 'flatbuffers';
import {
  CQR, CQRT, CQRDestroyRequestT, CQRIndexRequestT, CQRObjectSourceT, CQRScreeningControlsT, CQRWindowRequestT, OMM,
  PRWInstanceT, RFMCoordinateSystemT, RFMOriginT, TIMInstantT, cqrIndexRepresentation, cqrProbabilityAlgorithm,
  cqrRefinementStrategy, rfmAxisType, rfmOriginKind, timingStandard, timEpochRepresentation,
} from 'spacedatastandards.org/lib/js/CQR/main.js';
import { PRW } from 'spacedatastandards.org/lib/js/PRW/main.js';
import { createConjunctionAssessmentPlugin } from '../../index.js';
import { createGpuScreener } from '../../gpu/gpuScreen.mjs';
import { screenWindowsOnGpu } from '../../gpu/allVsAll.mjs';
import kernelSource from '../../gpu/screen_kernel.wgsl';

const INSTANCE = () => new PRWInstanceT('conjunction-assessment', 'all-vs-all-gpu', 1n);
const CQR_TYPE = { schemaName: 'CQR.fbs', fileIdentifier: '$CQR', rootTypeName: 'CQR', wireFormat: 'flatbuffer' };
const PRW_TYPE = { schemaName: 'PRW.fbs', fileIdentifier: '$PRW', rootTypeName: 'PRW', wireFormat: 'flatbuffer' };

function encode(arm, value) {
  const record = new CQRT();
  record[arm] = value;
  const builder = new flatbuffers.Builder(1 << 20);
  CQR.finishCQRBuffer(builder, record.pack(builder));
  return builder.asUint8Array().slice();
}
const indexRequest = (sources) => encode('INDEX_REQUEST', new CQRIndexRequestT(INSTANCE(), 0, [], 0, [],
  cqrIndexRepresentation.SOURCE_DESCRIPTIONS, cqrRefinementStrategy.EXACT_ONLY, sources));

function windowRequest(handle, frameName, { startJd, durationDays }, { thresholdKm, coarseStepSec, workers }) {
  const controls = new CQRScreeningControlsT(
    new TIMInstantT(timingStandard.UTC, timEpochRepresentation.JULIAN_DATE, startJd),
    durationDays * 86400, thresholdKm * 1000, workers, coarseStepSec);
  controls.ALGORITHM = cqrProbabilityAlgorithm.ALFANO_MAXIMUM;
  const frame = frameName === 'TEME'
    ? new RFMCoordinateSystemT('TEME', rfmAxisType.TRUE_EQUATOR_MEAN_EQUINOX_OF_DATE, new RFMOriginT(rfmOriginKind.CELESTIAL_BODY, 399))
    : new RFMCoordinateSystemT('GCRF', rfmAxisType.ICRF, new RFMOriginT(rfmOriginKind.CELESTIAL_BODY, 399), 399);
  return encode('WINDOW_REQUEST', new CQRWindowRequestT(INSTANCE(), handle, controls, frame));
}

const decodeCatalogResult = (bytes) => CQR.getRootAsCQR(new flatbuffers.ByteBuffer(bytes)).unpack().CATALOG_RESULT;

// A catalog file is $OMM records, each prefixed by its u32 big-endian length.
function splitCatalog(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), frames = [];
  for (let at = 0; at < bytes.length;) {
    const n = view.getUint32(at, false);
    frames.push(bytes.subarray(at + 4, at + 4 + n));
    at += 4 + n;
  }
  return frames;
}

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
  return { meta, frames };
}

const eventSummary = (e) => ({
  primary: e.PRIMARY_NAME, secondary: e.SECONDARY_NAME,
  primaryNorad: e.PRIMARY_NORAD_ID, secondaryNorad: e.SECONDARY_NORAD_ID,
  tcaJd: e.TCA?.JULIAN_DATE, missM: e.MISS_DISTANCE_M, speedMS: e.RELATIVE_SPEED_M_S,
  probability: e.PROBABILITY?.PROBABILITY ?? null,
});

self.onmessage = async ({ data }) => {
  let plugin = null, screener = null;
  const post = (message) => self.postMessage(message);
  try {
    if (!navigator.gpu) throw new Error('WebGPU is not available in this browser.');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter.');
    const device = await adapter.requestDevice({ requiredLimits: {
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize, maxBufferSize: adapter.limits.maxBufferSize } });
    const workers = data.workers ?? Math.max(1, navigator.hardwareConcurrency - 1);
    const wasmBytes = new Uint8Array(await (await fetch(data.wasmUrl)).arrayBuffer());
    plugin = await createConjunctionAssessmentPlugin({ wasmBytes, surface: 'direct', threadCount: workers,
      wasiThreadWorkerBaseUrl: data.threadWorkerBaseUrl });
    screener = createGpuScreener({ device, kernelSource });
    const invoke = (methodId, inputs) => plugin.invoke({ methodId, inputs });
    const prepare = async (sources, trajectories = []) => {
      const response = await invoke('prepare_screening_index', [{ portId: 'request', typeRef: CQR_TYPE, payload: indexRequest(sources) },
        ...trajectories.map((payload) => ({ portId: 'trajectories', typeRef: PRW_TYPE, payload }))]);
      if (response.statusCode !== 0) throw new Error(`prepare_screening_index: ${response.errorCode}: ${response.errorMessage}`);
      return CQR.getRootAsCQR(new flatbuffers.ByteBuffer(response.outputs[0].payload)).unpack().INDEX_RESULT.SCREENING_INDEX_HANDLE;
    };
    const release = (handle) => invoke('destroy_screening_index', [{ portId: 'request', typeRef: CQR_TYPE,
      payload: encode('DESTROY_REQUEST', new CQRDestroyRequestT(INSTANCE(), handle)) }]);

    const t0 = performance.now();
    const hours = data.windowHours, count = Math.ceil((data.durationDays * 24) / hours - 1e-9);
    const windows = Array.from({ length: count }, (_, k) => ({ startJd: data.startJd + (k * hours) / 24,
      durationDays: Math.min(hours, data.durationDays * 24 - k * hours) / 24 }));
    let prepareWindow, objects;
    if (data.propagator === 'sgp4') {
      const omms = splitCatalog(new Uint8Array(await (await fetch(data.catalogUrl)).arrayBuffer()))
        .map((bytes) => OMM.getRootAsOMM(new flatbuffers.ByteBuffer(bytes)).unpack());
      const sources = omms.map((omm, i) => new CQRObjectSourceT(omm.OBJECT_ID || String(omm.NORAD_CAT_ID), omm.OBJECT_NAME,
        omm.NORAD_CAT_ID, null, i + 1, 'sgp4', omm));
      const handle = await prepare(sources);
      const sourceIds = sources.map((s) => s.OBJECT_ID);
      objects = sources.length;
      prepareWindow = async (w) => ({ request: windowRequest(handle, 'TEME', w, { ...data, workers }), sourceIds });
    } else {
      const identity = new Map((await (await fetch('objects')).json()).map((o) => [o.handle, o]));
      objects = identity.size;
      prepareWindow = async (w, k) => {
        const { meta, frames } = splitWindow(new Uint8Array(await (await fetch(`window/${k}`)).arrayBuffer()));
        const sources = frames.map((frame) => {
          const h = PRW.getSizePrefixedRootAsPRW(new flatbuffers.ByteBuffer(frame)).DESCRIBE_RESULT().SOURCES(0).SOURCE_HANDLE();
          const o = identity.get(h);
          return new CQRObjectSourceT(o.objectId, o.name, o.norad, null, h);
        });
        const handle = await prepare(sources, frames);
        return { request: windowRequest(handle, 'GCRF', w, { ...data, workers }), sourceIds: sources.map((s) => s.OBJECT_ID),
          excluded: meta.dropped.map((d) => [d.objectId, d.jd]), release: () => release(handle) };
      };
    }
    const loadMs = performance.now() - t0;
    const result = await screenWindowsOnGpu({
      invoke, decodeCatalogResult, screener, windows, prepareWindow,
      thresholdKm: data.thresholdKm, coarseStepSec: data.coarseStepSec,
      onProgress: (stage, done, total) => post({ type: 'progress', stage, done, total }),
    });
    post({
      type: 'result', propagator: data.propagator,
      adapter: adapter.info ? `${adapter.info.vendor} ${adapter.info.architecture}`.trim() : '',
      workers, objects, windows: result.windows, candidates: result.candidates, excluded: result.excluded,
      timings: { loadMs, ...result.timings, totalMs: performance.now() - t0 },
      events: result.events.map(eventSummary).sort((a, b) => a.missM - b.missM),
    });
  } catch (error) {
    post({ type: 'error', message: String(error?.stack ?? error) });
  } finally {
    screener?.destroy();
    await plugin?.destroy?.();
  }
};

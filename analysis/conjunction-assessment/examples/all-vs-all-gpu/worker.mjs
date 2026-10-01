// All-vs-all conjunction screening of a whole catalog: the catalog loaded once
// as a resident index of SGP4 sources, refinement and every reported number in
// the conjunction-assessment module (WASM), the pair search on the GPU
// (WebGPU). Trajectories from another propagator (PPE) load the same way. Runs on a dedicated Worker, where the threaded
// module may block.
//
// Message in:  { wasmUrl, catalogUrl, startJd, durationDays, thresholdKm, coarseStepSec, workers }
// Messages out: { type: 'progress', stage, done, total } ... then
//               { type: 'result', ... } or { type: 'error', message }
import * as flatbuffers from 'flatbuffers';
import {
  CQR, CQRT, CQRIndexRequestT, CQRObjectSourceT, CQRScreeningControlsT, CQRWindowRequestT, OMM, PRWInstanceT,
  RFMCoordinateSystemT, RFMOriginT, TIMInstantT, cqrIndexRepresentation, cqrProbabilityAlgorithm,
  cqrRefinementStrategy, rfmAxisType, rfmOriginKind, timingStandard, timEpochRepresentation,
} from 'spacedatastandards.org/lib/js/CQR/main.js';
import { createConjunctionAssessmentPlugin } from '../../index.js';
import { createGpuScreener } from '../../gpu/gpuScreen.mjs';
import { screenAllVsAllOnGpu } from '../../gpu/allVsAll.mjs';
import kernelSource from '../../gpu/screen_kernel.wgsl';

const INSTANCE = () => new PRWInstanceT('conjunction-assessment', 'all-vs-all-gpu', 1n);

function encode(arm, value) {
  const record = new CQRT();
  record[arm] = value;
  const builder = new flatbuffers.Builder(1 << 20);
  CQR.finishCQRBuffer(builder, record.pack(builder));
  return builder.asUint8Array().slice();
}

// Every element set as an SGP4 source of one resident index, loaded once.
function indexRequest(catalog) {
  const sources = catalog.map((bytes, i) => {
    const omm = OMM.getRootAsOMM(new flatbuffers.ByteBuffer(bytes)).unpack();
    return new CQRObjectSourceT(omm.OBJECT_ID || String(omm.NORAD_CAT_ID), omm.OBJECT_NAME, omm.NORAD_CAT_ID,
      null, i + 1, 'sgp4', omm);
  });
  return encode('INDEX_REQUEST', new CQRIndexRequestT(INSTANCE(), 0, [], 0, [],
    cqrIndexRepresentation.SOURCE_DESCRIPTIONS, cqrRefinementStrategy.EXACT_ONLY, sources));
}

function windowRequest(handle, { startJd, durationDays, thresholdKm, coarseStepSec, workers }) {
  const controls = new CQRScreeningControlsT(
    new TIMInstantT(timingStandard.UTC, timEpochRepresentation.JULIAN_DATE, startJd),
    durationDays * 86400, thresholdKm * 1000, workers, coarseStepSec);
  controls.ALGORITHM = cqrProbabilityAlgorithm.ALFANO_MAXIMUM;
  const frame = new RFMCoordinateSystemT('TEME', rfmAxisType.TRUE_EQUATOR_MEAN_EQUINOX_OF_DATE,
    new RFMOriginT(rfmOriginKind.CELESTIAL_BODY, 399));
  return encode('WINDOW_REQUEST', new CQRWindowRequestT(INSTANCE(), handle, controls, frame));
}

const decodeCatalogResult = (bytes) =>
  CQR.getRootAsCQR(new flatbuffers.ByteBuffer(bytes)).unpack().CATALOG_RESULT;

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

function eventSummary(e) {
  return {
    primary: e.PRIMARY_NAME, secondary: e.SECONDARY_NAME,
    primaryNorad: e.PRIMARY_NORAD_ID, secondaryNorad: e.SECONDARY_NORAD_ID,
    tcaJd: e.TCA?.JULIAN_DATE, missM: e.MISS_DISTANCE_M, speedMS: e.RELATIVE_SPEED_M_S,
    probability: e.PROBABILITY?.PROBABILITY ?? null,
  };
}

self.onmessage = async ({ data }) => {
  let plugin = null, screener = null;
  const post = (message) => self.postMessage(message);
  try {
    if (!navigator.gpu) throw new Error('WebGPU is not available in this browser.');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter.');
    const device = await adapter.requestDevice({ requiredLimits: {
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize,
    } });
    const [wasmBytes, catalogBytes] = await Promise.all([data.wasmUrl, data.catalogUrl].map(
      async (url) => new Uint8Array(await (await fetch(url)).arrayBuffer())));
    const catalog = splitCatalog(catalogBytes);
    const workers = data.workers ?? Math.max(1, navigator.hardwareConcurrency - 1);
    plugin = await createConjunctionAssessmentPlugin({
      wasmBytes, surface: 'direct', threadCount: workers, wasiThreadWorkerBaseUrl: data.threadWorkerBaseUrl,
    });
    screener = createGpuScreener({ device, kernelSource });
    const t0 = performance.now();
    const typed = (code, payload) => ({ portId: 'request', payload,
      typeRef: { schemaName: `${code}.fbs`, fileIdentifier: `$${code}`, rootTypeName: code, wireFormat: 'flatbuffer' } });
    const prepared = await plugin.invoke({ methodId: 'prepare_screening_index', inputs: [typed('CQR', indexRequest(catalog))] });
    if (prepared.statusCode !== 0) throw new Error(`prepare_screening_index: ${prepared.errorCode}: ${prepared.errorMessage}`);
    const handle = CQR.getRootAsCQR(new flatbuffers.ByteBuffer(prepared.outputs[0].payload)).unpack().INDEX_RESULT.SCREENING_INDEX_HANDLE;
    const indexMs = performance.now() - t0;
    const result = await screenAllVsAllOnGpu({
      invoke: (methodId, inputs) => plugin.invoke({ methodId, inputs }),
      decodeCatalogResult,
      request: windowRequest(handle, { ...data, workers }),
      screener,
      thresholdKm: data.thresholdKm, coarseStepSec: data.coarseStepSec,
      onProgress: (stage, done, total) => post({ type: 'progress', stage, done, total }),
    });
    post({
      type: 'result',
      adapter: adapter.info ? `${adapter.info.vendor} ${adapter.info.architecture}`.trim() : '',
      workers, objects: result.objects, coarseSteps: result.lastStep + 1,
      candidates: result.candidates, refineCalls: result.refineCalls,
      statistics: JSON.parse(JSON.stringify(result.statistics, (_, v) => (typeof v === 'bigint' ? Number(v) : v))),
      timings: { indexMs, ...result.timings, totalMs: performance.now() - t0 },
      events: result.events.map(eventSummary).sort((a, b) => a.missM - b.missM),
    });
  } catch (error) {
    post({ type: 'error', message: String(error?.stack ?? error) });
  } finally {
    screener?.destroy();
    await plugin?.destroy?.();
  }
};

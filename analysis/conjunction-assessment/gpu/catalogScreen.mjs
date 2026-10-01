// One catalog-wide all-vs-all screen over consecutive time windows, one
// propagator per run, for any host: a browser page (with or without WebGPU),
// Node, or WasmEdge as an SDN node runs modules. The host supplies the module
// (invoke), the trajectory source and, if it has a GPU, a screener.
//
//   sgp4: catalog element sets, loaded once as SGP4 sources.
//   trajectories: a propagator module's $PRW DESCRIBE_RESULT records for each
//     window (e.g. propagator/hpop through scripts/lib/hpopFarm.mjs), loaded
//     through prepare_screening_index's trajectories port and released after.
//
// This file builds and moves records; all physics is in the modules.
import * as flatbuffers from 'flatbuffers';
import {
  CQR, CQRT, CQRDestroyRequestT, CQRIndexRequestT, CQRObjectSourceT, CQRScreeningControlsT, CQRWindowRequestT, OMM,
  PRWInstanceT, RFMCoordinateSystemT, RFMOriginT, TIMInstantT, cqrIndexRepresentation, cqrProbabilityAlgorithm,
  cqrRefinementStrategy, cqrUncertaintyOrigin, covarianceCalibration, rfmAxisType, rfmOriginKind, timingStandard,
  timEpochRepresentation,
} from 'spacedatastandards.org/lib/js/CQR/main.js';
import { PRW } from 'spacedatastandards.org/lib/js/PRW/main.js';
import { screenWindowsOnGpu } from './allVsAll.mjs';

const INSTANCE = () => new PRWInstanceT('conjunction-assessment', 'catalog-screen', 1n);
const CQR_TYPE = { schemaName: 'CQR.fbs', fileIdentifier: '$CQR', rootTypeName: 'CQR', wireFormat: 'flatbuffer' };
const PRW_TYPE = { schemaName: 'PRW.fbs', fileIdentifier: '$PRW', rootTypeName: 'PRW', wireFormat: 'flatbuffer' };

function encode(arm, value) {
  const record = new CQRT();
  record[arm] = value;
  const builder = new flatbuffers.Builder(1 << 20);
  CQR.finishCQRBuffer(builder, record.pack(builder));
  return builder.asUint8Array().slice();
}

function windowRequest(handle, frameName, { startJd, durationDays }, { thresholdKm, coarseStepSec, workers, algorithm }) {
  const controls = new CQRScreeningControlsT(
    new TIMInstantT(timingStandard.UTC, timEpochRepresentation.JULIAN_DATE, startJd),
    durationDays * 86400, thresholdKm * 1000, workers, coarseStepSec);
  // A covariance method needs an uncertainty_model (o.uncertaintyModel) for its probability.
  controls.ALGORITHM = cqrProbabilityAlgorithm[algorithm ?? 'ALFANO_MAXIMUM'];
  const frame = frameName === 'TEME'
    ? new RFMCoordinateSystemT('TEME', rfmAxisType.TRUE_EQUATOR_MEAN_EQUINOX_OF_DATE, new RFMOriginT(rfmOriginKind.CELESTIAL_BODY, 399))
    : new RFMCoordinateSystemT('GCRF', rfmAxisType.ICRF, new RFMOriginT(rfmOriginKind.CELESTIAL_BODY, 399), 399);
  return encode('WINDOW_REQUEST', new CQRWindowRequestT(INSTANCE(), handle, controls, frame));
}

export const decodeCatalogResult = (bytes) => CQR.getRootAsCQR(new flatbuffers.ByteBuffer(bytes)).unpack().CATALOG_RESULT;

/** A catalog file: $OMM records, each prefixed by its u32 big-endian length. */
export function splitCatalog(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), frames = [];
  for (let at = 0; at < bytes.length;) {
    const n = view.getUint32(at, false);
    frames.push(bytes.subarray(at + 4, at + 4 + n));
    at += 4 + n;
  }
  return frames;
}

/** Consecutive windows of windowHours covering [startJd, startJd + days]. */
export function screenWindows(startJd, days, windowHours) {
  const count = Math.ceil((days * 24) / windowHours - 1e-9);
  return Array.from({ length: count }, (_, k) => ({ startJd: startJd + (k * windowHours) / 24,
    durationDays: Math.min(windowHours, days * 24 - k * windowHours) / 24 }));
}

export const eventSummary = (e) => ({
  primary: e.PRIMARY_NAME, secondary: e.SECONDARY_NAME,
  primaryNorad: e.PRIMARY_NORAD_ID, secondaryNorad: e.SECONDARY_NORAD_ID,
  tcaJd: e.TCA?.JULIAN_DATE, missM: e.MISS_DISTANCE_M, speedMS: e.RELATIVE_SPEED_M_S,
  probability: e.PROBABILITY?.PROBABILITY ?? null,
  uncertainty: cqrUncertaintyOrigin[e.PROBABILITY?.UNCERTAINTY_SOURCE] ?? null,
  calibration: covarianceCalibration[e.PROBABILITY?.CALIBRATION] ?? null,
});

/**
 * @param {object} o
 * @param {(methodId: string, inputs: object[]) => Promise<object>} o.invoke  The conjunction module.
 * @param {'sgp4'|'trajectories'} o.propagator
 * @param {Uint8Array[]} [o.catalog]  sgp4: one $OMM per object.
 * @param {{objects: {handle: number, objectId: string, name?: string, norad: number}[],
 *          window: (k: number, window: object) => Promise<{frames: Uint8Array[], dropped: {objectId: string, jd: number}[]}>}} [o.trajectories]
 *   trajectories: identities, and each window's $PRW records.
 * @param {object[]} o.windows  From screenWindows.
 * @param {{thresholdKm: number, coarseStepSec: number, workers: number}} o.controls
 * @param {{screenBlock: Function}} [o.screener]  A GPU screener; absent, the module searches on the CPU.
 * @param {Function} [o.onProgress]
 */
export async function screenCatalog(o) {
  const { invoke, controls } = o;
  const prepare = async (sources, trajectories = []) => {
    const response = await invoke('prepare_screening_index', [{ portId: 'request', typeRef: CQR_TYPE,
      payload: encode('INDEX_REQUEST', new CQRIndexRequestT(INSTANCE(), 0, [], 0, [],
        cqrIndexRepresentation.SOURCE_DESCRIPTIONS, cqrRefinementStrategy.EXACT_ONLY, sources)) },
      ...trajectories.map((payload) => ({ portId: 'trajectories', typeRef: PRW_TYPE, payload }))]);
    if (response.statusCode !== 0) throw new Error(`prepare_screening_index: ${response.errorCode}: ${response.errorMessage}`);
    return CQR.getRootAsCQR(new flatbuffers.ByteBuffer(response.outputs[0].payload)).unpack().INDEX_RESULT.SCREENING_INDEX_HANDLE;
  };
  const release = (handle) => invoke('destroy_screening_index', [{ portId: 'request', typeRef: CQR_TYPE,
    payload: encode('DESTROY_REQUEST', new CQRDestroyRequestT(INSTANCE(), handle)) }]);

  const t0 = performance.now();
  let prepareWindow, objects;
  if (o.propagator === 'sgp4') {
    const omms = o.catalog.map((bytes) => OMM.getRootAsOMM(new flatbuffers.ByteBuffer(bytes)).unpack());
    const sources = omms.map((omm, i) => new CQRObjectSourceT(omm.OBJECT_ID || String(omm.NORAD_CAT_ID), omm.OBJECT_NAME,
      omm.NORAD_CAT_ID, null, i + 1, 'sgp4', omm));
    const handle = await prepare(sources);
    const sourceIds = sources.map((s) => s.OBJECT_ID);
    objects = sources.length;
    prepareWindow = async (w) => ({ request: windowRequest(handle, 'TEME', w, controls), sourceIds });
  } else {
    const identity = new Map(o.trajectories.objects.map((x) => [x.handle, x]));
    objects = identity.size;
    prepareWindow = async (w, k) => {
      const { frames, dropped } = await o.trajectories.window(k, w);
      const sources = frames.map((frame) => {
        const h = PRW.getSizePrefixedRootAsPRW(new flatbuffers.ByteBuffer(frame)).DESCRIBE_RESULT().SOURCES(0).SOURCE_HANDLE();
        const x = identity.get(h);
        return new CQRObjectSourceT(x.objectId, x.name, x.norad, null, h);
      });
      const handle = await prepare(sources, frames);
      return { request: windowRequest(handle, 'GCRF', w, controls), sourceIds: sources.map((s) => s.OBJECT_ID),
        excluded: dropped.map((d) => [d.objectId, d.jd]), release: () => release(handle) };
    };
  }
  const loadMs = performance.now() - t0;
  const result = await screenWindowsOnGpu({ invoke, decodeCatalogResult, screener: o.screener, windows: o.windows,
    uncertaintyModel: o.uncertaintyModel,
    prepareWindow, thresholdKm: controls.thresholdKm, coarseStepSec: controls.coarseStepSec, onProgress: o.onProgress });
  return { ...result, objects, timings: { loadMs, ...result.timings, totalMs: performance.now() - t0 } };
}

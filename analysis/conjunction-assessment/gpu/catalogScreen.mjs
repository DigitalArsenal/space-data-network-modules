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

export const INSTANCE = () => new PRWInstanceT('conjunction-assessment', 'catalog-screen', 1n);
const CQR_TYPE = { schemaName: 'CQR.fbs', fileIdentifier: '$CQR', rootTypeName: 'CQR', wireFormat: 'flatbuffer' };
const PRW_TYPE = { schemaName: 'PRW.fbs', fileIdentifier: '$PRW', rootTypeName: 'PRW', wireFormat: 'flatbuffer' };

function encode(arm, value) {
  const record = new CQRT();
  record[arm] = value;
  const builder = new flatbuffers.Builder(1 << 20);
  CQR.finishCQRBuffer(builder, record.pack(builder));
  return builder.asUint8Array().slice();
}

/** The $CQR WINDOW_REQUEST of a window on a resident index (`instance`: the index's). */
export function windowRequest(handle, frameName, { startJd, durationDays }, { thresholdKm, coarseStepSec, workers, algorithm }, instance = INSTANCE()) {
  const controls = new CQRScreeningControlsT(
    new TIMInstantT(timingStandard.UTC, timEpochRepresentation.JULIAN_DATE, startJd),
    durationDays * 86400, thresholdKm * 1000, workers, coarseStepSec);
  // A covariance method needs an uncertainty_model (o.uncertaintyModel) for its probability.
  controls.ALGORITHM = cqrProbabilityAlgorithm[algorithm ?? 'ALFANO_MAXIMUM'];
  const frame = frameName === 'TEME'
    ? new RFMCoordinateSystemT('TEME', rfmAxisType.TRUE_EQUATOR_MEAN_EQUINOX_OF_DATE, new RFMOriginT(rfmOriginKind.CELESTIAL_BODY, 399))
    : new RFMCoordinateSystemT('GCRF', rfmAxisType.ICRF, new RFMOriginT(rfmOriginKind.CELESTIAL_BODY, 399), 399);
  return encode('WINDOW_REQUEST', new CQRWindowRequestT(instance, handle, controls, frame));
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

const PC_METHOD_NAMES = {
  FOSTER: 'FOSTER-2D', PATERA: 'PATERA-2001', ALFANO_MAXIMUM: 'ALFANO-SPHERICAL-SMALL-HBR-MAX',
  CHAN: 'CHAN-1997', ALFRIEND_1999: 'ALFRIEND-1999', ALFRIEND_1999_MAXIMUM: 'ALFRIEND-1999-MAX',
  ALFANO_2005: 'ALFANO-2005', LAAS_2015: 'LAAS-2015', ALFRIEND_2D: 'ALFRIEND-2D',
  'FOSTER-1992': 'FOSTER-2D', 'ALFANO-MAX-PROBABILITY': 'ALFANO-SPHERICAL-SMALL-HBR-MAX',
  'PATERA-LEGACY-POLAR': 'PATERA-2001',
};
const PC_TIER_LABEL = /\busage-violation, (?:below floor|3D-Nc|Monte Carlo)\b/;

// Keep standards probability metadata decoding separate from event identity.
// A fallback's actual method/value and tier live in CDM because the CQR enum
// cannot represent every engine method. Never infer its tier from the Pc.
function probabilitySummary(e) {
  const p = e.PROBABILITY, cdm = e.CONJUNCTION_MESSAGE;
  const uncertainty = cqrUncertaintyOrigin[p?.UNCERTAINTY_SOURCE] ?? null;
  const maximumOnly = uncertainty === 'MAXIMUM_PROBABILITY_ONLY';
  const cdmMethod = cdm?.COLLISION_PROBABILITY_METHOD;
  const encodedMethod = cdmMethod || (maximumOnly ? 'ALFANO_MAXIMUM' : cqrProbabilityAlgorithm[p?.ALGORITHM]);
  const method = PC_METHOD_NAMES[encodedMethod] ?? (cdmMethod || 'PC-UNAVAILABLE');
  // CCSDS diagnostics can occur in relative metadata or either object's
  // COMMENT, following covariance provenance and method-registration text.
  const comments = [cdm?.COMMENT, cdm?.OBJECT1?.COMMENT, cdm?.OBJECT2?.COMMENT].filter(Boolean).join('\n');
  const tier = maximumOnly && !cdmMethod ? 'maximum-only' : comments.match(PC_TIER_LABEL)?.[0] ?? method;
  const error = comments.match(/Collision probability calculation failed:[^\n]*/)?.[0];
  return {
    probability: p?.PROBABILITY ?? null,
    pc: cdmMethod ? cdm.COLLISION_PROBABILITY ?? null : p?.PROBABILITY ?? null,
    method, tier, uncertainty,
    calibration: covarianceCalibration[p?.CALIBRATION] ?? null,
    ...(error ? { error } : {}),
  };
}

export const eventSummary = (e) => ({
  primary: e.PRIMARY_NAME, secondary: e.SECONDARY_NAME,
  primaryNorad: e.PRIMARY_NORAD_ID, secondaryNorad: e.SECONDARY_NORAD_ID,
  tcaJd: e.TCA?.JULIAN_DATE, missM: e.MISS_DISTANCE_M, speedMS: e.RELATIVE_SPEED_M_S,
  ...probabilitySummary(e),
});

/**
 * @param {object} o
 * @param {(methodId: string, inputs: object[]) => Promise<object>} o.invoke  The conjunction module.
 * @param {'sgp4'|'trajectories'} o.propagator
 * @param {Uint8Array[]} [o.catalog]  sgp4: one $OMM per object.
 * @param {{objects: {handle: number, objectId: string, name?: string, norad: number}[],
 *          window: (k: number, window: object) => Promise<{frames: Uint8Array[], dropped: {objectId: string, norad: number, jd: number}[]}>}} [o.trajectories]
 *   trajectories: identities, and each window's $PRW records.
 * @param {object[]} o.windows  From screenWindows.
 * @param {{thresholdKm: number, coarseStepSec: number, workers: number}} o.controls
 * @param {{screenBlock: Function}} [o.screener]  A GPU screener; absent, the module searches on the CPU.
 * @param {Function} [o.onProgress]
 */
/** The prepare_screening_index inputs for the sources (and, for trajectories, the propagator's $PRW records). */
export const indexInputs = (sources, trajectories = [], instance = INSTANCE()) => [{ portId: 'request', typeRef: CQR_TYPE,
  payload: encode('INDEX_REQUEST', new CQRIndexRequestT(instance, 0, [], 0, [],
    cqrIndexRepresentation.SOURCE_DESCRIPTIONS, cqrRefinementStrategy.EXACT_ONLY, sources)) },
  ...trajectories.map((payload) => ({ portId: 'trajectories', typeRef: PRW_TYPE, payload }))];

/** A resident index of the sources (and, for trajectories, the propagator's $PRW records); its handle. */
export async function prepareIndex(invoke, sources, trajectories = [], instance = INSTANCE()) {
  const response = await invoke('prepare_screening_index', indexInputs(sources, trajectories, instance));
  if (response.statusCode !== 0) throw new Error(`prepare_screening_index: ${response.errorCode}: ${response.errorMessage}`);
  return CQR.getRootAsCQR(new flatbuffers.ByteBuffer(response.outputs[0].payload)).unpack().INDEX_RESULT.SCREENING_INDEX_HANDLE;
}

export const releaseIndex = (invoke, handle, instance = INSTANCE()) => invoke('destroy_screening_index', [{ portId: 'request',
  typeRef: CQR_TYPE, payload: encode('DESTROY_REQUEST', new CQRDestroyRequestT(instance, handle)) }]);

/** SGP4 sources of catalog $OMM records, handles 1..n in catalog order. */
export function sgp4Sources(catalog) {
  return catalog.map((bytes, i) => {
    const omm = OMM.getRootAsOMM(new flatbuffers.ByteBuffer(bytes)).unpack();
    return new CQRObjectSourceT(omm.OBJECT_ID || String(omm.NORAD_CAT_ID), omm.OBJECT_NAME, omm.NORAD_CAT_ID, null, i + 1, 'sgp4', omm);
  });
}

export async function screenCatalog(o) {
  const { invoke, controls } = o;
  const prepare = (sources, trajectories) => prepareIndex(invoke, sources, trajectories);
  const release = (handle) => releaseIndex(invoke, handle);

  const t0 = performance.now();
  let prepareWindow, objects;
  if (o.propagator === 'sgp4') {
    const sources = sgp4Sources(o.catalog);
    const handle = await prepare(sources);
    const identities = sources.map((s) => [s.OBJECT_ID, s.NORAD_CATALOG_ID]);
    objects = sources.length;
    prepareWindow = async (w) => ({ request: windowRequest(handle, 'TEME', w, controls), objects: identities });
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
      return { request: windowRequest(handle, 'GCRF', w, controls), objects: sources.map((s) => [s.OBJECT_ID, s.NORAD_CATALOG_ID]),
        excluded: dropped.map((d) => [d.objectId, d.norad, d.jd]), release: () => release(handle) };
    };
  }
  const loadMs = performance.now() - t0;
  const result = await screenWindowsOnGpu({ invoke, decodeCatalogResult, screener: o.screener, windows: o.windows,
    uncertaintyModel: o.uncertaintyModel,
    prepareWindow, thresholdKm: controls.thresholdKm, coarseStepSec: controls.coarseStepSec, onProgress: o.onProgress });
  return { ...result, objects, timings: { loadMs, ...result.timings, totalMs: performance.now() - t0 } };
}

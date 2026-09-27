// Test transport helpers. Every schema is resolved from the pinned published SDS
// package. Physics and frame/time-scale conversion are performed by the guest.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { FlatcRunner } from 'flatc-wasm';

export const SDS_ROOT = path.dirname(createRequire(import.meta.url).resolve('spacedatastandards.org/package.json'));
const cache = new Map();
export function publishedSchema(code) {
  if (cache.has(code)) return cache.get(code);
  const files = {};
  function read(relative) {
    const name = path.posix.normalize(relative);
    const key = `/sds/${name}`;
    if (files[key]) return;
    const source = fs.readFileSync(path.join(SDS_ROOT, 'schema', name), 'utf8');
    files[key] = source;
    for (const match of source.matchAll(/include\s+"([^"]+)"/g)) {
      read(path.posix.join(path.posix.dirname(name), match[1]));
    }
  }
  read(`${code}/main.fbs`);
  const schema = { entry: `/sds/${code}/main.fbs`, files };
  cache.set(code, schema);
  return schema;
}
export const cqrSchema = () => publishedSchema('CQR');
let flatcPromise;
export const initCqrFlatc = () => flatcPromise ??= FlatcRunner.init();
export function encodeCqr(flatc, record) {
  return flatc.generateBinary(cqrSchema(), JSON.stringify(record), { sizePrefix: false });
}
export function decodeCqr(flatc, bytes) {
  return JSON.parse(flatc.generateJSON(cqrSchema(), { path: '/cqr.bin', data: bytes }, { defaultsJson: true }));
}
export const utcJd = JULIAN_DATE => ({ TIME_SYSTEM: 'UTC', EPOCH_FORMAT: 'JULIAN_DATE', JULIAN_DATE });
export function earthFrame(name = 'TEME') {
  return { NAME: name, AXIS_TYPE: ({ TEME: 'TRUE_EQUATOR_MEAN_EQUINOX_OF_DATE', TEMEOFDATE: 'TRUE_EQUATOR_MEAN_EQUINOX_OF_DATE', GCRF: 'ICRF', ICRF: 'ICRF', EME2000: 'MEAN_EQUATOR_EQUINOX_J2000', J2000: 'MEAN_EQUATOR_EQUINOX_J2000' })[name] ?? name, ORIGIN: { KIND: 'CELESTIAL_BODY', CELESTIAL_BODY_ID: 399 } };
}
export function screeningControls(o = {}) {
  return {
    START_EPOCH: o.START_EPOCH ?? utcJd(o.startJd),
    DURATION_SECONDS: o.durationSeconds ?? (o.durationDays ?? 7) * 86400,
    THRESHOLD_M: o.thresholdM ?? (o.thresholdKm ?? 5) * 1000,
    REQUESTED_WORKERS: o.numThreads ?? 1,
    COARSE_STEP_SECONDS: o.coarseStepSec ?? 60,
    REFINEMENT_TOLERANCE_SECONDS: o.fineTolSec ?? .001,
    COMBINED_RADIUS_M: o.combinedRadiusM ?? 10,
    USE_KD_TREE: o.useKdTree ?? true,
    USE_DYNAMIC_WINDOW: o.useDynamicWindow ?? true,
    USE_PERIGEE_FILTER: o.usePerigeeFilter ?? true,
  };
}
export function sourceProvenance(s) {
  const origin = { OMM: 'OMM_RECORD', OCM: 'OCM_RECORD', OEM: 'OEM_RECORD', CDM: 'CDM_RECORD', FLATSQL_QUERY: 'QUERY_SELECTION', PNM: 'PUBLICATION', PUBSUB: 'PUBSUB_TOPIC' };
  return Object.fromEntries(Object.entries({ ORIGIN_CLASS: origin[s.sourceKind] ?? 'UNSPECIFIED', SOURCE_ID: s.sourceId, PROVIDER_ID: s.providerId, SCHEMA_NAME: s.schemaName, FILE_IDENTIFIER: s.fileIdentifier, QUERY: s.query, QUERY_HASH: s.queryHash, PNM_CID: s.pnmCid, MANIFEST_CID: s.manifestCid, TOPIC: s.topic }).filter(([, v]) => v != null));
}
export function gpRecord(g) {
  const keys = { objectName: 'OBJECT_NAME', objectId: 'OBJECT_ID', epoch: 'EPOCH', meanMotion: 'MEAN_MOTION', eccentricity: 'ECCENTRICITY', inclination: 'INCLINATION', raOfAscNode: 'RA_OF_ASC_NODE', argOfPericenter: 'ARG_OF_PERICENTER', meanAnomaly: 'MEAN_ANOMALY', classificationType: 'CLASSIFICATION_TYPE', noradCatId: 'NORAD_CAT_ID', elementSetNo: 'ELEMENT_SET_NO', revAtEpoch: 'REV_AT_EPOCH', bstar: 'BSTAR', meanMotionDot: 'MEAN_MOTION_DOT', meanMotionDdot: 'MEAN_MOTION_DDOT' };
  const out = Object.fromEntries(Object.entries(g).map(([k,v])=>[keys[k] ?? k,v]));
  delete out.ephemerisType;
  out.EPHEMERIS_TYPE = 'SGP4';
  out.CENTER_NAME ??= 'EARTH';
  out.REFERENCE_FRAME ??= { REFERENCE_FRAME_type: 'CelestialFrameWrapper', REFERENCE_FRAME: { frame: 'TEMEOFDATE' } };
  out.TIME_SYSTEM ??= 'UTC';
  out.MEAN_ELEMENT_THEORY ??= 'SGP4';
  return out;
}
export function gpSource(g) {
  const record = gpRecord(g);
  return { OBJECT_ID: record.OBJECT_ID || String(record.NORAD_CAT_ID), OBJECT_NAME: record.OBJECT_NAME, NORAD_CATALOG_ID: Number(record.NORAD_CAT_ID), PROPAGATOR_PORT_ID: 'sgp4', MEAN_ELEMENTS: record };
}
export function tleSource(t) {
  return { OBJECT_ID: t.name || t.line1?.slice(2,7).trim() || 'tle-object', OBJECT_NAME: t.name, PROPAGATOR_PORT_ID: 'sgp4', TLE_LINES: { NAME: t.name, LINE1: t.line1, LINE2: t.line2 } };
}
// Existing numerical fixture samples are UTC Julian dates in km and km/s.
// This serializes their timestamps as OEM UTC text; it never transforms frames.
export function trackSource(t) {
  if (t?.EPHEMERIS || t?.COMPREHENSIVE_ORBIT || t?.POLYNOMIAL_EPHEMERIS || t?.MEAN_ELEMENTS) return t;
  const frame = t.referenceFrame ?? t.reference_frame;
  if (!frame || frame === 'UNKNOWN') throw new TypeError('A sampled source requires an explicit reference frame.');
  const celestial = frame === 'TEME' ? 'TEMEOFDATE' : frame;
  const objectId = t.objectId ?? t.object_id ?? String(t.noradCatId ?? t.norad_cat_id ?? t.norad_id);
  const objectName = t.objectName ?? t.object_name;
  return { OBJECT_ID: objectId, OBJECT_NAME: objectName, NORAD_CATALOG_ID: Number(t.noradCatId ?? t.norad_cat_id ?? t.norad_id ?? 0), EPHEMERIS: { EPHEMERIS_DATA_BLOCK: [{ CENTER_NAME: 'EARTH', CENTER_NAIF_ID: 399, REFERENCE_FRAME: { REFERENCE_FRAME_type: 'CelestialFrameWrapper', REFERENCE_FRAME: { frame: celestial } }, TIME_SYSTEM: 'UTC', EPHEMERIS_DATA_LINES: t.samples.map(s => ({ EPOCH: s.EPOCH ?? new Date(((s.jd ?? s.epochJD ?? s.epoch_jd) - 2440587.5) * 86400000).toISOString(), X: s.xKm ?? s.x_km ?? s.x, Y: s.yKm ?? s.y_km ?? s.y, Z: s.zKm ?? s.z_km ?? s.z, X_DOT: s.vxKmS ?? s.vx_km_s ?? s.vx, Y_DOT: s.vyKmS ?? s.vy_km_s ?? s.vy, Z_DOT: s.vzKmS ?? s.vz_km_s ?? s.vz })) }] } };
}
export function pairRequest(o) {
  return { PAIR_REQUEST: { PRIMARY: o.PRIMARY ?? (o.primaryTrack ? trackSource(o.primaryTrack) : tleSource(o.tle1)), SECONDARY: o.SECONDARY ?? (o.secondaryTrack ? trackSource(o.secondaryTrack) : tleSource(o.tle2)), CONTROLS: o.CONTROLS ?? screeningControls(o), PRIMARY_RADIUS_M: o.radius1M ?? 5, SECONDARY_RADIUS_M: o.radius2M ?? 5, EVALUATION_FRAME: o.EVALUATION_FRAME ?? earthFrame(o.primaryTrack?.referenceFrame ?? o.primaryTrack?.reference_frame ?? 'TEME') } };
}
export function catalogRequest(o) {
  const out = { PRIMARIES: [...(o.primaryGps ?? []).map(gpSource), ...(o.primaryTracks ?? []).map(trackSource), ...(o.primaryTles ?? []).map(tleSource)], SECONDARIES: [...(o.secondaryGps ?? []).map(gpSource), ...(o.secondaryTracks ?? []).map(trackSource), ...(o.secondaryTles ?? []).map(tleSource)], CONTROLS: screeningControls(o), EVALUATION_FRAME: o.EVALUATION_FRAME ?? earthFrame(o.primaryTracks?.[0]?.referenceFrame ?? 'TEME'), SELECTED_SOURCES: (o.selectedSources ?? []).map(sourceProvenance) };
  for (const [oldKey,key] of Object.entries({ orderedCatalogIndices: 'ORDERED_CATALOG_INDICES', startOrderIndex: 'START_ORDER_INDEX', endOrderIndex: 'END_ORDER_INDEX', secondaryStartOrderIndex: 'SECONDARY_START_ORDER_INDEX', secondaryEndOrderIndex: 'SECONDARY_END_ORDER_INDEX' })) {
    if (o[oldKey] != null) { out[key] = o[oldKey]; if (key !== 'ORDERED_CATALOG_INDICES') out[`HAS_${key}`] = true; }
  }
  return { CATALOG_REQUEST: out };
}
// Test-only projection into historical oracle units; authoritative fixture data
// uses km/km/s and UTC JD. No scientific quantity is computed here.
export function eventInReferenceUnits(e) {
  return { obj1Name: e.PRIMARY_NAME, obj1Id: e.PRIMARY_ID, obj1Norad: e.PRIMARY_NORAD_ID, obj2Name: e.SECONDARY_NAME, obj2Id: e.SECONDARY_ID, obj2Norad: e.SECONDARY_NORAD_ID, tcaJd: e.TCA.JULIAN_DATE, tcaIso: e.TCA.ISO8601, minRangeKm: e.MISS_DISTANCE_M / 1000, relSpeedKms: e.RELATIVE_SPEED_M_S / 1000, maxProbability: e.PROBABILITY?.MAXIMUM_PROBABILITY || e.PROBABILITY?.PROBABILITY || 0, probabilityMethod: e.PROBABILITY?.ALGORITHM };
}
// FlatBuffers stores no vector for an empty one: a catalog chunk that found no
// conjunctions decodes without EVENTS, which the object API reads as length 0.
export function catalogInReferenceUnits(r) {
  return { objectsParsed: r.OBJECTS_PARSED, conjunctionsFound: r.CONJUNCTIONS_FOUND, conjunctions: (r.EVENTS ?? []).map(eventInReferenceUnits), stats: { totalObjects: r.STATISTICS?.TOTAL_OBJECTS, pairsScreened: r.STATISTICS?.PAIRS_SCREENED, failedPairs: r.STATISTICS?.FAILED_PAIRS } };
}

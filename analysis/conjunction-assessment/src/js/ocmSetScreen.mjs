// The $OCM element-set screen (README, "$OCM element sets: each set flies on its own theory"): a host flow that flies
// each SGP4XP or AP $OCM on its own theory through propagator/sdn-ap `propagate` (one record a call, the window's
// instants as the $PCF OUTPUT.EPOCHS), gives the $OEM it returns to screen_catalog as that object's EPHEMERIS source beside the SGP4 $OMM sets
// (MEAN_ELEMENTS sources, the built-in SGP4), drains the chunks and returns the events. The pattern of
// flows/observation-ap/flow.mjs: the hosts are SDK module hosts with invoke({ methodId, inputs }); this file routes
// typed records and computes nothing. Any theory but SGP4XP and AP is refused by name before any flight, and a set
// sdn-ap refuses is refused with its code and message unchanged; the other sets screen.
import * as flatbuffers from 'flatbuffers';
import {
  CQR, CQRT, CQRCatalogRequest, CQRObjectSourceT, CQRScreeningControlsT, OCM, OEM, OMM, RFMCoordinateSystemT, RFMOriginT,
  TIMInstantT, cqrProbabilityAlgorithm, meanElementSource, rfmAxisType, rfmOriginKind, timingStandard, timEpochRepresentation,
} from 'spacedatastandards.org/lib/js/CQR/main.js';
import { PCFT, PCFOutputT, pcfOutputFrame } from 'spacedatastandards.org/lib/js/PCF/main.js';

/** The flight of a set: from the window start to the first step at or after its end, at this step, in TEME (the theory's frame). */
export const OCM_SET_FLIGHT = Object.freeze({ stepSeconds: 30, frame: 'TEME' });

/** The theories the flow flies through propagator/sdn-ap; every other one is refused by name. */
export const FLOWN_THEORIES = Object.freeze([meanElementSource.SGP4XP, meanElementSource.AP]);

const T = (name) => ({ schemaName: `${name}.fbs`, fileIdentifier: `$${name}`, rootTypeName: name, wireFormat: 'flatbuffer' });
const ident = (u, at) => String.fromCharCode(...u.subarray(at, at + 4));
const bytesOf = (x) => (x instanceof Uint8Array ? x : new Uint8Array(x));
let frames = 0x0c40000n;   // distinct input frame ids: a drain continues one request, and concurrent drains must differ

/** A record's root by its file identifier at offset 4 (plain) or 8 (size-prefixed), else null. */
function root(u, id, plain, prefixed) {
  if (u.length >= 8 && ident(u, 4) === id) return plain(new flatbuffers.ByteBuffer(u));
  if (u.length >= 12 && ident(u, 8) === id) return prefixed(new flatbuffers.ByteBuffer(u));
  return null;
}

/** The set's identity and theory, read from its $OCM: OBJECT_ID as index.js's adapters take it. */
function readSet(payload) {
  const u = bytesOf(payload);
  const ocm = root(u, '$OCM', OCM.getRootAsOCM, OCM.getSizePrefixedRootAsOCM);
  if (!ocm) return { payload: u, code: `not-ocm:${u.length >= 8 ? ident(u, 4).replace(/[^\x20-\x7e]/g, '?') : ''}` };
  const meta = ocm.METADATA(), elements = ocm.MEAN_ELEMENTS();
  const norad = meta?.NORAD_CAT_ID() ?? 0;
  const objectId = meta?.INTERNATIONAL_DESIGNATOR() || meta?.OBJECT_DESIGNATOR() || String(norad);
  const theory = elements ? elements.MEAN_ELEMENT_THEORY() : null;
  return { payload: u, objectId, name: meta?.OBJECT_NAME() ?? null, norad, theory, theoryName: theory == null ? 'NONE' : (meanElementSource[theory] ?? String(theory)) };
}

/** The instants of a flight: the window start, every step, to the first instant at or after the window end (UTC ISO 8601). */
export function flightEpochs({ startJd, durationDays }, stepSeconds = OCM_SET_FLIGHT.stepSeconds) {
  const startMs = Math.round((startJd - 2440587.5) * 86400000);
  const steps = Math.ceil(durationDays * 86400 / stepSeconds - 1e-9);
  return Array.from({ length: steps + 1 }, (_, k) => new Date(startMs + k * stepSeconds * 1000).toISOString());
}

/**
 * The $PCF of a flight: OUTPUT.EPOCHS the flight's instants (flightEpochs), in TEME; THEORY unspecified reads the set's
 * own. A record's weather rows bound its flight (sdn-ap flies a RECORDS set from the day after its first row), so the
 * flight never starts before the window; the module takes a coverage edge as a sample. EPOCHS, not START_TIME and
 * STOP_TIME: for explicit epochs sdn-ap writes the block the OEM schema's rules name for explicit lines (STEP_SIZE 0, a
 * line per epoch), which this module reads; its START_TIME/STOP_TIME form writes STEP_SIZE with the lines, the schema's
 * compact form, which this module refuses as an invalid compact grid.
 */
export function flightConfiguration(window, stepSeconds = OCM_SET_FLIGHT.stepSeconds) {
  const c = new PCFT();
  c.OUTPUT = new PCFOutputT(pcfOutputFrame.TEME, stepSeconds, 500000, flightEpochs(window, stepSeconds));
  const b = new flatbuffers.Builder(256);
  b.finish(c.pack(b), '$PCF');
  return b.asUint8Array().slice();
}

/**
 * The screen's CATALOG_REQUEST: the sources all-vs-all (PRIMARIES, no SECONDARIES), the caller's controls, TEME. The
 * table is written field by field: the object API writes an empty ORDERED_CATALOG_INDICES vector, which screen_catalog
 * reads as a catalog range (invalid-catalog-order); an inline request carries none.
 */
export function catalogRequest(sources, { startJd, durationDays }, controls) {
  const c = new CQRScreeningControlsT(new TIMInstantT(timingStandard.UTC, timEpochRepresentation.JULIAN_DATE, startJd),
    durationDays * 86400, controls.thresholdKm * 1000, controls.workers ?? 1, controls.coarseStepSec ?? 60,
    controls.fineTolSec ?? 0.001, controls.combinedRadiusM ?? 10);
  c.ALGORITHM = cqrProbabilityAlgorithm[controls.algorithm ?? 'FOSTER'];
  if (c.ALGORITHM === undefined) throw new Error(`unknown probability algorithm ${controls.algorithm}`);
  const teme = new RFMCoordinateSystemT('TEME', rfmAxisType.TRUE_EQUATOR_MEAN_EQUINOX_OF_DATE, new RFMOriginT(rfmOriginKind.CELESTIAL_BODY, 399));
  const record = new CQRT();
  record.CATALOG_REQUEST = { pack(b) {
    const primaries = CQRCatalogRequest.createPrimariesVector(b, b.createObjectOffsetList(sources));
    const controlsAt = c.pack(b), frameAt = teme.pack(b);
    CQRCatalogRequest.startCQRCatalogRequest(b);
    CQRCatalogRequest.addPrimaries(b, primaries);
    CQRCatalogRequest.addControls(b, controlsAt);
    CQRCatalogRequest.addEvaluationFrame(b, frameAt);
    return CQRCatalogRequest.endCQRCatalogRequest(b);
  } };
  const b = new flatbuffers.Builder(1 << 16);
  CQR.finishCQRBuffer(b, record.pack(b));
  return b.asUint8Array().slice();
}

/** An $OEM as the EPHEMERIS source of the object it was flown for. */
export function ephemerisSource(set, oemPayload) {
  const u = bytesOf(oemPayload);
  const oem = root(u, '$OEM', OEM.getRootAsOEM, OEM.getSizePrefixedRootAsOEM);
  if (!oem) throw new Error(`propagate returned no $OEM for ${set.objectId}`);
  return new CQRObjectSourceT(set.objectId, set.name, set.norad, null, 0, null, null, oem.unpack());
}

/** An SGP4 $OMM as a MEAN_ELEMENTS source: the built-in SGP4 (gpu/catalogScreen.mjs sgp4Sources, one record). */
export function sgp4Source(payload) {
  const u = bytesOf(payload);
  const omm = root(u, '$OMM', OMM.getRootAsOMM, OMM.getSizePrefixedRootAsOMM)?.unpack();
  if (!omm) throw new Error('catalog: a record is not an $OMM');
  return new CQRObjectSourceT(omm.OBJECT_ID || String(omm.NORAD_CAT_ID), omm.OBJECT_NAME, omm.NORAD_CAT_ID, null, 0, 'sgp4', omm);
}

/** screen_catalog on one request, drained to FINAL_CHUNK: its events, excluded records and statistics. */
export async function drainCatalogScreen(conjunction, request, extra = []) {
  const frameId = ++frames;
  const inputs = [{ portId: 'request', typeRef: T('CQR'), payload: request, frameId }, ...extra];
  const events = [], excluded = [];
  for (;;) {
    const r = await conjunction.invoke({ methodId: 'screen_catalog', inputs });
    if (r.statusCode !== 0) throw new Error(`screen_catalog: ${r.errorCode}: ${r.errorMessage}`);
    for (const o of r.outputs ?? []) if (o.portId === 'excluded') excluded.push(bytesOf(o.payload));
    const result = CQR.getRootAsCQR(new flatbuffers.ByteBuffer(bytesOf(r.outputs.find((o) => o.portId === 'result').payload))).unpack().CATALOG_RESULT;
    events.push(...(result.EVENTS ?? []));
    if (result.FINAL_CHUNK) return { events, excluded, statistics: result.STATISTICS, objectsParsed: result.OBJECTS_PARSED, conjunctionsFound: result.CONJUNCTIONS_FOUND };
  }
}

/**
 * @param {{conjunction: {invoke: Function}, sdnAp: {invoke: Function}}} hosts  SDK module hosts of this module and propagator/sdn-ap.
 * @param {object} o
 * @param {Uint8Array[]} o.sets  $OCM element sets (SGP4XP, AP), plain or size-prefixed, one object each.
 * @param {Uint8Array[]} [o.catalog]  $OMM SGP4 sets, plain or size-prefixed: the built-in SGP4.
 * @param {{startJd: number, durationDays: number}} o.window  UTC Julian date and days.
 * @param {{thresholdKm: number, coarseStepSec?: number, workers?: number, algorithm?: string, fineTolSec?: number, combinedRadiusM?: number}} o.controls
 * @param {Uint8Array} [o.uncertaintyModel]  $ERM for the element sets the module flies itself (screen_catalog's uncertainty_model).
 * @returns {Promise<{events: object[], excluded: Uint8Array[], refused: object[], statistics: object, flights: number}>}
 *   refused: one entry per set left out, by name: { objectId, name, norad, theory, code, message }.
 */
export async function screenOcmSets(hosts, o) {
  const sources = [], refused = [];
  const configuration = flightConfiguration(o.window);
  let flights = 0;
  for (const payload of o.sets ?? []) {
    const set = readSet(payload);
    if (set.code) { refused.push({ objectId: null, name: null, norad: 0, theory: 'NONE', code: set.code, message: 'A set on sets must be an $OCM.' }); continue; }
    if (!FLOWN_THEORIES.includes(set.theory)) {
      refused.push({ objectId: set.objectId, name: set.name, norad: set.norad, theory: set.theoryName, code: `theory-not-screened:${set.theoryName}`,
        message: `MEAN_ELEMENT_THEORY ${set.theoryName}: the $OCM path flies SGP4XP and AP through propagator/sdn-ap; an SGP4 set is an $OMM on catalog.` });
      continue;
    }
    flights++;
    const r = await hosts.sdnAp.invoke({ methodId: 'propagate', inputs: [{ portId: 'ocm', typeRef: T('OCM'), payload: set.payload },
      { portId: 'configuration', typeRef: T('PCF'), payload: configuration }] });
    if (r.statusCode !== 0) { refused.push({ objectId: set.objectId, name: set.name, norad: set.norad, theory: set.theoryName, code: r.errorCode ?? 'propagate-failed', message: r.errorMessage ?? '' }); continue; }
    sources.push(ephemerisSource(set, r.outputs.find((x) => x.portId === 'ephemeris')?.payload ?? new Uint8Array()));
  }
  for (const payload of o.catalog ?? []) sources.push(sgp4Source(payload));
  const extra = o.uncertaintyModel ? [{ portId: 'uncertainty_model', typeRef: T('ERM'), payload: o.uncertaintyModel }] : [];
  const screen = await drainCatalogScreen(hosts.conjunction, catalogRequest(sources, o.window, o.controls), extra);
  return { ...screen, refused, flights };
}

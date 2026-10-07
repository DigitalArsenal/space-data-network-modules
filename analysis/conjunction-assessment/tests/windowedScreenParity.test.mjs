// A long screen run as consecutive time windows (gpu/allVsAll.mjs
// screenWindowsOnGpu) reports what one screen of the whole span reports, for
// one propagator's output per run.
//
// SGP4: fixtures/decaying/gp_2026-07-06.json (see coarseExclusion.test.mjs),
// 2026-07-06T00:00Z for one day, against four 6 h windows over the same
// resident index. One object SGP4 cannot propagate on that day is excluded
// for the whole span: none of its earlier conjunctions survive.
//
// HPOP: fixtures/hpop-ppe/crossing-orbits.json (propagator/hpop
// conjunction-screening PPE, GCRF, TDB), 2026-09-30T23:45Z UTC for 0.11 day,
// against four windows. Each window loads only the PPE intervals within 20
// minutes of it, forwarded as the size-prefixed $PRW DESCRIBE_RESULT records a
// propagator exports (built by flatc-wasm's generateBinary, which runs flatc
// --size-prefixed, as HPOP's FinishSizePrefixed builds them), through
// prepare_screening_index's trajectories port; the request's sources then
// carry identity only.
//
// The candidate search proposes every pair at every step, so the module's
// f64 test decides every candidate. Events must match pair for pair, TCAs
// within 10 ms and misses within 10 cm (tests/lib/caParityTolerances.mjs).
// An index that mixes mean elements with a trajectory is refused.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { createConjunctionCommandHarness } from './lib/conjunctionCommandHarness.mjs';
import { decodeCqr, earthFrame, encodeCqr, gpSource, initCqrFlatc, publishedSchema, screeningControls } from './lib/cqr.mjs';
import { CA_PARITY_TOLERANCES as T } from './lib/caParityTolerances.mjs';
import { parseGridFrame } from '../gpu/gpuScreen.mjs';
import { screenAllVsAllOnGpu, screenWindowsOnGpu } from '../gpu/allVsAll.mjs';

const fixture = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const GP = fixture('decaying/gp_2026-07-06.json');
const HPOP = fixture('hpop-ppe/crossing-orbits.json');
const STEP_S = 60, THRESHOLD_KM = 5;

const flatc = await initCqrFlatc();
const decodeCatalogResult = (bytes) => decodeCqr(flatc, bytes).CATALOG_RESULT;
const request = (record) => ({ portId: 'request', payload: encodeCqr(flatc, record) });
const PRW_TYPE = { schemaName: 'PRW.fbs', fileIdentifier: '$PRW', rootTypeName: 'PRW', wireFormat: 'flatbuffer' };
const everyPair = {
  async screenBlock(frame) {
    const { objects, firstStep, stepCount } = parseGridFrame(frame);
    const triples = [];
    for (let s = 0; s < stepCount; s++) for (let i = 0; i < objects; i++) for (let j = i + 1; j < objects; j++) triples.push(i, j, firstStep + s);
    return { triples: Uint32Array.from(triples), gpuMs: 0 };
  },
};

let generation = 0;
const INSTANCE = () => ({ MODULE_ID: 'conjunction-assessment', INSTANCE_ID: 'windowed', GENERATION: ++generation });
const controls = (startJd, durationDays) => ({
  ...screeningControls({ startJd, durationDays, numThreads: 2, coarseStepSec: STEP_S, thresholdKm: THRESHOLD_KM }),
  ALGORITHM: 'ALFANO_MAXIMUM',
});
async function prepare(harness, instance, sources, trajectories = []) {
  const response = await harness.invoke({ methodId: 'prepare_screening_index', inputs: [
    request({ INDEX_REQUEST: { INSTANCE: instance, INDEX_CONTENT: 'SOURCE_DESCRIPTIONS', REFINEMENT_MODE: 'EXACT_ONLY', SOURCES: sources } }),
    ...trajectories.map((payload) => ({ portId: 'trajectories', typeRef: PRW_TYPE, payload }))] });
  return response;
}
const windowRequest = (instance, handle, startJd, durationDays, frame) => encodeCqr(flatc, { WINDOW_REQUEST: {
  INSTANCE: instance, SCREENING_INDEX_HANDLE: handle, CONTROLS: controls(startJd, durationDays), EVALUATION_FRAME: earthFrame(frame) } });
const handleOf = (response) => {
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  return decodeCqr(flatc, response.outputs[0].payload).INDEX_RESULT.SCREENING_INDEX_HANDLE;
};
const common = (harness) => ({ invoke: (methodId, inputs) => harness.invoke({ methodId, inputs }), decodeCatalogResult,
  screener: everyPair, thresholdKm: THRESHOLD_KM, coarseStepSec: STEP_S });
const quarters = (startJd, days) => [0, 1, 2, 3].map((k) => ({ startJd: startJd + (k * days) / 4, durationDays: days / 4 }));

const pairOf = (e) => [e.PRIMARY_NORAD_ID, e.SECONDARY_NORAD_ID].sort((a, b) => a - b).join('-');
function assertSameEvents(actual, expected, label) {
  const order = (list) => [...list].sort((a, b) => pairOf(a).localeCompare(pairOf(b)) || a.TCA.JULIAN_DATE - b.TCA.JULIAN_DATE);
  const a = order(actual), e = order(expected);
  assert.deepEqual(a.map(pairOf), e.map(pairOf), `${label}: pairs`);
  for (let k = 0; k < e.length; k++) {
    assert.ok(Math.abs(a[k].TCA.JULIAN_DATE - e[k].TCA.JULIAN_DATE) * 86400 <= T.tca.NLRV.hardFailSec, `${label} ${pairOf(e[k])}: TCA`);
    assert.ok(Math.abs(a[k].MISS_DISTANCE_M - e[k].MISS_DISTANCE_M) <= T.missDistance.aerospaceHardFailM, `${label} ${pairOf(e[k])}: miss`);
  }
}

test('SGP4: four 6 h windows report the one-day screen, exclusion included', async () => {
  const harness = await createConjunctionCommandHarness({ runtimeKind: 'browser' });
  try {
    const startJd = Date.parse('2026-07-06T00:00:00Z') / 86400000 + 2440587.5;
    const instance = INSTANCE();
    const sources = GP.map((g, i) => ({ ...gpSource(g), SOURCE_HANDLE: i + 1 }));
    const handle = handleOf(await prepare(harness, instance, sources));
    const whole = await screenAllVsAllOnGpu({ ...common(harness), request: windowRequest(instance, handle, startJd, 1, 'TEME') });
    assert.ok(whole.events.length > 0 && whole.excluded.length > 0);
    const windowed = await screenWindowsOnGpu({ ...common(harness), windows: quarters(startJd, 1),
      prepareWindow: async (w) => ({ request: windowRequest(instance, handle, w.startJd, w.durationDays, 'TEME'), sourceIds: sources.map((s) => s.OBJECT_ID) }) });
    assertSameEvents(windowed.events, whole.events, 'windows');
    assert.deepEqual(windowed.excluded.map(([id]) => id).sort(), whole.excluded.map(([i]) => sources[i].OBJECT_ID).sort());
  } finally {
    await harness.destroy?.();
  }
});

test('HPOP: four windows of forwarded PRW trajectories report the single-window screen', async () => {
  const harness = await createConjunctionCommandHarness({ runtimeKind: 'browser' });
  try {
    const startJd = 2461314.5 - 15 / 1440, days = 0.11;
    const identity = HPOP.sources.map(({ OBJECT_ID, OBJECT_NAME, NORAD_CATALOG_ID, SOURCE_HANDLE }) => ({ OBJECT_ID, OBJECT_NAME, NORAD_CATALOG_ID, SOURCE_HANDLE }));
    // A propagator's export for one window: its intervals within 20 minutes
    // of the window (TDB epochs; 20 minutes dwarfs TDB - UTC).
    const tdbJd = (iso) => Date.parse(`${iso.slice(0, 23)}Z`) / 86400000 + 2440587.5;
    const exportWindow = (w) => HPOP.sources.map((s) => {
      const margin = 20 / 1440;
      const records = s.POLYNOMIAL_EPHEMERIS.POSITION_RECORDS.filter((r) =>
        tdbJd(r.EPOCH_MID) + r.EPOCH_HALF_SPAN / 86400 >= w.startJd - margin &&
        tdbJd(r.EPOCH_MID) - r.EPOCH_HALF_SPAN / 86400 <= w.startJd + w.durationDays + margin);
      return flatc.generateBinary(publishedSchema('PRW'), JSON.stringify({ DESCRIBE_RESULT: {
        INSTANCE: { MODULE_ID: 'com.orbpro.hpop', INSTANCE_ID: 'fixture', GENERATION: 1 }, SEGMENT_SET_HANDLE: 1,
        SOURCES: [{ SOURCE_HANDLE: s.SOURCE_HANDLE, OBJECT_ID: s.OBJECT_ID, EPHEMERIS: { ...s.POLYNOMIAL_EPHEMERIS, POSITION_RECORDS: records } }] } }), { sizePrefix: true });
    });

    const instance = INSTANCE();
    const wholeHandle = handleOf(await prepare(harness, instance, identity, exportWindow({ startJd, durationDays: days })));
    const whole = await screenAllVsAllOnGpu({ ...common(harness), request: windowRequest(instance, wholeHandle, startJd, days, 'GCRF') });
    assert.ok(whole.events.length >= 6, `${whole.events.length} conjunctions`);

    const windowed = await screenWindowsOnGpu({ ...common(harness), windows: quarters(startJd, days),
      prepareWindow: async (w) => {
        const handle = handleOf(await prepare(harness, instance, identity, exportWindow(w)));
        return { request: windowRequest(instance, handle, w.startJd, w.durationDays, 'GCRF'), sourceIds: identity.map((s) => s.OBJECT_ID),
          release: () => harness.invoke({ methodId: 'destroy_screening_index', inputs: [request({ DESTROY_REQUEST: { INSTANCE: instance, SCREENING_INDEX_HANDLE: handle } })] }) };
      } });
    assertSameEvents(windowed.events, whole.events, 'windows');
    assert.equal(windowed.excluded.length, 0);

    const mixed = await prepare(harness, INSTANCE(), [{ ...gpSource(GP[0]), SOURCE_HANDLE: 99 }, identity[0]], exportWindow({ startJd, durationDays: days }).slice(0, 1));
    assert.equal(mixed.errorCode, 'mixed-propagators', mixed.errorMessage);
  } finally {
    await harness.destroy?.();
  }
});

// Sampled states in the SpaceAware console's shape (prepare_sample_screening_
// index: TEME OEM compact grids, 60 s, cubic Hermite, one primary; 30 min
// windows, 1000 km, 10 s coarse step). Two circular TEME orbits, ISS-like
// (a 6798 km, i 51.64 deg) and CSS-like (a 6765 km, i 41.47 deg), on one node
// line, both at the ascending node at 2026-10-09T15:14:50Z: uniform circular
// motion, r = a (cos u P + sin u Q), u = n (t - t0), n = sqrt(mu / a^3),
// mu = 398600.4418 km^3/s^2. Their mean motions differ by 8.3e-6 rad/s, so
// for about five hours either side of that pass every node passage, half an
// orbit apart, is a local minimum of the range within 1000 km.
//
// The reference minima are found here on the same samples with the same
// cubic Hermite interpolation of position the module applies between them
// (ephemeris_source.cpp OEMEphemerisSource::state_at): the range at 1 s, each
// sample below both neighbours refined by golden section to 1 microsecond.
// Every module TCA must match one within 10 ms (T.tca.NLRV.hardFailSec) and
// its miss within 1 m, and a window edge must never be reported: the minima a
// day of 30 min windows reports are the minima the whole day holds, each once
// when the windows abut; console windows overlapping by the coarse step
// report a minimum in an overlap twice, with the same TCA.
test('Sampled TEME tracks (console shape): every minimum within the threshold, once, whatever the windows', async () => {
  const MU = 398600.4418, STEP_S = 60, THRESHOLD_KM = 1000, DEG = Math.PI / 180;
  const JD_UNIX = 2440587.5, jdOf = (iso) => Date.parse(iso) / 86400000 + JD_UNIX;
  const t0 = jdOf('2026-10-09T15:14:50Z'), gridStart = '2026-10-08T23:00:00Z', count = 26 * 60 + 1;
  const orbit = (a, iDeg, raanDeg) => {
    const n = Math.sqrt(MU / a ** 3), i = iDeg * DEG, raan = raanDeg * DEG;
    const P = [Math.cos(raan), Math.sin(raan), 0];
    const Q = [-Math.sin(raan) * Math.cos(i), Math.cos(raan) * Math.cos(i), Math.sin(i)];
    const data = [];
    for (let k = 0; k < count; k++) {
      const u = n * ((jdOf(gridStart) - t0) * 86400 + k * STEP_S);
      for (let c = 0; c < 3; c++) data.push(a * (Math.cos(u) * P[c] + Math.sin(u) * Q[c]));
      for (let c = 0; c < 3; c++) data.push(a * n * (-Math.sin(u) * P[c] + Math.cos(u) * Q[c]));
    }
    return data;
  };
  const tracks = [{ handle: 17588, id: '1998-067A', name: 'ISS-LIKE', norad: 25544, data: orbit(6798, 51.64, 100) },
    { handle: 20543, id: '2021-035A', name: 'CSS-LIKE', norad: 48274, data: orbit(6765, 41.47, 100) }];

  // The reference: cubic Hermite on [x, v] at 60 s nodes, scanned and
  // refined in seconds of the day (a Julian date resolves only 40 us).
  const day = jdOf('2026-10-09T00:00:00Z'), gridOffsetSec = (day - jdOf(gridStart)) * 86400;
  const position = (data, sec) => {
    const s = (sec + gridOffsetSec) / STEP_S, k = Math.min(Math.max(Math.floor(s), 0), count - 2), t = s - k;
    const h00 = 2 * t ** 3 - 3 * t ** 2 + 1, h10 = t ** 3 - 2 * t ** 2 + t, h01 = -2 * t ** 3 + 3 * t ** 2, h11 = t ** 3 - t ** 2;
    return [0, 1, 2].map((c) => h00 * data[6 * k + c] + h10 * STEP_S * data[6 * k + 3 + c]
      + h01 * data[6 * (k + 1) + c] + h11 * STEP_S * data[6 * (k + 1) + 3 + c]);
  };
  const range = (sec) => {
    const a = position(tracks[0].data, sec), b = position(tracks[1].data, sec);
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  };
  const reference = [];
  for (let s = -60; s <= 86460; s++) {
    if (!(range(s) < range(s - 1) && range(s) <= range(s + 1))) continue;
    let lo = s - 1, hi = s + 1;
    const g = (Math.sqrt(5) - 1) / 2;
    while (hi - lo > 1e-6) {
      const c = hi - g * (hi - lo), d = lo + g * (hi - lo);
      if (range(c) < range(d)) hi = d; else lo = c;
    }
    const sec = (lo + hi) / 2;
    if (sec >= 0 && sec < 86400 && range(sec) <= THRESHOLD_KM) reference.push({ sec, miss: range(sec) });
  }
  assert.ok(reference.length >= 10, `${reference.length} reference minima within ${THRESHOLD_KM} km`);
  assert.ok(Math.min(...reference.map((m) => m.miss)) < 100);

  const harness = await createConjunctionCommandHarness({ runtimeKind: 'browser' });
  try {
    const instance = { MODULE_ID: 'conjunction-assessment', INSTANCE_ID: 'spaceaware-console', GENERATION: ++generation };
    const prepared = await harness.invoke({ methodId: 'prepare_sample_screening_index', inputs: [request({ INDEX_REQUEST: {
      INSTANCE: instance, INDEX_CONTENT: 'SAMPLED_STATES', REFINEMENT_MODE: 'EXACT_ONLY', PRIMARY_SOURCE_HANDLES: [17588],
      SOURCES: tracks.map((x) => ({ OBJECT_ID: x.id, OBJECT_NAME: x.name, NORAD_CATALOG_ID: x.norad, SOURCE_HANDLE: x.handle,
        EPHEMERIS: { EPHEMERIS_DATA_BLOCK: [{ CENTER_NAME: 'EARTH', CENTER_NAIF_ID: 399,
          REFERENCE_FRAME: { REFERENCE_FRAME_type: 'CelestialFrameWrapper', REFERENCE_FRAME: { frame: 'TEMEOFDATE' } },
          TIME_SYSTEM: 'UTC', START_TIME: `${gridStart.slice(0, 19)}.000Z`, INTERPOLATION: 'HERMITE', INTERPOLATION_DEGREE: 3,
          STEP_SIZE: STEP_S, STATE_VECTOR_SIZE: 6, EPHEMERIS_DATA: x.data }] } })) } })] });
    const handle = handleOf(prepared);
    const screen = async (start, durationDays) => {
      const response = await harness.invoke({ methodId: 'screen_window', inputs: [request({ WINDOW_REQUEST: {
        INSTANCE: instance, SCREENING_INDEX_HANDLE: handle, EVALUATION_FRAME: earthFrame('TEME'), CONTROLS: {
          ...screeningControls({ startJd: start, durationDays, coarseStepSec: 10, thresholdKm: THRESHOLD_KM }), ALGORITHM: 'ALFANO_MAXIMUM' } } })] });
      assert.equal(response.statusCode, 0, response.errorMessage);
      const result = decodeCatalogResult(response.outputs[0].payload);
      assert.equal(result.FINAL_CHUNK, true);
      assert.equal(result.STATISTICS.FAILED_PAIRS, 0);
      return (result.EVENTS ?? []).map((e) => ({ tca: e.TCA.JULIAN_DATE, miss: e.MISS_DISTANCE_M / 1000, pair: `${e.PRIMARY_ID}-${e.SECONDARY_ID}` }));
    };
    const whole = await screen(day, 1);
    assert.equal(whole.length, reference.length, `whole day: ${whole.length} module, ${reference.length} reference minima`);
    whole.forEach((e, k) => {
      assert.equal(e.pair, '1998-067A-2021-035A');
      const dt = (e.tca - day) * 86400 - reference[k].sec;
      assert.ok(Math.abs(dt) <= T.tca.NLRV.hardFailSec, `minimum ${k}: TCA ${dt} s`);
      assert.ok(Math.abs(e.miss - reference[k].miss) * 1000 <= 1, `minimum ${k}: miss ${(e.miss - reference[k].miss) * 1000} m`);
    });

    // 30 min windows over the day with an edge 3 s before the closest
    // approach, so that minimum sits just past an abutting edge and inside
    // the 10 s overlap of two console windows.
    const closest = reference.reduce((a, b) => (b.miss < a.miss ? b : a));
    const halfHour = 1800, edgeSec = closest.sec - 3, firstSec = (edgeSec % halfHour) - halfHour;
    const inDay = (events) => events.filter((e) => e.tca >= day && e.tca < day + 1);
    const abutting = [], overlapping = [];
    for (let k = 0; firstSec + k * halfHour < 86400; k++) {
      const start = day + (firstSec + k * halfHour) / 86400;
      abutting.push(...await screen(start, halfHour / 86400));
      overlapping.push(...await screen(start, (halfHour + 10) / 86400));
    }
    assert.deepEqual(inDay(abutting), whole, 'abutting windows report each minimum once, as the whole day does');
    assert.ok(inDay(overlapping).length > whole.length, 'a minimum inside an overlap is in both windows');
    const once = [...new Map(inDay(overlapping).map((e) => [e.tca, e])).values()];
    assert.deepEqual(once, whole, 'overlapping windows repeat a minimum only with the same TCA');
  } finally {
    await harness.destroy?.();
  }
});

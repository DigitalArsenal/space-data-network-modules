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
// propagator exports (built by flatc --size-prefixed, as HPOP's
// FinishSizePrefixed builds them), through prepare_screening_index's
// trajectories port; the request's sources then carry identity only.
//
// The candidate search proposes every pair at every step, so the module's
// f64 test decides every candidate. Events must match pair for pair, TCAs
// within 10 ms and misses within 10 cm (tests/lib/caParityTolerances.mjs).
// An index that mixes mean elements with a trajectory is refused.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { createConjunctionCommandHarness } from './lib/conjunctionCommandHarness.mjs';
import { decodeCqr, earthFrame, encodeCqr, generateSizePrefixed, gpSource, initCqrFlatc, publishedSchema, screeningControls } from './lib/cqr.mjs';
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
      return generateSizePrefixed(flatc, publishedSchema('PRW'), { DESCRIBE_RESULT: {
        INSTANCE: { MODULE_ID: 'com.orbpro.hpop', INSTANCE_ID: 'fixture', GENERATION: 1 }, SEGMENT_SET_HANDLE: 1,
        SOURCES: [{ SOURCE_HANDLE: s.SOURCE_HANDLE, OBJECT_ID: s.OBJECT_ID, EPHEMERIS: { ...s.POLYNOMIAL_EPHEMERIS, POSITION_RECORDS: records } }] } });
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

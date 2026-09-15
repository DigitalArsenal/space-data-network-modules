import assert from 'node:assert/strict';
import test from 'node:test';
import { createConjunctionCommandHarness } from './lib/conjunctionCommandHarness.mjs';
import { initCqrFlatc, encodeCqr, decodeCqr, earthFrame, screeningControls } from './lib/cqr.mjs';

// Independent rectilinear family in Earth-centered GCRF, UTC 2026-03-09:
// object i has x=7000+0.1*i km, y=-i+(7.5+0.1*i)*t km.
// Every distinct pair reaches TCA at t=10 s, with miss 100*|i-j| m and
// speed 100*|i-j| m/s. These are constant-velocity kinematics, not propagated
// orbital reference values. Source: OpenStax University Physics vol.1 §3.3:
// https://openstax.org/books/university-physics-volume-1/pages/3-3-average-and-instantaneous-acceleration
// .01 s / .001 m / .005 m/s tolerances cover Julian-date and Hermite rounding.
// A 20 s interval can differ by one 40.3 microsecond JD ULP; at the maximum
// 1600 m/s relative speed that contributes <=.0033 m/s derivative error.
function linearSource(i) {
  const x = 7000 + .1 * i;
  const y = -i;
  const velocity = 7.5 + .1 * i;
  return { OBJECT_ID: `S${String(i).padStart(2, '0')}`, SOURCE_HANDLE: i + 1,
    EPHEMERIS: { EPHEMERIS_DATA_BLOCK: [{ CENTER_NAME: 'EARTH',
      REFERENCE_FRAME: { REFERENCE_FRAME_type: 'CelestialFrameWrapper', REFERENCE_FRAME: { frame: 'GCRF' } },
      TIME_SYSTEM: 'UTC', START_TIME: '2026-03-09T00:00:00Z', STOP_TIME: '2026-03-09T00:00:20Z',
      INTERPOLATION: 'Hermite', STEP_SIZE: 20, STATE_VECTOR_SIZE: 6,
      EPHEMERIS_DATA: [x, y, 0, 0, velocity, 0, x, y + velocity * 20, 0, 0, velocity, 0] }] } };
}
const controls = () => screeningControls({ startJd: 2461108.5, durationSeconds: 20, coarseStepSec: 1 });
function verifyEvent(event) {
  const spacing = Math.abs(Number(event.SECONDARY_ID.slice(1)) - Number(event.PRIMARY_ID.slice(1)));
  assert.ok(Math.abs((event.TCA.JULIAN_DATE - 2461108.5) * 86400 - 10) <= .01);
  assert.ok(Math.abs(event.MISS_DISTANCE_M - 100 * spacing) <= .001);
  assert.ok(Math.abs(event.RELATIVE_SPEED_M_S - 100 * spacing) <= .005);
}

test('CQR sampled primary selection includes primary-primary pairs and excludes secondary-secondary pairs', async (t) => {
  const flatc = await initCqrFlatc();
  const harness = await createConjunctionCommandHarness({ runtimeKind: 'browser' });
  t.after(() => harness.destroy());
  const INSTANCE = { MODULE_ID: 'conjunction-assessment', INSTANCE_ID: 'selected-linear-sources', GENERATION: 1 };
  const invoke = (methodId, value) => harness.invoke({ methodId, inputs: [{ portId: 'request', payload: encodeCqr(flatc, value) }] });
  const prepared = await invoke('prepare_sample_screening_index', { INDEX_REQUEST: {
    INSTANCE, INDEX_CONTENT: 'SAMPLED_STATES', REFINEMENT_MODE: 'EXACT_ONLY',
    SOURCES: [0, 1, 2, 3].map(linearSource), PRIMARY_SOURCE_HANDLES: [1, 2],
  } });
  assert.equal(prepared.statusCode, 0, prepared.errorMessage);
  const index = decodeCqr(flatc, prepared.outputs[0].payload).INDEX_RESULT;
  assert.equal(index.SOURCE_COUNT, 4);
  assert.equal(index.CANDIDATE_PAIR_COUNT, 5); // 2*2 + choose(2,2)
  const response = await invoke('screen_window', { WINDOW_REQUEST: {
    INSTANCE, SCREENING_INDEX_HANDLE: index.SCREENING_INDEX_HANDLE,
    CONTROLS: controls(), EVALUATION_FRAME: earthFrame('GCRF'),
  } });
  assert.equal(response.statusCode, 0, response.errorMessage);
  const result = decodeCqr(flatc, response.outputs[0].payload).CATALOG_RESULT;
  assert.equal(result.STATISTICS.PAIRS_SCREENED, 5);
  assert.equal(result.STATISTICS.FAILED_PAIRS, 0);
  assert.deepEqual(result.EVENTS.map(event => `${event.PRIMARY_ID}-${event.SECONDARY_ID}`).sort(),
    ['S00-S01', 'S00-S02', 'S00-S03', 'S01-S02', 'S01-S03']);
  result.EVENTS.forEach(verifyEvent);
});

test('CQR drains bounded deterministic chunks with a cap of one and reports failed evaluations', async (t) => {
  const flatc = await initCqrFlatc();
  const harness = await createConjunctionCommandHarness({ runtimeKind: 'browser' });
  t.after(() => harness.destroy());
  const valid = Array.from({ length: 17 }, (_, i) => linearSource(i));
  const invalid = linearSource(17);
  // A finite 1e200 km coordinate is serializable binary64 but its squared
  // distance overflows binary64 (IEEE 754:2019 §7.4 overflow). Every pair
  // involving this source must report failure; it has no physical oracle.
  // https://doi.org/10.1109/IEEESTD.2019.8766229
  invalid.EPHEMERIS.EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA[0] = 1e200;
  invalid.EPHEMERIS.EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA[6] = 1e200;
  const request = sources => encodeCqr(flatc, { CATALOG_REQUEST: {
    PRIMARIES: sources, CONTROLS: controls(), EVALUATION_FRAME: earthFrame('GCRF'),
  } });
  // The current SDK exposes TAB.FRAME_ID to handlers, so overlapping drains
  // carry distinct input frame IDs. PIV TRACE_ID is independently echoed.
  const goodPayload = request(valid), failedPayload = request([...valid, invalid]);
  const invoke = (payload, frameId, traceId) => harness.invoke({ methodId: 'screen_catalog',
    traceId, outputStreamCap: 1, inputs: [{ portId: 'request', payload, frameId }] });
  const goodFirst = await invoke(goodPayload, 200n, 21n);
  const failedFirst = await invoke(failedPayload, 400n, 22n);
  for (const [response, failed] of [[goodFirst, 0], [failedFirst, 17]]) {
    assert.equal(response.statusCode, 0, response.errorMessage);
    assert.equal(response.outputs.length, 1);
    assert.equal(response.yielded, true);
    assert.equal(response.backlogRemaining, 1);
    assert.equal(response.outputs[0].sequence, 0n);
    assert.equal(response.outputs[0].endOfStream, false);
    const result = decodeCqr(flatc, response.outputs[0].payload).CATALOG_RESULT;
    assert.equal(result.EVENT_OFFSET, 0);
    assert.equal(result.FINAL_CHUNK, false);
    assert.equal(result.EVENTS.length, 128);
    assert.equal(result.CONJUNCTIONS_FOUND, 136);
    assert.equal(result.STATISTICS.PAIRS_SCREENED, failed ? 153 : 136);
    assert.equal(result.STATISTICS.FAILED_PAIRS, failed);
  }
  const goodFinal = await invoke(goodPayload, 200n, 21n);
  const failedFinal = await invoke(failedPayload, 400n, 22n);
  assert.equal(goodFinal.statusCode, 0, goodFinal.errorMessage);
  assert.notEqual(failedFinal.statusCode, 0);
  assert.equal(failedFinal.errorCode, 'incomplete-screening');
  assert.equal(goodFinal.traceId, 21n);
  assert.equal(failedFinal.traceId, 22n);
  for (const [first, last, failed] of [[goodFirst, goodFinal, 0], [failedFirst, failedFinal, 17]]) {
    assert.equal(last.outputs.length, 1);
    assert.equal(last.yielded, false);
    assert.equal(last.backlogRemaining, 0);
    assert.equal(last.outputs[0].sequence, 1n);
    assert.equal(last.outputs[0].endOfStream, true);
    const end = decodeCqr(flatc, last.outputs[0].payload).CATALOG_RESULT;
    assert.equal(end.EVENT_OFFSET, 128);
    assert.equal(end.FINAL_CHUNK, true);
    assert.equal(end.EVENTS.length, 8);
    assert.equal(end.STATISTICS.FAILED_PAIRS, failed);
    const events = [...decodeCqr(flatc, first.outputs[0].payload).CATALOG_RESULT.EVENTS, ...end.EVENTS];
    assert.equal(new Set(events.map(event => `${event.PRIMARY_ID}-${event.SECONDARY_ID}`)).size, 136);
    events.forEach(verifyEvent);
  }
  assert.deepEqual(decodeCqr(flatc, goodFirst.outputs[0].payload).CATALOG_RESULT.EVENTS,
    decodeCqr(flatc, failedFirst.outputs[0].payload).CATALOG_RESULT.EVENTS);
  assert.deepEqual(decodeCqr(flatc, goodFinal.outputs[0].payload).CATALOG_RESULT.EVENTS,
    decodeCqr(flatc, failedFinal.outputs[0].payload).CATALOG_RESULT.EVENTS);
});

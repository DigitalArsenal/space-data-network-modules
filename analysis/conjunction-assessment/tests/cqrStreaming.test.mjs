import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import * as flatbuffers from 'flatbuffers';
import { createConjunctionCommandHarness } from './lib/conjunctionCommandHarness.mjs';
import { initCqrFlatc, encodeCqr, decodeCqr, earthFrame, screeningControls, gpRecord, publishedSchema } from './lib/cqr.mjs';

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

test('CQR rejects time controls below the binary64 Julian-date resolution', async (t) => {
  const flatc = await initCqrFlatc();
  const harness = await createConjunctionCommandHarness({ runtimeKind: 'browser' });
  t.after(() => harness.destroy());
  // IEEE 754 binary64 has 53 significant binary digits; a Julian date near
  // 2461108.5 has ULP 2^-31 day (~40.23 microseconds). A 1 ns step/duration
  // cannot advance that clock and a 1 ns refinement tolerance is unattainable.
  // https://doi.org/10.1109/IEEESTD.2019.8766229 (binary64 format, §3.6).
  for (const field of ['COARSE_STEP_SECONDS', 'DURATION_SECONDS', 'REFINEMENT_TOLERANCE_SECONDS']) {
    const request = { CATALOG_REQUEST: { PRIMARIES: [linearSource(0), linearSource(1)],
      CONTROLS: { ...controls(), [field]: 1e-9 }, EVALUATION_FRAME: earthFrame('GCRF') } };
    const response = await harness.invoke({ methodId: 'screen_catalog', inputs: [{ portId: 'request', payload: encodeCqr(flatc, request) }] });
    assert.notEqual(response.statusCode, 0, `${field} was accepted`);
    assert.equal(response.errorCode, 'unsupported-resolution');
    assert.equal(response.outputs.length, 0);
  }
});

test('CQR direct OMM sources use distinct catalog identities when international designators are absent', async (t) => {
  const flatc = await initCqrFlatc();
  const harness = await createConjunctionCommandHarness({ runtimeKind: 'browser' });
  t.after(() => harness.destroy());
  // CelesTrak SOCRATES Plus snapshot, captured 2026-03-10, same authoritative
  // 47935–49179 pair and TEME/UTC gates as proposal §8: .010 s / 5 m / 5 m/s.
  // https://celestrak.org/SOCRATES/ and the checked-in reference.top3.json.
  const records = JSON.parse(fs.readFileSync(new URL('./fixtures/socrates/gp_47935,49179.json', import.meta.url), 'utf8'));
  const reference = JSON.parse(fs.readFileSync(new URL('./fixtures/socrates/reference.top3.json', import.meta.url), 'utf8')).conjunctions.find(row => row.obj1_norad === 47935);
  const referenceJd = Date.parse(reference.tca) / 86400000 + 2440587.5;
  const request = encodeCqr(flatc, { CATALOG_REQUEST: {
    CONTROLS: { ...screeningControls({ startJd: referenceJd - 60 / 86400, durationSeconds: 120, coarseStepSec: 1 }), ALGORITHM: 'LAAS_2015' },
    EVALUATION_FRAME: earthFrame('TEME'),
  } });
  const encodeOmm = source => {
    const record = gpRecord(source);
    delete record.OBJECT_ID;
    return flatc.generateBinary(publishedSchema('OMM'), JSON.stringify(record), { sizePrefix: false });
  };
  const response = await harness.invoke({ methodId: 'screen_catalog', inputs: [
    { portId: 'request', payload: request }, ...records.map(record => ({ portId: 'catalog', payload: encodeOmm(record) })),
  ] });
  assert.equal(response.statusCode, 0, response.errorMessage);
  const result = decodeCqr(flatc, response.outputs[0].payload).CATALOG_RESULT;
  assert.equal(result.STATISTICS.PAIRS_SCREENED, 1);
  assert.equal(result.STATISTICS.FAILED_PAIRS, 0);
  assert.equal(result.EVENTS.length, 1);
  const event = result.EVENTS[0];
  assert.equal(event.PRIMARY_ID, '47935');
  assert.equal(event.SECONDARY_ID, '49179');
  assert.ok(Math.abs(event.TCA.JULIAN_DATE - referenceJd) * 86400 <= .010);
  assert.ok(Math.abs(event.MISS_DISTANCE_M - reference.min_range_km * 1000) <= 5);
  assert.ok(Math.abs(event.RELATIVE_SPEED_M_S - reference.rel_speed_kms * 1000) <= 5);
  const invalid = await harness.invoke({ methodId: 'screen_catalog', inputs: [
    { portId: 'request', payload: request }, { portId: 'catalog', payload: encodeOmm({ ...records[0], NORAD_CAT_ID: 0 }) },
  ] });
  assert.notEqual(invalid.statusCode, 0);
  assert.equal(invalid.errorCode, 'invalid-source');
  assert.equal(invalid.outputs.length, 0);
});

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

// The SpaceAware console's resident screen (sdn-js/spaceaware-ui
// src/orbital-console/modes/cnj): engine TEME km states every 60 s from a
// whole UTC second, 300 s guard bands, OEM compact grids, source handle =
// engine entity index + 1, one primary, 30 min windows that overlap by the
// 10 s coarse step, one direct-surface instance from prepare to destroy.
// Same rectilinear family as above in TEME, crossing at Tc = window start
// + 30 min 5 s, inside both windows' overlap: every primary pair i reaches TCA
// at Tc with miss 100*i m and speed 100*i m/s (OpenStax, as above).
test('CQR sampled index in the SpaceAware console shape screens TEME grids window by window; its retired request frame is refused', async (t) => {
  const flatc = await initCqrFlatc();
  const harness = await createConjunctionCommandHarness({ runtimeKind: 'browser' });
  t.after(() => harness.destroy());
  // The console's 0.2.0 request (file identifier CSSM) fails the request
  // port's $CQR type: the live "PREPARE SAMPLE INDEX FAILED · WASI exit with
  // code 1" of 2026-10-07 was this refusal behind the command surface.
  const retired = new flatbuffers.Builder(64);
  retired.startObject(0);
  retired.finish(retired.endObject(), 'CSSM');
  const refused = await harness.invoke({ methodId: 'prepare_sample_screening_index',
    inputs: [{ portId: 'request', payload: retired.asUint8Array() }] });
  assert.equal(refused.statusCode, 400);
  assert.equal(refused.errorCode, 'unsupported-input-type');
  assert.equal(refused.outputs.length, 0);

  const windowStartJd = 2461320.75; // 2026-10-07T06:00:00Z
  const tcaSec = 30 * 60 + 5, stepSec = 60, guardSec = 300, count = 72;
  const source = (i) => ({ OBJECT_ID: `S${String(i).padStart(2, '0')}`, OBJECT_NAME: `S${i}`, NORAD_CATALOG_ID: 90000 + i,
    SOURCE_HANDLE: i + 1, EPHEMERIS: { EPHEMERIS_DATA_BLOCK: [{ CENTER_NAME: 'EARTH', CENTER_NAIF_ID: 399,
      REFERENCE_FRAME: { REFERENCE_FRAME_type: 'CelestialFrameWrapper', REFERENCE_FRAME: { frame: 'TEMEOFDATE' } },
      TIME_SYSTEM: 'UTC', START_TIME: '2026-10-07T05:55:00.000Z', INTERPOLATION: 'HERMITE', INTERPOLATION_DEGREE: 3,
      STEP_SIZE: stepSec, STATE_VECTOR_SIZE: 6,
      EPHEMERIS_DATA: Array.from({ length: count }, (_, k) => {
        const s = k * stepSec - guardSec - tcaSec, v = 7.5 + .1 * i;
        return [7000 + .1 * i, v * s, 0, 0, v, 0];
      }).flat() }] } });
  const INSTANCE = { MODULE_ID: 'conjunction-assessment', INSTANCE_ID: 'spaceaware-console', GENERATION: 1 };
  const invoke = (methodId, value) => harness.invoke({ methodId, outputStreamCap: 1,
    inputs: [{ portId: 'request', payload: encodeCqr(flatc, value) }] });
  const prepared = await invoke('prepare_sample_screening_index', { INDEX_REQUEST: { INSTANCE,
    INDEX_CONTENT: 'SAMPLED_STATES', REFINEMENT_MODE: 'EXACT_ONLY', PRIMARY_SOURCE_HANDLES: [1], SOURCES: [0, 1, 2, 3].map(source) } });
  assert.equal(prepared.statusCode, 0, prepared.errorMessage);
  const index = decodeCqr(flatc, prepared.outputs[0].payload).INDEX_RESULT;
  assert.equal(index.SOURCE_COUNT, 4);
  assert.equal(index.CANDIDATE_PAIR_COUNT, 3);
  const window = (startSec, durationSec) => invoke('screen_window', { WINDOW_REQUEST: { INSTANCE,
    SCREENING_INDEX_HANDLE: index.SCREENING_INDEX_HANDLE, EVALUATION_FRAME: earthFrame('TEME'), CONTROLS: {
      START_EPOCH: { TIME_SYSTEM: 'UTC', EPOCH_FORMAT: 'JULIAN_DATE', JULIAN_DATE: windowStartJd + startSec / 86400 },
      DURATION_SECONDS: durationSec, THRESHOLD_M: 5000, REQUESTED_WORKERS: 1, COARSE_STEP_SECONDS: 10,
      REFINEMENT_TOLERANCE_SECONDS: .001, COMBINED_RADIUS_M: 10, ALGORITHM: 'ALFANO_MAXIMUM' } } });
  for (const [startSec, durationSec] of [[0, 1810], [1800, 1800]]) {
    const response = await window(startSec, durationSec);
    assert.equal(response.statusCode, 0, response.errorMessage);
    const result = decodeCqr(flatc, response.outputs[0].payload).CATALOG_RESULT;
    assert.equal(result.FINAL_CHUNK, true);
    assert.equal(result.STATISTICS.FAILED_PAIRS, 0);
    assert.deepEqual(result.EVENTS.map(e => `${e.PRIMARY_ID}-${e.SECONDARY_ID}`).sort(), ['S00-S01', 'S00-S02', 'S00-S03']);
    for (const event of result.EVENTS) {
      const i = Number(event.SECONDARY_ID.slice(1));
      assert.ok(Math.abs((event.TCA.JULIAN_DATE - windowStartJd) * 86400 - tcaSec) <= .01, `${startSec}: TCA`);
      assert.ok(Math.abs(event.MISS_DISTANCE_M - 100 * i) <= .001, `${startSec}: miss`);
      assert.ok(Math.abs(event.RELATIVE_SPEED_M_S - 100 * i) <= .005, `${startSec}: speed`);
    }
  }
  const destroyed = await invoke('destroy_screening_index', { DESTROY_REQUEST: { INSTANCE, SCREENING_INDEX_HANDLE: index.SCREENING_INDEX_HANDLE } });
  assert.equal(destroyed.statusCode, 0, destroyed.errorMessage);
  const stale = await window(0, 1810);
  assert.equal(stale.errorCode, 'invalid-index-handle');
});

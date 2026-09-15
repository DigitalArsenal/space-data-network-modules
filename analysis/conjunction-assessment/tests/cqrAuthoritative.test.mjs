import assert from 'node:assert/strict';
import test from 'node:test';
import { createConjunctionCommandHarness } from './lib/conjunctionCommandHarness.mjs';
import { initCqrFlatc, encodeCqr, decodeCqr } from './lib/cqr.mjs';

// Independent closed-form integral of a centered 2-D isotropic Gaussian over
// a disk: Pc = integral_0^R (r/sigma^2) exp(-r^2/(2 sigma^2)) dr
// = 1 - exp(-R^2/(2 sigma^2)). Source: NIST Rayleigh CDF
// https://www.itl.nist.gov/div898/software/dataplot/refman2/auxillar/raycdf.htm
// (zero location, radius R, scale sigma); proposal §8 fixes this oracle.
// R=10 m, sigma=100 m, covariance=10000 m^2; arbitrary orthonormal encounter
// axes, no epoch/time scale needed. Absolute 1e-12 tolerance resolves smooth
// deterministic integration error; this is not a maximum-Pc algorithm test.
test('CQR Laas 2015 Pc reproduces the centered isotropic Gaussian disk integral', async (t) => {
  const flatc = await initCqrFlatc();
  const harness = await createConjunctionCommandHarness();
  t.after(() => harness.destroy());
  const payload = encodeCqr(flatc, { PROBABILITY_REQUEST: { GEOMETRY: { XI_M: 0, ZETA_M: 0, VARIANCE_XI_M2: 10000, COVARIANCE_XI_ZETA_M2: 0, VARIANCE_ZETA_M2: 10000, COMBINED_RADIUS_M: 10 }, ALGORITHM: 'LAAS_2015' } });
  const response = await harness.invoke({ methodId: 'compute_pc', inputs: [{ portId: 'request', payload }] });
  assert.equal(response.statusCode, 0, response.errorMessage);
  const result = decodeCqr(flatc, response.outputs[0].payload).PROBABILITY_RESULT;
  assert.equal(result.ALGORITHM, 'LAAS_2015');
  assert.equal(result.CONVERGED, true);
  assert.ok(Math.abs(result.PROBABILITY - 0.00498752080731768) <= 1e-12, `Pc=${result.PROBABILITY}`);
});

test('CQR rejects singular encounter covariance and the retired JSON method', async (t) => {
  const flatc = await initCqrFlatc();
  const harness = await createConjunctionCommandHarness({ surface: 'direct' });
  t.after(() => harness.destroy());
  const payload = encodeCqr(flatc, { PROBABILITY_REQUEST: { GEOMETRY: { VARIANCE_XI_M2: 1, VARIANCE_ZETA_M2: 1, COVARIANCE_XI_ZETA_M2: 1, COMBINED_RADIUS_M: 10 }, ALGORITHM: 'LAAS_2015' } });
  for (const request of [{ methodId: 'compute_pc', inputs: [{ portId: 'request', payload }] }, { methodId: 'invoke', inputs: [{ portId: 'request', payload: new TextEncoder().encode('{"operation":"version"}') }] }]) {
    const response = await harness.invoke(request);
    assert.notEqual(response.statusCode, 0);
    assert.equal(response.outputs.length, 0);
  }
});

// Closed-form rectilinear encounter: r2-r1=(0.1,-1+0.1*t,0) km,
// v2-v1=(0,0.1,0) km/s. Squared distance is minimized at t=10 s,
// giving 100 m miss and 100 m/s speed. This is an exact constant-velocity
// kinematic case (not an orbital-dynamics claim); see OpenStax University
// Physics vol.1 §3.3, https://openstax.org/books/university-physics-volume-1/pages/3-3-average-and-instantaneous-acceleration
// UTC 2026-03-09T00:00:00Z; geocentric GCRF. Tolerance .01 s / .001 m /
// .001 m/s covers finite Julian-date representation and numerical refinement.
const referenceFrame = { REFERENCE_FRAME_type: 'CelestialFrameWrapper', REFERENCE_FRAME: { frame: 'GCRF' } };
function linearSource(id, kind, secondary = false) {
  const x = secondary ? 7000.1 : 7000;
  const y = secondary ? -1 : 0;
  const v = secondary ? 7.6 : 7.5;
  const common = { CENTER_NAME: 'EARTH', REFERENCE_FRAME: referenceFrame, TIME_SYSTEM: 'UTC', START_TIME: '2026-03-09T00:00:00Z', STOP_TIME: '2026-03-09T00:00:20Z' };
  if (kind === 'PPE') return { OBJECT_ID: id, POLYNOMIAL_EPHEMERIS: { ...common, POSITION_RECORDS: [{ EPOCH_MID: '2026-03-09T00:00:10Z', EPOCH_HALF_SPAN: 10, NUM_COEFFICIENTS: 2, POS_COEFF_X: [x,0], POS_COEFF_Y: [y+v*10,v*10], POS_COEFF_Z: [0,0], HAS_VELOCITY_COEFFICIENTS: true, VEL_COEFF_X: [0,0], VEL_COEFF_Y: [v,0], VEL_COEFF_Z: [0,0] }] } };
  const block = { ...common, INTERPOLATION: 'Hermite' };
  if (kind === 'compact') Object.assign(block, { STEP_SIZE: 20, STATE_VECTOR_SIZE: 6, EPHEMERIS_DATA: [x,y,0,0,v,0,x,y+v*20,0,0,v,0] });
  else block.EPHEMERIS_DATA_LINES = [{ EPOCH: common.START_TIME, X:x,Y:y,Z:0,X_DOT:0,Y_DOT:v,Z_DOT:0 },{ EPOCH:common.STOP_TIME,X:x,Y:y+v*20,Z:0,X_DOT:0,Y_DOT:v,Z_DOT:0 }];
  return { OBJECT_ID:id, EPHEMERIS:{EPHEMERIS_DATA_BLOCK:[block]} };
}

for (const kind of ['compact','verbose','PPE']) test(`CQR ${kind} sources reproduce the independent linear encounter without SGP4`, async (t) => {
  const { pairRequest, earthFrame } = await import('./lib/cqr.mjs');
  const flatc = await initCqrFlatc();
  const harness = await createConjunctionCommandHarness();
  t.after(() => harness.destroy());
  const payload = encodeCqr(flatc, pairRequest({ PRIMARY:linearSource('A',kind), SECONDARY:linearSource('B',kind,true), EVALUATION_FRAME:earthFrame('GCRF'), startJd:2461108.5, durationSeconds:20, coarseStepSec:1 }));
  const response=await harness.invoke({methodId:'assess_conjunction',inputs:[{portId:'request',payload}]});
  assert.equal(response.statusCode,0,response.errorMessage);
  const event=decodeCqr(flatc,response.outputs[0].payload).EVENT_RESULT;
  assert.ok(Math.abs((event.TCA.JULIAN_DATE-2461108.5)*86400-10)<=.01);
  assert.ok(Math.abs(event.MISS_DISTANCE_M-100)<=.001,`miss=${event.MISS_DISTANCE_M}`);
  assert.ok(Math.abs(event.RELATIVE_SPEED_M_S-100)<=.001,`speed=${event.RELATIVE_SPEED_M_S}`);
});

// Gregorian calendar restrictions: RFC 3339 §5.7 and Appendix C,
// https://www.rfc-editor.org/rfc/rfc3339#section-5.7 . CQR's source metadata
// explicitly selects UTC, so this implementation accepts CCSDS no-Z UTC text
// but rejects offset clocks and leap seconds it cannot interpret correctly.
test('CQR rejects malformed or unsupported UTC dates before evaluating a source', async (t) => {
  const { pairRequest, earthFrame, screeningControls } = await import('./lib/cqr.mjs');
  const flatc = await initCqrFlatc();
  const harness = await createConjunctionCommandHarness();
  t.after(() => harness.destroy());
  for (const epoch of ['2026-02-31T00:00:00Z', '2026-02-29T00:00:00Z', '2026-03-09T00:00:00Zgarbage', '2026-03-09T00:00:00+01:00', '999999999999-03-09T00:00:00Z', '2026-03-09T00:00:60Z']) {
    const primary = linearSource('A', 'verbose');
    primary.EPHEMERIS.EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES[0].EPOCH = epoch;
    const record = pairRequest({ PRIMARY: primary, SECONDARY: linearSource('B', 'verbose', true), EVALUATION_FRAME: earthFrame('GCRF'), CONTROLS: screeningControls({ startJd: 2461108.5, durationSeconds: 20, coarseStepSec: 1 }) });
    const response = await harness.invoke({ methodId: 'assess_conjunction', inputs: [{ portId: 'request', payload: encodeCqr(flatc, record) }] });
    assert.notEqual(response.statusCode, 0, `Unsupported source epoch was accepted: ${epoch}`);
    assert.equal(response.errorCode, 'invalid-source', `Wrong error classification: ${epoch}`);
    assert.equal(response.outputs.length, 0, `Invalid epoch emitted a scientific result: ${epoch}`);
  }
  const valid = pairRequest({ PRIMARY: linearSource('A', 'verbose'), SECONDARY: linearSource('B', 'verbose', true), EVALUATION_FRAME: earthFrame('GCRF'), startJd: 2461108.5, durationSeconds: 20, coarseStepSec: 1 });
  const recovered = await harness.invoke({ methodId: 'assess_conjunction', inputs: [{ portId: 'request', payload: encodeCqr(flatc, valid) }] });
  assert.equal(recovered.statusCode, 0, recovered.errorMessage);
});

test('CQR accepts leap-day and CCSDS no-Z UTC sources without changing the linear encounter', async (t) => {
  const { pairRequest, earthFrame, screeningControls } = await import('./lib/cqr.mjs');
  const flatc = await initCqrFlatc();
  const harness = await createConjunctionCommandHarness();
  t.after(() => harness.destroy());
  for (const date of ['2024-02-29', '2026-03-09']) {
    const suffix = date === '2024-02-29' ? 'Z' : '';
    const sources = [linearSource('A', 'verbose'), linearSource('B', 'verbose', true)];
    for (const source of sources) {
      const block = source.EPHEMERIS.EPHEMERIS_DATA_BLOCK[0];
      block.START_TIME = block.EPHEMERIS_DATA_LINES[0].EPOCH = `${date}T00:00:00${suffix}`;
      block.STOP_TIME = block.EPHEMERIS_DATA_LINES[1].EPOCH = `${date}T00:00:20${suffix}`;
    }
    const controls = screeningControls({ durationSeconds: 20, coarseStepSec: 1, START_EPOCH: { TIME_SYSTEM: 'UTC', EPOCH_FORMAT: 'ISO8601', ISO8601: `${date}T00:00:00${suffix}` } });
    const record = pairRequest({ PRIMARY: sources[0], SECONDARY: sources[1], EVALUATION_FRAME: earthFrame('GCRF'), CONTROLS: controls });
    const response = await harness.invoke({ methodId: 'assess_conjunction', inputs: [{ portId: 'request', payload: encodeCqr(flatc, record) }] });
    assert.equal(response.statusCode, 0, response.errorMessage);
    const event = decodeCqr(flatc, response.outputs[0].payload).EVENT_RESULT;
    assert.ok(Math.abs(event.MISS_DISTANCE_M - 100) <= .001, `miss=${event.MISS_DISTANCE_M}`);
    assert.ok(Math.abs(event.RELATIVE_SPEED_M_S - 100) <= .001, `speed=${event.RELATIVE_SPEED_M_S}`);
  }
});

// CelesTrak's TLE definition places UTC day-of-year in columns 21–32:
// https://celestrak.org/columns/v04n03/ . Day 999 cannot denote a calendar day.
// This is a syntax/range rejection; no numerical orbit oracle is claimed.
test('CQR rejects out-of-range TLE epoch days without a numerical result', async (t) => {
  const { tleSource } = await import('./lib/cqr.mjs');
  const flatc = await initCqrFlatc();
  const harness = await createConjunctionCommandHarness();
  t.after(() => harness.destroy());
  const record = { INDEX_REQUEST: { INSTANCE: { MODULE_ID: 'conjunction-assessment', INSTANCE_ID: 'malformed-tle', GENERATION: 1 }, INDEX_CONTENT: 'SOURCE_DESCRIPTIONS', REFINEMENT_MODE: 'EXACT_ONLY', SOURCES: [{ ...tleSource({ name: 'INVALID-EPOCH', line1: '1 25544U 98067A   24999.00000000  .00016717  00000-0  10270-3 0  9001', line2: '2 25544  51.6400 100.0000 0001500  80.0000 280.0000 15.49000000000017' }), SOURCE_HANDLE: 1 }] } };
  const response = await harness.invoke({ methodId: 'prepare_screening_index', inputs: [{ portId: 'request', payload: encodeCqr(flatc, record) }] });
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, 'invalid-source');
  assert.match(response.errorMessage, /Invalid TLE epoch day/);
  assert.equal(response.outputs.length, 0);
});

for (const runtimeKind of ['browser', 'wasmedge', 'docker-wasmedge']) test(`CQR ${runtimeKind} sampled resident index preserves the linear encounter and invalidates destroyed handles`, async (t) => {
  const { screeningControls, earthFrame } = await import('./lib/cqr.mjs');
  const flatc = await initCqrFlatc();
  // Resident state requires a persistent direct instance. The command host
  // deliberately runs one fresh guest per invoke.
  const harness = await createConjunctionCommandHarness({ runtimeKind, surface: 'direct' });
  t.after(() => harness.destroy());
  const INSTANCE = { MODULE_ID: 'conjunction-assessment', INSTANCE_ID: 'linear-resident', GENERATION: 1 };
  const invoke = async (methodId, record) => harness.invoke({methodId,inputs:[{portId:'request',payload:encodeCqr(flatc,record)}]});
  const prepared=await invoke('prepare_sample_screening_index',{INDEX_REQUEST:{INSTANCE,INDEX_CONTENT:'SAMPLED_STATES',REFINEMENT_MODE:'EXACT_ONLY',SOURCES:[{...linearSource('A','compact'),SOURCE_HANDLE:1},{...linearSource('B','compact',true),SOURCE_HANDLE:2}]}});
  assert.equal(prepared.statusCode,0,prepared.errorMessage);
  const index=decodeCqr(flatc,prepared.outputs[0].payload).INDEX_RESULT;
  assert.equal(index.SOURCE_COUNT,2);
  const record={WINDOW_REQUEST:{INSTANCE,SCREENING_INDEX_HANDLE:index.SCREENING_INDEX_HANDLE,CONTROLS:screeningControls({startJd:2461108.5,durationSeconds:20,coarseStepSec:1}),EVALUATION_FRAME:earthFrame('GCRF')}};
  const screened=await invoke('screen_window',record);
  assert.equal(screened.statusCode,0,screened.errorMessage);
  const event=decodeCqr(flatc,screened.outputs[0].payload).CATALOG_RESULT.EVENTS[0];
  assert.ok(Math.abs((event.TCA.JULIAN_DATE-2461108.5)*86400-10)<=.01);
  assert.ok(Math.abs(event.MISS_DISTANCE_M-100)<=.001);
  const destroyed=await invoke('destroy_screening_index',{DESTROY_REQUEST:{INSTANCE,SCREENING_INDEX_HANDLE:index.SCREENING_INDEX_HANDLE}});
  assert.equal(destroyed.statusCode,0,destroyed.errorMessage);
  assert.equal(destroyed.outputs.length,0);
  assert.notEqual((await invoke('screen_window',record)).statusCode,0);
});

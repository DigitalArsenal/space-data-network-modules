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
  const harness = await createConjunctionCommandHarness();
  t.after(() => harness.destroy());
  const payload = encodeCqr(flatc, { PROBABILITY_REQUEST: { GEOMETRY: { VARIANCE_XI_M2: 1, VARIANCE_ZETA_M2: 1, COVARIANCE_XI_ZETA_M2: 1, COMBINED_RADIUS_M: 10 } } });
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

test('CQR sampled resident index preserves the linear encounter and invalidates destroyed handles', async (t) => {
  const { screeningControls, earthFrame } = await import('./lib/cqr.mjs');
  const flatc = await initCqrFlatc();
  // Resident state requires a persistent direct instance. The command host
  // deliberately runs one fresh guest per invoke.
  const harness = await createConjunctionCommandHarness({ runtimeKind: 'browser' });
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

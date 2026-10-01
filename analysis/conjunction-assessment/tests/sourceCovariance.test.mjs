// Covariance from the sources that carry it (OEM covariance lines), through
// the module surface: the covariance method's probability, labelled as the
// sources' own uncalibrated covariance, survives a CDM round trip; a
// covariance in a frame the guest would have to transform is refused.
//
// Two straight-line OEM tracks cross with a 50 m miss at JD0; each carries an
// RTN covariance of 100/300/100 m (1 sigma).
import assert from 'node:assert/strict';
import test from 'node:test';
import { createConjunctionCommandHarness } from './lib/conjunctionCommandHarness.mjs';
import { decodeCqr, earthFrame, encodeCqr, initCqrFlatc, screeningControls } from './lib/cqr.mjs';

const JD0 = 2461314.5;
const iso = (jd) => new Date((jd - 2440587.5) * 86400000).toISOString();
const RSW = { REFERENCE_FRAME_type: 'OrbitFrameWrapper', REFERENCE_FRAME: { frame: 'RSW_INERTIAL' } };
const EME2000 = { REFERENCE_FRAME_type: 'CelestialFrameWrapper', REFERENCE_FRAME: { frame: 'EME2000' } };

function track(id, origin, velocity, covarianceFrame) {
  const lines = [];
  for (let t = -300; t <= 300; t += 60) {
    lines.push({ EPOCH: iso(JD0 + t / 86400),
      X: origin[0] + velocity[0] * t, Y: origin[1] + velocity[1] * t, Z: origin[2] + velocity[2] * t,
      X_DOT: velocity[0], Y_DOT: velocity[1], Z_DOT: velocity[2] });
  }
  const covariance = [-300, 300].map((t) => ({ EPOCH: iso(JD0 + t / 86400),
    CX_X: 0.01, CY_Y: 0.09, CZ_Z: 0.01, CX_DOT_X_DOT: 1e-6, CY_DOT_Y_DOT: 1e-6, CZ_DOT_Z_DOT: 1e-6 }));
  return { OBJECT_ID: id, OBJECT_NAME: id, EPHEMERIS: { EPHEMERIS_DATA_BLOCK: [{
    CENTER_NAME: 'EARTH', CENTER_NAIF_ID: 399, TIME_SYSTEM: 'UTC',
    REFERENCE_FRAME: { REFERENCE_FRAME_type: 'CelestialFrameWrapper', REFERENCE_FRAME: { frame: 'TEMEOFDATE' } },
    COV_REFERENCE_FRAME: covarianceFrame, EPHEMERIS_DATA_LINES: lines, COVARIANCE_MATRIX_LINES: covariance }] } };
}
const request = (covarianceFrame) => ({ PAIR_REQUEST: {
  PRIMARY: track('A', [7000, 0, 0], [0, 7.5, 0], RSW),
  SECONDARY: track('B', [7000.05, 0, 0], [0, 0, 7.5], covarianceFrame),
  CONTROLS: { ...screeningControls({ startJd: JD0 - 200 / 86400, durationSeconds: 400, coarseStepSec: 5 }), ALGORITHM: 'LAAS_2015' },
  PRIMARY_RADIUS_M: 5, SECONDARY_RADIUS_M: 5, EVALUATION_FRAME: earthFrame('TEME') } });

test('OEM covariance gives a covariance probability that survives a CDM round trip', async () => {
  const flatc = await initCqrFlatc();
  const h = await createConjunctionCommandHarness({ runtimeKind: 'browser' });
  try {
    const payload = encodeCqr(flatc, request(RSW));
    const assessed = await h.invoke({ methodId: 'assess_conjunction', inputs: [{ portId: 'request', payload }] });
    assert.equal(assessed.statusCode, 0, assessed.errorMessage);
    const e = decodeCqr(flatc, assessed.outputs[0].payload).EVENT_RESULT;
    // A Julian date resolves TCA to about 47 us: 0.5 m along a 10.6 km/s pass.
    assert.ok(Math.abs(e.MISS_DISTANCE_M - 50) < 0.05, `miss ${e.MISS_DISTANCE_M}`);
    assert.equal(e.PROBABILITY.ALGORITHM, 'LAAS_2015');
    assert.equal(e.PROBABILITY.UNCERTAINTY_SOURCE, 'SUPPLIED_COVARIANCE');
    assert.equal(e.PROBABILITY.CALIBRATION, 'Uncalibrated');
    assert.equal(e.PROBABILITY.CROSS_CORRELATION, 'INDEPENDENT');
    assert.equal(e.PRIMARY_COVARIANCE_BASIS, 'SOURCE_EPHEMERIS');
    assert.equal(e.SECONDARY_COVARIANCE_BASIS, 'SOURCE_EPHEMERIS');
    for (const [got, want] of [[e.PRIMARY_SIGMA_RTN_M, [100, 300, 100]], [e.SECONDARY_SIGMA_RTN_M, [100, 300, 100]]]) {
      assert.deepEqual([got.X, got.Y, got.Z].map((x) => Math.round(x)), want);
    }
    assert.ok(e.PROBABILITY.PROBABILITY > 1e-6 && e.PROBABILITY.PROBABILITY < 1);

    const cdm = await h.invoke({ methodId: 'emit_cdm', inputs: [{ portId: 'request', payload }] });
    assert.equal(cdm.statusCode, 0, cdm.errorMessage);
    const cdmFrame = cdm.outputs.find((f) => f.portId === 'cdm');
    const fromCdm = await h.invoke({ methodId: 'compute_pc_from_cdm', inputs: [{ portId: 'cdm', payload: cdmFrame.payload }] });
    assert.equal(fromCdm.statusCode, 0, fromCdm.errorMessage);
    const p = decodeCqr(flatc, fromCdm.outputs[0].payload).PROBABILITY_RESULT.PROBABILITY;
    assert.ok(Math.abs(p - e.PROBABILITY.PROBABILITY) <= 1e-9 * e.PROBABILITY.PROBABILITY,
      `CDM ${p} vs event ${e.PROBABILITY.PROBABILITY}`);
    const kvn = await h.invoke({ methodId: 'write_cdm_kvn', inputs: [{ portId: 'cdm', payload: cdmFrame.payload }] });
    assert.equal(kvn.statusCode, 0, kvn.errorMessage);
  } finally {
    await h.destroy?.();
  }
});

test('a source covariance in another inertial frame is refused', async () => {
  const flatc = await initCqrFlatc();
  const h = await createConjunctionCommandHarness({ runtimeKind: 'browser' });
  try {
    const r = await h.invoke({ methodId: 'assess_conjunction', inputs: [{ portId: 'request', payload: encodeCqr(flatc, request(EME2000)) }] });
    assert.notEqual(r.statusCode, 0);
    assert.equal(r.errorCode, 'covariance-frame-mismatch');
  } finally {
    await h.destroy?.();
  }
});

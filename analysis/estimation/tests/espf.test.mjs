// ESPF and the ellipsoidal set-membership filter, end to end through the WASM
// artifact, with every support point propagated by propagator/hpop at full
// force (hpop-port.mjs). docs/espf-spec.md, section T:
// (b) the 2025 appendix's Gaussian limit (unscented points and weights,
//     Gaussian kernels read as densities, additive Q and R, product fusion)
//     reproduces this module's UKF (itself validated against Orekit 13.1's
//     UnscentedKalmanEstimator, tests/depth.test.mjs);
// the 2026 variant's structural invariants and exact restart from its
// support state; the 2025 variant's stated temporal decay; and the
// set-membership filter's guarantee (Schweppe 1968): the truth stays inside
// the bound when the noise bound holds, and an observation outside every
// admissible state is flagged and leaves the set unchanged. LINEAR records
// (y = H x + offset) enter all three through the same measurement model as
// the core filters: H = [I 0] reproduces POSITION_VECTOR byte for byte.
import assert from 'node:assert/strict';
import test from 'node:test';
import { module, runToCompletion } from './hpop-port.mjs';
import { espfScenario } from './espf-fixtures.mjs';
import { api } from './wire.mjs';

const estimator = await module('../');
const hpop = await module('../../../propagator/hpop/');
test.after(() => { for (const h of [estimator, hpop]) { h.destroy?.(); h.dispose?.(); } });

const { truth, OBSERVATIONS, SECONDS, envelopeFor, maxRelative } = await espfScenario(estimator, hpop);

test('(b) ESPF 2025 in its Gaussian limit reproduces the UKF (full-force HPOP port)', async () => {
  const ukf = await runToCompletion(estimator, hpop, envelopeFor('UNSCENTED_KALMAN_FILTER', { ukf_alpha: 1, ukf_beta: 2, ukf_kappa: 0 }));
  const limit = await runToCompletion(estimator, hpop, envelopeFor('ESPF_2025', { ukf_alpha: 1, ukf_beta: 2, ukf_kappa: 0, espf: { gaussian_limit: true } }));
  assert.equal(ukf.status, 0);
  assert.equal(limit.status, 0);
  assert.equal(limit.filterHistory.length, ukf.filterHistory.length);
  let state = 0, covariance = 0;
  ukf.filterHistory.forEach((u, k) => {
    const e = limit.filterHistory[k];
    state = Math.max(state, maxRelative(e.filteredState, u.filteredState));
    covariance = Math.max(covariance, maxRelative(e.filteredCovariance, u.filteredCovariance));
  });
  // Same seeds, same HPOP answers; the updates differ only in rounding.
  assert.ok(state < 1e-12 && covariance < 1e-9, JSON.stringify({ state, covariance }));
  console.log(`PASS (b) ESPF_2025 Gaussian limit vs UKF: state ${state}, covariance ${covariance} (relative, max over ${ukf.filterHistory.length} epochs)`);
});

test('ESPF 2026: support, survivors, medoid and possibility reset; exact restart from final_support', async () => {
  const full = await runToCompletion(estimator, hpop, envelopeFor('ESPF_2026', { espf: {} }));
  assert.equal(full.status, 0);
  assert.equal(full.supportHistory.length, OBSERVATIONS.length);
  for (const e of full.supportHistory) {
    assert.equal(e.supportCount, 85);
    assert.ok(e.survivorCount >= 13 && e.survivorCount <= 85, e.survivorCount);
    assert.ok(e.medoidIndex >= 0 && e.medoidIndex < 85);
    assert.ok(e.information > 0 && e.information < 1 - Math.exp(-1) + 1e-15);
    assert.ok(e.sigma >= 0.1 && e.sigma <= 1);
  }
  const final = full.finalSupport;
  assert.equal(final.points.length, 85 * 6);
  assert.ok(final.possibility.every((p) => p === 1));
  // Split at observation 6: the second request starts from the support state.
  const first = await runToCompletion(estimator, hpop, envelopeFor('ESPF_2026', { espf: {} }, { observations: OBSERVATIONS.slice(0, 6) }));
  const restart = envelopeFor('ESPF_2026', { espf: {}, initial_support: {} }, { observations: OBSERVATIONS.slice(6), epochSeconds: SECONDS[5] });
  restart.request.options.initialSupport = first.finalSupport;
  const second = await runToCompletion(estimator, hpop, restart);
  second.filterHistory.forEach((e, k) => {
    assert.deepEqual(e.filteredState, full.filterHistory[6 + k].filteredState);
    assert.deepEqual(e.filteredCovariance, full.filterHistory[6 + k].filteredCovariance);
  });
});

test('ESPF 2025: 2n + 1 support, the stated decay exp(-0.05 tau), and all-falsified evidence flagged', async () => {
  const run = await runToCompletion(estimator, hpop, envelopeFor('ESPF_2025', { espf: {} }));
  assert.equal(run.status, 0);
  run.supportHistory.forEach((e, k) => {
    assert.equal(e.supportCount, 13);
    assert.ok(Math.abs(e.sigma - Math.exp(-0.05 * (k + 1))) < 1e-15, `${k} ${e.sigma}`);
  });
  // A 0.2 rad gross error lies outside every support point's compatibility region.
  const bad = OBSERVATIONS.map((o, k) => (k === 3 ? Object.assign(Object.create(Object.getPrototypeOf(o)), o, { value: [o.value[0] + 0.2, o.value[1], 0, 0] }) : o));
  const flagged = await runToCompletion(estimator, hpop, envelopeFor('ESPF_2025', { espf: {} }, { observations: bad }));
  // The literal 2025 recursion contracts its support by sigma_k^2 at every
  // regeneration and by pruning, with no stated re-expansion (its surprisal
  // gain is unstated), so later epochs may also falsify every point
  // (docs/espf-spec.md G13). Before the gross error the two runs agree.
  for (let k = 0; k < 3; ++k) {
    assert.equal(run.supportHistory[k].inconsistent, false);
    assert.deepEqual(flagged.filterHistory[k].filteredState, run.filterHistory[k].filteredState);
  }
  assert.equal(run.supportHistory[3].inconsistent, false);
  assert.equal(flagged.supportHistory[3].inconsistent, true);
  assert.equal(flagged.supportHistory[3].survivorCount, 0);
  assert.ok(flagged.rejectedObservationIndices.includes(3));
});

test('set-membership filter: the truth stays inside the bound; an impossible observation is flagged', async () => {
  const options = { set_membership: { initial_bound_scale: 3, process_bound_scale: 3, measurement_bound_scale: 5 } };
  const run = await runToCompletion(estimator, hpop, envelopeFor('ELLIPSOIDAL_SET_MEMBERSHIP', options), { stm: true });
  assert.equal(run.status, 0);
  run.supportHistory.forEach((e, k) => {
    const d = e.estimate.map((x, i) => truth[k].state[i] - x);
    // d' S^-1 d <= 1 by Cholesky of the 6 x 6 shape.
    const S = e.shape, L = Array(36).fill(0);
    for (let i = 0; i < 6; ++i) for (let j = 0; j <= i; ++j) {
      let v = S[i * 6 + j];
      for (let m = 0; m < j; ++m) v -= L[i * 6 + m] * L[j * 6 + m];
      L[i * 6 + j] = i === j ? Math.sqrt(v) : v / L[j * 6 + j];
    }
    const z = [];
    for (let i = 0; i < 6; ++i) { let v = d[i]; for (let m = 0; m < i; ++m) v -= L[i * 6 + m] * z[m]; z.push(v / L[i * 6 + i]); }
    const q = z.reduce((s, x) => s + x * x, 0);
    assert.ok(q <= 1, `epoch ${k}: truth at normalized distance ${Math.sqrt(q)}`);
  });
  const bad = OBSERVATIONS.map((o, k) => (k === 3 ? Object.assign(Object.create(Object.getPrototypeOf(o)), o, { value: [o.value[0] + 0.01, o.value[1], 0, 0] }) : o));
  const flagged = await runToCompletion(estimator, hpop, envelopeFor('ELLIPSOIDAL_SET_MEMBERSHIP', options, { observations: bad }), { stm: true });
  assert.equal(flagged.supportHistory[3].inconsistent, true);
  assert.deepEqual(flagged.rejectedObservationIndices, [3]);
  assert.deepEqual(flagged.supportHistory[3].shape, flagged.supportHistory[3].predictedShape);
});

test('LINEAR records with H = [I 0] reproduce POSITION_VECTOR byte for byte (ESPF 2026, ESPF 2025, set-membership)', async () => {
  const A = api();
  const H = [1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0];
  const records = (kind) => OBSERVATIONS.slice(0, 4).map((o, k) => Object.assign(new A.ExtendedObservationT(), {
    observation: Object.assign(Object.create(Object.getPrototypeOf(o)), o, { kind: A.MeasurementKind[kind], valueCount: 3 }),
    values: truth[k].state.slice(0, 3).map((x, i) => x + [30, -20, 10][i]), sigmas: [100, 100, 100],
    ...(kind === 'LINEAR' ? { linearMatrix: H, linearOffset: [0, 0, 0] } : {}),
  }));
  for (const [kind, options, port] of [['ESPF_2026', { espf: {} }, {}], ['ESPF_2025', { espf: {} }, {}], ['ELLIPSOIDAL_SET_MEMBERSHIP', { set_membership: {} }, { stm: true }]]) {
    const run = async (measurement) => {
      const envelope = envelopeFor(kind, options);
      envelope.request.extendedObservations = records(measurement);
      return runToCompletion(estimator, hpop, envelope, port);
    };
    const vector = await run('POSITION_VECTOR'), linear = await run('LINEAR');
    assert.equal(vector.status, 0, vector.error);
    assert.equal(linear.status, 0, linear.error);
    assert.equal(linear.filterHistory.length, 4);
    linear.filterHistory.forEach((e, k) => {
      assert.deepEqual(e.filteredState, vector.filterHistory[k].filteredState);
      assert.deepEqual(e.filteredCovariance, vector.filterHistory[k].filteredCovariance);
    });
  }
});

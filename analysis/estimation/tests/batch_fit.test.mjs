// fit_batch against Orekit 13.1's BatchLSEstimator, end to end: this
// module's WASM asks for samples through the inverted port, propagator/hpop's
// WASM answers them (state, STM and parameter sensitivity), and the fit is
// compared with Orekit's on the same noisy observations.
//
// Authority: tests/fixtures/OrekitBatchReference.java wrote
// tests/fixtures/orekit-batch-reference.json (Orekit 13.1, CS GROUP,
// Apache-2.0); nothing here regenerates it. Two cases, epoch
// 2026-08-02T00:00:00 UTC, GCRF, SI units:
//   LEO400-drag  20x20 field, Sun, Moon, radiation pressure, NRLMSISE-00
//                drag; 288 positions over 24 h, sigma 5 m isotropic;
//                solve-for state and B = Cd*A/m (truth 0.044 m^2/kg,
//                a priori 0.036, state 539 m and 0.37 m/s off).
//   GPS-srp      20x20 field, Sun, Moon, radiation pressure; 96 positions
//                over 24 h with variances 4, 25 and 1 m^2 per axis,
//                given to the module as full 3x3 matrices; solve-for state and AGOM = Cr*A/m (truth
//                0.026, a priori 0.020).
//   GPS-pv       the same orbit and forces; 8 full states (POSITION_VELOCITY,
//                extended observations) over 24 h, sigmas 20/50/10 m and
//                0.005/0.002/0.004 m/s; run twice: with the sigmas, and with
//                each covariance stated in the RTN axes of the measured state
//                (rotated by Orekit's LOFType.QSW), covariance_axes = 1.
// BatchLSEstimator weights components by their standard deviations alone,
// so every reference covariance is diagonal in GCRF; the RTN variant's
// off-diagonal terms come from the rotation and cancel when the module
// rotates back. Whitening by a covariance that is correlated in the request
// axes has no Orekit reference.
// The force sets and constants are propagator/hpop's Orekit cases, which
// HPOP reproduces to 1.3 cm (LEO, drag) and 0.43 mm (GPS) over a day, and
// whose parameter Jacobians agree to 5e-6 (B) and 5e-10 (GPS AGOM)
// (propagator/hpop/tests/orekit_reference.test.mjs).
//
// Tolerances and their rationale:
// Measured 2026-10-09 (in parentheses: LEO, GPS; GPS-pv in both variants:
// 7.8e-6 sigma, 3.2e-10, 2.4e-7) against each limit.
//   - estimate: the difference from Orekit's, in units of Orekit's formal
//     sigma per component, at most 5e-3 (1.1e-3, 2.1e-4; 0.77 mm, 0.07 mm).
//     Both fits solve the same problem;
//     what separates them is the propagators' disagreement (centimetres in
//     LEO against formal position sigmas of decimetres) and both
//     optimizers' stopping rules.
//   - covariance: every entry differs by at most 1e-4 of sqrt(Pii Pjj)
//     (2.2e-6, 3.7e-10): Jacobian agreement 1e-5 relative, and the
//     linearization point.
//   - chi-square: within 1e-4 relative (1.2e-6, 5.6e-7).
//   - the truth (known, since Orekit generated the observations from it
//     with noise drawn from the stated covariance) lies inside the formal
//     covariance: Mahalanobis d^2 over the 7 solve-for below 24.32, the
//     chi-square(7) 0.9999 quantile.
import assert from 'node:assert/strict';
import test from 'node:test';
import { REFERENCE, fit, fitRequest, harness } from './batch-fit-fixtures.mjs';
import { pack, typeRef } from './wire.mjs';

for (const [c, variant] of REFERENCE.cases.flatMap((c) => (c.rtnCovariances ? [[c, 'sigmas'], [c, 'rtn']] : [[c, 'sigmas']]))) {
  test(`fit_batch with propagator/hpop matches Orekit BatchLSEstimator: ${c.name} (${variant})`, async (t) => {
    const estimator = await harness('../');
    const hpop = await harness('../../../propagator/hpop/');
    t.after(() => { estimator.destroy?.(); hpop.destroy?.(); });
    const envelope = fitRequest(c, variant);
    const { result, rounds } = await fit(estimator, hpop, c, envelope);
    assert.equal(result.status, 0, 'converged');
    const b = result.batchFit, n = 7;
    const ref = c.orekit, P = ref.covariance;
    const sigma = (i) => Math.sqrt(P[i * n + i]);
    const estimateGap = Math.max(...b.estimate.map((v, i) => Math.abs(v - ref.estimate[i]) / sigma(i)));
    let covarianceGap = 0;
    for (let i = 0; i < n; ++i) for (let j = 0; j < n; ++j) covarianceGap = Math.max(covarianceGap, Math.abs(b.covariance[i * n + j] - P[i * n + j]) / (sigma(i) * sigma(j)));
    const chiGap = Math.abs(b.chiSquare - ref.chiSquare) / ref.chiSquare;
    const truth = [...c.truth, c.truthParameter];
    const e = b.estimate.map((v, i) => v - truth[i]);
    // d^2 = e' P^-1 e by Cholesky of the module's covariance (statistic only).
    const L = Array(n * n).fill(0);
    for (let i = 0; i < n; ++i) for (let j = 0; j <= i; ++j) {
      let s = b.covariance[i * n + j];
      for (let k = 0; k < j; ++k) s -= L[i * n + k] * L[j * n + k];
      L[i * n + j] = i === j ? Math.sqrt(s) : s / L[j * n + j];
    }
    const z = [];
    for (let i = 0; i < n; ++i) { let s = e[i]; for (let k = 0; k < i; ++k) s -= L[i * n + k] * z[k]; z.push(s / L[i * n + i]); }
    const d2 = z.reduce((a, v) => a + v * v, 0);
    t.diagnostic(`${c.name} (${variant}): ${b.iterations} iterations (${rounds} HPOP rounds; Orekit ${ref.iterations}); estimate gap ${estimateGap.toExponential(2)} sigma; ` +
      `position ${Math.hypot(...[0, 1, 2].map((i) => b.estimate[i] - ref.estimate[i])).toExponential(2)} m; parameter ${(b.estimate[6] - ref.estimate[6]).toExponential(2)} (sigma ${sigma(6).toExponential(2)}); ` +
      `covariance gap ${covarianceGap.toExponential(2)}; chi-square ${b.chiSquare.toFixed(4)} vs ${ref.chiSquare.toFixed(4)} (${chiGap.toExponential(2)}); truth d2 ${d2.toFixed(3)}`);
    assert.ok(estimateGap <= 5e-3, `estimate differs from Orekit by ${estimateGap} sigma`);
    assert.ok(covarianceGap <= 1e-4, `covariance differs from Orekit by ${covarianceGap}`);
    assert.ok(chiGap <= 1e-4, `chi-square differs from Orekit by ${chiGap}`);
    assert.ok(d2 < 24.32, `truth outside the formal covariance: d2 ${d2}`);
    const m = c.measurement === 'POSITION_VELOCITY' ? 6 : 3;
    assert.equal(b.measurementCount, m * c.observations.length);
    assert.equal(b.degreesOfFreedom, m * c.observations.length - n);
    assert.ok(Math.abs(b.reducedChiSquare - b.chiSquare / b.degreesOfFreedom) < 1e-12 * b.reducedChiSquare);
    assert.ok(Math.abs(b.scaledCovariance[0] - b.covariance[0] * b.reducedChiSquare) <= 1e-12 * b.scaledCovariance[0]);

    // A changed seed in a replayed answer is refused, not used.
    envelope.propagationAnswers[0].query.seed.state[0] += 1;
    const stale = await estimator.invoke({ methodId: 'fit_batch', inputs: [{ portId: 'request', typeRef, payload: pack(envelope) }] });
    assert.notEqual(stale.statusCode, 0);
  });
}

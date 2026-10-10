// fit_batch measurement parameters (bias, drift, time bias) recovered with
// the orbit from a simulated tracking campaign (tests/tracking-pipeline.mjs):
// propagator/hpop truth at full force, analysis/observation-simulator
// measurements, analysis/association sensor geometry, and fit_batch with
// propagator/hpop answering. The injected values are the reference.
//
// Campaign (tests/batch-fit-v2-fixtures.mjs campaignFit; 2026-08-02 00:00 to
// 12:00 UTC, the Orekit LEO case's orbit, 51.6 deg, 397 km, B = 0.01
// m^2/kg): ranging radars at A and B (sigma 5 m; simulator biases +12 m and
// -8 m), passive RF at C and D receiving a 437 MHz emitter (sigma 20 Hz;
// simulator bias +300 Hz, a frequency offset), one observation every 10 s
// above 10 deg elevation. Injected on the records afterwards: RF pass 1
// drifts by 0.5 Hz/s from its first observation; RF pass 2's time tags lag
// the truth by 0.82 s (E6 measured a 0.82 s common lag on SatNOGS); radar
// A's first pass is tagged 0.05 s late. Fit: state, B >= 0, a range bias per
// radar, a frequency bias per RF pass, the drift and both time biases, all
// free. Every estimate must be within 4 formal sigma of what was injected,
// and the Mahalanobis distance of the whole vector from the truth below the
// chi-square 0.9999 quantile (Wilson-Hilferty).
import assert from 'node:assert/strict';
import test from 'node:test';
import { harness } from './batch-fit-fixtures.mjs';
import { campaignFit } from './batch-fit-v2-fixtures.mjs';
import { mahalanobis, runFit } from './batch-fit-v2-lib.mjs';

const chiSquareQuantile = (k, z) => k * (1 - 2 / (9 * k) + z * Math.sqrt(2 / (9 * k))) ** 3;

test('per-pass biases, a frequency drift and time biases are estimated with the orbit and recover what was injected', async (t) => {
  const estimator = await harness('../');
  const hpop = await harness('../../../propagator/hpop/');
  t.after(() => { estimator.destroy?.(); hpop.destroy?.(); });
  const c = await campaignFit(hpop);
  const { result, error, rounds } = await runFit(estimator, c.envelope, c.answer);
  assert.equal(error, undefined, error);
  assert.equal(result.status, 0);
  const b = result.batchFit, n = 7 + c.parameters.length;
  assert.equal(b.measurementParameterCount, c.parameters.length);
  const sigma = (i) => Math.sqrt(b.covariance[i * n + i]);
  const z = b.estimate.map((v, i) => (v - c.truthVector[i]) / sigma(i));
  const d2 = mahalanobis(b.estimate.map((v, i) => v - c.truthVector[i]), b.covariance, n);
  t.diagnostic(`${c.data.radar.length} ranges, ${c.data.rf.length} Doppler shifts in ${c.rfPasses.length} RF passes; ${rounds} rounds; weighted RMS ${b.weightedRms.toFixed(3)}; d2 ${d2.toFixed(2)} (${n} dof)`);
  t.diagnostic(`B ${b.estimate[6].toExponential(4)} +/- ${sigma(6).toExponential(2)}; range biases ${b.estimate[7].toFixed(3)}, ${b.estimate[8].toFixed(3)} m; drift ${b.estimate[n - 3].toFixed(5)} +/- ${sigma(n - 3).toExponential(2)} Hz/s; RF lag ${b.estimate[n - 2].toFixed(5)} +/- ${sigma(n - 2).toExponential(2)} s; radar lag ${b.estimate[n - 1].toFixed(6)} +/- ${sigma(n - 1).toExponential(2)} s`);
  t.diagnostic(`z-scores: ${z.map((v) => v.toFixed(2)).join(' ')}`);
  z.forEach((v, i) => assert.ok(Math.abs(v) < 4, `parameter ${i}: ${b.estimate[i]} vs ${c.truthVector[i]} (${v.toFixed(2)} sigma)`));
  assert.ok(d2 < chiSquareQuantile(n, 3.719), `d2 ${d2} for ${n}`);
});

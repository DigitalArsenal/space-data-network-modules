// fit_batch version 2 (schema extension v4), end to end through the WASM.
//
// Closed-form cases use the static model (state = seed, STM = I; no
// dynamics) so the expected estimate and covariance follow from linear
// algebra alone; the dynamical cases are answered by propagator/hpop at full
// force and compared with Orekit or with the truth that simulated the data.
// Units SI, GCRF, epochs UTC from 2026-08-02T00:00:00.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { harness } from './batch-fit-fixtures.mjs';
import { BLOCK, CONSIDER, LEO, STATE, blockEnvelope, considerEnvelope, leoEnvelope, orekitAnswerer } from './batch-fit-v2-fixtures.mjs';
import { replayDigests, v1Cases } from './fit-batch-v1-cases.mjs';
import {
  ECOM2_FIELDS, ECOM2_NAMES, covarianceBlock, fitEnvelope, hpopAnswerer, hpopRun, identityAnswerer, inverse, mahalanobis,
  measurementParameter, normals, runFit,
} from './batch-fit-v2-lib.mjs';
import { makeTable, sds } from '../../../propagator/hpop/tests/lib/prwCodec.mjs';

const V1 = JSON.parse(fs.readFileSync(new URL('./fixtures/fit-batch-v1-digests.json', import.meta.url), 'utf8'));
const close = (a, b, tolerance, what) => assert.ok(Math.abs(a - b) <= tolerance, `${what}: ${a} vs ${b} (tolerance ${tolerance})`);

// Rows R, T, N of the RTN axes of (r, v), request axes.
function rtnRows(r, v) {
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const unit = (a) => { const n = Math.hypot(...a); return a.map((x) => x / n); };
  const R = unit(r), N = unit(cross(r, v)), T = cross(N, R);
  return [R, T, N];
}

test('version-1 requests give the version-1 bytes (every query round and the result)', async (t) => {
  // Reference: tests/fixtures/fit-batch-v1-digests.json, written by the
  // version-1 artifact (37a0801f, 786d0de9...) with propagator/hpop
  // answering; the same request bytes in must give the same result bytes out.
  const estimator = await harness('../');
  const hpop = await harness('../../../propagator/hpop/');
  t.after(() => { estimator.destroy?.(); hpop.destroy?.(); });
  for (const entry of v1Cases()) {
    const rounds = await replayDigests(estimator, hpop, entry);
    assert.deepEqual(rounds, V1.cases[entry.id], entry.id);
  }
});

test('a covariance block that is not positive definite is refused, or regularized on its correlation matrix', async (t) => {
  // Three full-state observations with equicorrelated errors, rho = -0.6, per
  // component sigmas 10, 20, 30 m and 0.1, 0.2, 0.3 m/s: C = R kron diag(s^2).
  // R = (1 - rho) I + rho 11' has eigenvalues 1 + 2 rho = -0.2 (on 1) and
  // 1 - rho (twice), so C is not positive definite. The floor f = 1e-3 raises
  // the six copies of -0.2: R' = R + (f + 0.2)/3 11', rescaled to unit
  // diagonal, rho'' = (rho + (f + 0.2)/3) / (1 + (f + 0.2)/3). By symmetry the
  // generalized least squares estimate is the mean of the three states and
  // its covariance diag(s^2) (1 + 2 rho'') / 3. Tolerances: 1e-9 m and
  // relative 1e-8 (conditioning (1 + 2 rho'') ~ 6e-4 of the eigenvalues).
  const estimator = await harness('../');
  t.after(() => estimator.destroy?.());
  const { s, rho, floor: f, offsets } = BLOCK;
  const refused = await runFit(estimator, blockEnvelope(false), identityAnswerer());
  assert.match(refused.error, /covariance block is not positive definite/);

  const { result, error } = await runFit(estimator, blockEnvelope(true), identityAnswerer());
  assert.equal(error, undefined, error);
  assert.equal(result.status, 0);
  const b = result.batchFit, d = (f + 0.2) / 3, rho2 = (rho + d) / (1 + d);
  assert.equal(b.regularizations.length, 1);
  const g = b.regularizations[0];
  assert.equal(g.block, 0);
  assert.equal(g.observation, 0);
  assert.equal(g.dimension, 18);
  assert.equal(g.raised, 6);
  close(g.minimumEigenvalue, 1 + 2 * rho, 1e-12, 'smallest eigenvalue');
  close(g.maximumCorrelationChange, rho2 - rho, 1e-12, 'largest correlation change');
  close(g.frobeniusChange, (rho2 - rho) * Math.sqrt(6 / (3 + 6 * rho * rho)), 1e-12, 'Frobenius change');
  for (let i = 0; i < 6; ++i) {
    const mean = STATE[i] + (offsets[0][i] + offsets[1][i] + offsets[2][i]) / 3;
    close(b.estimate[i], mean, 1e-9 * Math.max(1, Math.abs(mean)), `estimate ${i}`);
    const variance = s[i] * s[i] * (1 + 2 * rho2) / 3;
    close(b.covariance[i * 6 + i], variance, 1e-8 * variance, `variance ${i}`);
  }
});

test('a covariance block correlates observations across epochs (generalized least squares, RTN axes)', async (t) => {
  // Two full-state observations, one 12 x 12 covariance stated in each
  // observation's RTN axes (covariance_axes 1) with cross-epoch terms. The
  // reference rotates it to GCRF, C = D' C_rtn D (D: each observed state's
  // R, T, N rows on position and velocity), and solves
  // x = (A' C^-1 A)^-1 A' C^-1 z with A = [I; I]. Tolerance relative 1e-10.
  const estimator = await harness('../');
  t.after(() => estimator.destroy?.());
  const z = [STATE.map((x, i) => x + [5, -3, 2, 0.02, -0.01, 0.03][i]), STATE.map((x, i) => x + [-2, 4, -1, -0.01, 0.03, 0.01][i])];
  // C_rtn = L L' with a fixed lower-triangular L (correlated, positive definite).
  const n = 12, L = Array(n * n).fill(0);
  const s = [30, 300, 20, 0.3, 0.05, 0.2];
  for (let i = 0; i < n; ++i) for (let j = 0; j <= i; ++j) L[i * n + j] = i === j ? s[i % 6] : 0.35 * s[i % 6] * Math.sin(1 + i * 7 + j * 3);
  const crtn = Array(n * n).fill(0);
  for (let i = 0; i < n; ++i) for (let j = 0; j < n; ++j) { let v = 0; for (let k = 0; k < n; ++k) v += L[i * n + k] * L[j * n + k]; crtn[i * n + j] = v; }
  for (let i = 0; i < n; ++i) for (let j = 0; j < i; ++j) crtn[i * n + j] = crtn[j * n + i];
  const observations = z.map((values, j) => ({ seconds: 120 * j, kind: 'POSITION_VELOCITY', values }));
  const { result, error } = await runFit(estimator, fitEnvelope({ state: STATE, observations, options: { covarianceBlocks: [covarianceBlock([0, 1], crtn)], covarianceAxes: 1 } }), identityAnswerer());
  assert.equal(error, undefined, error);
  const D = Array(n * n).fill(0);
  z.forEach((zj, j) => {
    const rows = rtnRows(zj.slice(0, 3), zj.slice(3));
    for (const base of [6 * j, 6 * j + 3]) for (let a = 0; a < 3; ++a) for (let b = 0; b < 3; ++b) D[(base + a) * n + base + b] = rows[a][b];
  });
  const c = Array(n * n).fill(0);
  for (let i = 0; i < n; ++i) for (let j = 0; j < n; ++j) { let v = 0; for (let a = 0; a < n; ++a) for (let b = 0; b < n; ++b) v += D[a * n + i] * crtn[a * n + b] * D[b * n + j]; c[i * n + j] = v; }
  const ci = inverse(c, n), N = Array(36).fill(0), rhs = Array(6).fill(0);
  for (let j = 0; j < 2; ++j) for (let k = 0; k < 2; ++k) for (let a = 0; a < 6; ++a) for (let b = 0; b < 6; ++b) {
    N[a * 6 + b] += ci[(6 * j + a) * n + 6 * k + b];
    rhs[a] += ci[(6 * j + a) * n + 6 * k + b] * z[k][b];
  }
  const P = inverse(N, 6), x = [0, 1, 2, 3, 4, 5].map((a) => [0, 1, 2, 3, 4, 5].reduce((sum, b) => sum + P[a * 6 + b] * rhs[b], 0));
  for (let i = 0; i < 6; ++i) close(result.batchFit.estimate[i], x[i], 1e-10 * Math.abs(x[i]), `estimate ${i}`);
  for (let i = 0; i < 36; ++i) close(result.batchFit.covariance[i], P[i], 1e-10 * Math.sqrt(P[(i / 6 | 0) * 7] * P[(i % 6) * 7]), `covariance ${i}`);
});

test('RTN covariance axes take a request that mixes full states, positions and ranges; the covariance is reported in RTN', async (t) => {
  // A POSITION_VELOCITY state (its own RTN axes), a POSITION_VECTOR (the RTN
  // axes of the observed position and the predicted velocity) and a RANGE
  // (its one component) with covariance_axes 1 — version 1 refused it. At
  // the converged estimate the generalized least-squares gradient
  // J' C^-1 (z - h(x)) must vanish and the covariance be (J' C^-1 J)^-1, with
  // C rotated by the reference here; covariance_rtn = D P D' with D the RTN
  // rows of the estimated state. Tolerances: the step that gradient implies,
  // P g, below 1e-6 sigma per component (a mis-weighted observation moves the
  // optimum by a sizeable fraction of sigma); the covariance and its rotation
  // relative 1e-9.
  const estimator = await harness('../');
  t.after(() => estimator.destroy?.());
  const station = [6378e3, 0, 0];
  const pv = STATE.map((x, i) => x + [4, -2, 1, 0.01, 0.02, -0.01][i]);
  const position = STATE.slice(0, 3).map((x, i) => x + [-3, 1, 2][i]);
  const range = Math.hypot(...STATE.slice(0, 3).map((x, i) => x - station[i])) + 1.5;
  const cpv = [100, 0, 0, 0, 0, 0, 0, 2500, 10, 0, 0, 0, 0, 10, 400, 0, 0, 0, 0, 0, 0, 0.01, 0, 0, 0, 0, 0, 0, 0.04, 0, 0, 0, 0, 0, 0, 0.02];
  const cpos = [25, 5, 0, 5, 900, 0, 0, 0, 16];
  const observations = [
    { seconds: 0, kind: 'POSITION_VELOCITY', values: pv },
    { seconds: 30, kind: 'POSITION_VECTOR', values: position },
    { seconds: 60, kind: 'RANGE', values: [range], fields: { station_position_m: station } },
  ];
  const { result, error } = await runFit(estimator, fitEnvelope({ state: STATE, observations, options: { observationCovariances: [...cpv, ...cpos, 4], covarianceAxes: 1, rtnCovariance: true, correctionTolerance: 1e-8 } }), identityAnswerer());
  assert.equal(error, undefined, error);
  assert.equal(result.status, 0);
  const b = result.batchFit, x = b.estimate;
  // Rotate each stated covariance to GCRF and stack J (10 x 6) and r.
  const rotate = (cm, rows, m) => {  // D' C D, D = blockdiag(rows) on each 3-vector
    const out = Array(m * m).fill(0);
    for (let i = 0; i < m; ++i) for (let j = 0; j < m; ++j) {
      let v = 0;
      for (let k = 0; k < 3; ++k) for (let l = 0; l < 3; ++l) v += rows[k][i % 3] * cm[(((i / 3) | 0) * 3 + k) * m + ((j / 3) | 0) * 3 + l] * rows[l][j % 3];
      out[i * m + j] = v;
    }
    return out;
  };
  const c1 = rotate(cpv, rtnRows(pv.slice(0, 3), pv.slice(3)), 6);
  const c2 = rotate(cpos, rtnRows(position, x.slice(3, 6)), 3);
  const rho = Math.hypot(...x.slice(0, 3).map((v, i) => v - station[i]));
  const u = x.slice(0, 3).map((v, i) => (v - station[i]) / rho);
  const J = [...[0, 1, 2, 3, 4, 5].map((i) => [0, 1, 2, 3, 4, 5].map((k) => (i === k ? 1 : 0))),
    ...[0, 1, 2].map((i) => [0, 1, 2, 3, 4, 5].map((k) => (i === k ? 1 : 0))), [...u, 0, 0, 0]];
  const res = [...pv.map((v, i) => v - x[i]), ...position.map((v, i) => v - x[i]), range - rho];
  const W = Array(100).fill(0);
  const w1 = inverse(c1, 6), w2 = inverse(c2, 3);
  for (let i = 0; i < 6; ++i) for (let j = 0; j < 6; ++j) W[i * 10 + j] = w1[i * 6 + j];
  for (let i = 0; i < 3; ++i) for (let j = 0; j < 3; ++j) W[(6 + i) * 10 + 6 + j] = w2[i * 3 + j];
  W[99] = 1 / 4;
  const Wr = res.map((_, i) => res.reduce((s, r, j) => s + W[i * 10 + j] * r, 0));
  const gradient = [0, 1, 2, 3, 4, 5].map((k) => J.reduce((sum, row, i) => sum + row[k] * Wr[i], 0));
  const N = Array(36).fill(0);
  for (let a = 0; a < 6; ++a) for (let b2 = 0; b2 < 6; ++b2) for (let i = 0; i < 10; ++i) for (let j = 0; j < 10; ++j) N[a * 6 + b2] += J[i][a] * W[i * 10 + j] * J[j][b2];
  const P = inverse(N, 6);
  for (let k = 0; k < 6; ++k) {
    const step = [0, 1, 2, 3, 4, 5].reduce((sum, j) => sum + P[k * 6 + j] * gradient[j], 0);
    close(step, 0, 1e-6 * Math.sqrt(P[k * 7]), `implied step ${k}`);
  }
  for (let i = 0; i < 36; ++i) close(b.covariance[i], P[i], 1e-9 * Math.sqrt(P[(i / 6 | 0) * 7] * P[(i % 6) * 7]), `covariance ${i}`);
  const rows = rtnRows(x.slice(0, 3), x.slice(3, 6));
  const D = Array(36).fill(0);
  for (const base of [0, 3]) for (let a = 0; a < 3; ++a) for (let k = 0; k < 3; ++k) D[(base + a) * 6 + base + k] = rows[a][k];
  for (let i = 0; i < 6; ++i) for (let j = 0; j < 6; ++j) {
    let v = 0;
    for (let a = 0; a < 6; ++a) for (let k = 0; k < 6; ++k) v += D[i * 6 + a] * b.covariance[a * 6 + k] * D[j * 6 + k];
    close(b.covarianceRtn[i * 6 + j], v, 1e-9 * Math.sqrt(b.covarianceRtn[i * 7] * b.covarianceRtn[j * 7]), `RTN covariance ${i},${j}`);
  }
});

test('consider parameters enter the covariance as P + S Pc S\' with S = -P Hx\' W Hc (Schmidt)', async (t) => {
  // Static model, four full-state observations with sigmas s, a weak a priori
  // (1000 km, 1 km/s) on the state, and two consider parameters: a dynamic
  // parameter whose sensitivity is the column g (sigma 0.5) and a bias on
  // component 0 of every observation (value 2 m, sigma 3 m). Per component
  // i: P_ii = 1 / (4 / s_i^2 + 1 / p0_i^2), S = -P M with
  // M = 4 W [g, e0], so the consider covariance is
  // P + 0.25 S_g S_g' + 9 S_b S_b' and the cross terms S Pc. The bias, held at
  // 2 m, moves x_0 by -2 m: x = P (4 W (mean z - 2 e0) + P0^-1 x0).
  // Tolerance relative 1e-12.
  const estimator = await harness('../');
  t.after(() => estimator.destroy?.());
  const { s, p0, g, offsets } = CONSIDER;
  const { result, error } = await runFit(estimator, considerEnvelope(), identityAnswerer(g));
  assert.equal(error, undefined, error);
  const b = result.batchFit, n = 8;
  assert.equal(b.measurementParameterCount, 1);
  assert.equal(b.estimate.length, n);
  close(b.estimate[6], 0.01, 0, 'the consider parameter keeps its value');
  close(b.estimate[7], 2, 0, 'the consider bias keeps its value');
  const P = s.map((si, i) => 1 / (4 / (si * si) + 1 / (p0[i] * p0[i])));
  const Sg = P.map((pi, i) => -pi * 4 * g[i] / (s[i] * s[i]));
  const Sb = P.map((pi, i) => (i === 0 ? -pi * 4 / (s[0] * s[0]) : 0));
  for (let i = 0; i < 6; ++i) {
    const mean = STATE[i] + offsets.reduce((sum, o) => sum + o[i], 0) / 4 - (i === 0 ? 2 : 0);
    const x = P[i] * (4 * mean / (s[i] * s[i]) + STATE[i] / (p0[i] * p0[i]));
    close(b.estimate[i], x, 1e-12 * Math.abs(x), `estimate ${i}`);
    for (let j = 0; j < 6; ++j) {
      const formal = i === j ? P[i] : 0;
      close(b.covariance[i * n + j], formal, 1e-12 * Math.sqrt(P[i] * P[j]), `formal ${i},${j}`);
      const consider = formal + 0.25 * Sg[i] * Sg[j] + 9 * Sb[i] * Sb[j];
      close(b.considerCovariance[i * n + j], consider, 1e-12 * Math.sqrt(P[i] * P[j]) + 1e-12 * Math.abs(consider), `consider ${i},${j}`);
    }
    close(b.considerCovariance[i * n + 6], 0.25 * Sg[i], 1e-12 * Math.abs(0.25 * Sg[i]) + 1e-18, `cross g ${i}`);
    close(b.considerCovariance[i * n + 7], 9 * Sb[i], 1e-12 * Math.abs(9 * Sb[i]) + 1e-18, `cross bias ${i}`);
  }
  close(b.considerCovariance[6 * n + 6], 0.25, 0, 'consider variance g');
  close(b.considerCovariance[7 * n + 7], 9, 0, 'consider variance bias');
  close(b.covariance[6 * n + 6], 0.25, 0, 'formal covariance keeps the consider variance');
});

test('fit_batch applies the request\'s error models: troposphere and ionosphere delays as Orekit and ITU-R P.531 give them', async (t) => {
  // Static target 7000 km out, four stations about it, observed with the
  // geometric range plus each model's published delay (the module's own
  // authoritative values, tests/native_conformance.cpp): LASER_RANGE with
  // Marini-Murray at 10 deg elevation, 45 deg latitude, 100 m, 1013.25 hPa,
  // 293.15 K, 50 %, 694.3 nm: 13.2611 m (Orekit); RANGE with
  // Saastamoinen-Hopfield at 5 deg, 37.5 deg, 824 m: 24.26096 m (Orekit)
  // plus the P.531 Table 3 group delay of TEC 1e18 at 1 GHz:
  // c * 1.345e-7 s. With the error models the fit recovers the target
  // within 1 cm (the models agree with Orekit to 1e-4, 1.3 and 2.4 mm,
  // times the geometry); without them it is metres off.
  const estimator = await harness('../');
  t.after(() => estimator.destroy?.());
  const target = [7000e3, 100e3, 200e3, 0, 0, 0];
  const stations = [[6378e3, 0, 0], [6000e3, 2000e3, 0], [6000e3, -1500e3, 1500e3], [6100e3, 500e3, -1800e3]];
  const marini = { elevation_rad: 10 * Math.PI / 180, station_latitude_rad: Math.PI / 4, station_height_m: 100, pressure_hpa: 1013.25, temperature_k: 293.15, relative_humidity: 0.5, wavelength_m: 694.3e-9 };
  const saastamoinen = { elevation_rad: 5 * Math.PI / 180, station_latitude_rad: 37.5 * Math.PI / 180, station_height_m: 824, pressure_hpa: 1013.25, temperature_k: 293.15, relative_humidity: 0.5, total_electron_content: 1e18, frequency_hz: 1e9 };
  const delay = { LASER_RANGE: 13.2611, RANGE: 24.26096 + 299792458 * 1.345e-7 };
  const observations = [];
  stations.forEach((st, k) => ['LASER_RANGE', 'RANGE'].forEach((kind, m) => observations.push({
    seconds: 10 * (2 * k + m), kind, values: [Math.hypot(...target.slice(0, 3).map((x, i) => x - st[i])) + delay[kind]], sigmas: [0.01],
    fields: { station_position_m: st, ...(kind === 'LASER_RANGE' ? marini : saastamoinen) },
  })));
  const apriori = Array(36).fill(0);
  [1e6, 1e6, 1e6, 1e-3, 1e-3, 1e-3].forEach((v, i) => { apriori[i * 7] = v * v; });
  const model = (kind, troposphere, ionosphere) => ({ noise_sigma: 0, bias: 0, bias_sigma: 0, correlation_time_seconds: 0, minimum_value: 0, maximum_value: 0,
    sigma_edit_threshold: 0, random_seed: 1, measurement_kind: kind, troposphere, ionosphere, flags: 3 });
  const start = target.map((x, i) => x + [500, -300, 200, 0, 0, 0][i]);
  const fitWith = async (errorModels) => (await runFit(estimator, fitEnvelope({ state: start, observations, options: { aprioriCovariance: apriori }, errorModels }), identityAnswerer())).result.batchFit.estimate;
  const corrected = await fitWith([model('LASER_RANGE', 'MARINI', 'NONE'), model('RANGE', 'HOPFIELD_SAASTAMOINEN', 'TOTAL_ELECTRON_CONTENT')]);
  const plain = await fitWith(undefined);
  const miss = (x) => Math.hypot(...x.slice(0, 3).map((v, i) => v - target[i]));
  t.diagnostic(`with error models ${miss(corrected).toExponential(3)} m from the target; without ${miss(plain).toFixed(2)} m`);
  assert.ok(miss(corrected) <= 0.01, `with error models: ${miss(corrected)} m`);
  assert.ok(miss(plain) >= 5, `without error models: ${miss(plain)} m`);
});

// ---------------------------------------------------------------------------
// Positivity-constrained parameters, against Orekit 13.1's BatchLSEstimator
// (tests/fixtures/orekit-batch-reference.json; batch_fit.test.mjs states its
// authority): LEO 400 km, 288 positions over 24 h, sigma 5 m, solve-for
// state and B = Cd*A/m (truth 0.044 m^2/kg), propagator/hpop answering with
// the Orekit case's forces. The tolerances are batch_fit.test.mjs's: the
// estimate within 5e-3 of Orekit's formal sigma, every covariance entry
// within 1e-4 of sqrt(Pii Pjj), chi-square within 1e-4 relative.
function assertOrekit(b, c, label) {
  const ref = c.orekit, P = ref.covariance, n = 7;
  const sigma = (i) => Math.sqrt(P[i * n + i]);
  const gap = Math.max(...[0, 1, 2, 3, 4, 5, 6].map((i) => Math.abs(b.estimate[i] - ref.estimate[i]) / sigma(i)));
  let cov = 0;
  for (let i = 0; i < n; ++i) for (let j = 0; j < n; ++j) cov = Math.max(cov, Math.abs(b.covariance[i * n + j] - P[i * n + j]) / (sigma(i) * sigma(j)));
  const chi = Math.abs(b.chiSquare - ref.chiSquare) / ref.chiSquare;
  assert.ok(gap <= 5e-3, `${label}: estimate ${gap} sigma from Orekit`);
  assert.ok(cov <= 1e-4, `${label}: covariance ${cov} from Orekit`);
  assert.ok(chi <= 1e-4, `${label}: chi-square ${chi} from Orekit`);
  return { gap, cov, chi };
}
const orekitFit = (estimator, hpop, envelope) => runFit(estimator, envelope, orekitAnswerer(hpop));

test('bounded, logarithmic and damped B match Orekit on the LEO drag case; LOGARITHM reports its covariance in B', async (t) => {
  const estimator = await harness('../');
  const hpop = await harness('../../../propagator/hpop/');
  t.after(() => { estimator.destroy?.(); hpop.destroy?.(); });
  for (const [label, options] of [
    ['lower bound 0', { parameterLowerBounds: [0] }],
    ['LOGARITHM', { parameterTransforms: [1] }],
    ['Levenberg-Marquardt', { levenbergMarquardt: true }],
    ['lower bound 0 and Levenberg-Marquardt', { parameterLowerBounds: [0], levenbergMarquardt: true }],
  ]) {
    const { result, error, rounds } = await orekitFit(estimator, hpop, leoEnvelope(undefined, undefined, options));
    assert.equal(error, undefined, `${label}: ${error}`);
    assert.equal(result.status, 0, label);
    const { gap, cov, chi } = assertOrekit(result.batchFit, LEO, label);
    if (options.parameterTransforms || options.parameterLowerBounds) assert.deepEqual([...result.batchFit.boundStatus], [0], label);
    t.diagnostic(`${label}: ${rounds} rounds; estimate ${gap.toExponential(2)} sigma, covariance ${cov.toExponential(2)}, chi-square ${chi.toExponential(2)} from Orekit`);
  }
});

test('where version 1 proposes a negative Cd*A/m (refused by propagator/hpop), the bounded and logarithmic fits never do and reach Orekit\'s solution', async (t) => {
  // Three first guesses (the Orekit case's a priori state moved by 20 km
  // along track, -20 m/s, or 50 km radially). Version 1's second query
  // carries a negative B, which propagator/hpop refuses ("Spacecraft mass,
  // area, Cd and Cr are invalid"); E4 lost 154/298 Starlink arcs this way.
  // With a lower bound of 0, or estimated as ln B, every query is >= 0 and
  // the fit converges to Orekit's estimate from the same data.
  const estimator = await harness('../');
  const hpop = await harness('../../../propagator/hpop/');
  t.after(() => { estimator.destroy?.(); hpop.destroy?.(); });
  const starts = [['20 km along track', [0, 20e3, 0, 0, 0, 0], 0.036], ['-20 m/s', [0, 0, 0, -20, 0, 0], 0.01], ['50 km radial', [50e3, 0, 0, 0, 0, 0], 0.02]];
  const start = leoEnvelope;
  for (const [label, offset, b0] of starts) {
    // Version 1: the first answered round, then the negative proposal.
    const v1 = start(offset, b0);
    let proposal = null;
    await runFit(estimator, v1, async (queries) => {
      const b = queries[0].parameterValues[0];
      if (b < 0) { proposal = b; throw Object.assign(new Error('negative'), { negative: b }); }
      return orekitAnswerer(hpop)(queries);
    }).catch((e) => { if (!e.negative) throw e; });
    assert.ok(proposal !== null && proposal < 0, `${label}: version 1 proposes ${proposal}`);
    for (const [variant, options] of [['lower bound 0', { parameterLowerBounds: [0] }], ['LOGARITHM', { parameterTransforms: [1] }]]) {
      const { result, error, queried, rounds } = await orekitFit(estimator, hpop, start(offset, b0, options));
      assert.equal(error, undefined, `${label}, ${variant}: ${error}`);
      const smallest = Math.min(...queried.map((q) => q.parameterValues[0]));
      assert.ok(variant === 'LOGARITHM' ? smallest > 0 : smallest >= 0, `${label}, ${variant}: proposed ${smallest}`);
      assert.equal(result.status, 0, `${label}, ${variant}`);
      const { gap } = assertOrekit(result.batchFit, LEO, `${label}, ${variant}`);
      t.diagnostic(`${label}: version 1 proposed B = ${proposal.toExponential(3)}; ${variant}: ${rounds} rounds, smallest B ${smallest.toExponential(3)}, ${gap.toExponential(2)} sigma from Orekit`);
    }
  }
});

// ---------------------------------------------------------------------------
// HPOP-simulated arcs: the truth that generated the data is the reference.
// propagator/hpop at full force (EGM2008 70 x 70, Sun and Moon, radiation
// pressure, NRLMSISE-00 drag with CSSI weather, IERS 2010 solid tides,
// relativity) simulates positions from the Orekit LEO case's true state;
// noise is deterministic (seeded) Gaussian. Mass and area are 1, so B is
// the drag coefficient (m^2/kg).
const at = (seconds) => ({ jdDay: 2461254.5, seconds });
async function simulatePositions(hpop, { seconds, names, values, sigma, seed, edit, coefficients }) {
  const runs = await hpopRun(hpop, { state: LEO.truth, from: at(0), epochs: seconds.map(at), names, values, edit, coefficients });
  const noise = normals(seed);
  return seconds.map((t, k) => ({ seconds: t, kind: 'POSITION_VECTOR', values: runs[k].state.slice(0, 3).map((x) => x + sigma * noise()), sigmas: [sigma, sigma, sigma] }));
}
// The chi-square quantile by Wilson-Hilferty (accurate to 1e-3 relative here).
const chiSquareQuantile = (k, z) => k * (1 - 2 / (9 * k) + z * Math.sqrt(2 / (9 * k))) ** 3;

test('a fit that wants negative drag stops at B = 0 and says so; with a signed in-track acceleration it recovers both', async (t) => {
  // Truth: B = 0.002 m^2/kg and a constant in-track thrust of +2e-7 m/s^2
  // (a drag make-up), positions every 10 min over 12 h, sigma 1 m. Fitting
  // B >= 0 alone, the data ask for B < 0: B is held at its bound
  // (bound_status 1), no query is negative, and the fit converges. Fitting
  // B >= 0 with IN_TRACK_ACCELERATION (signed, free), both are recovered:
  // Mahalanobis distance of (state, B, a_T) from the truth below the
  // chi-square(8) 0.9999 quantile, 30.0.
  const estimator = await harness('../');
  const hpop = await harness('../../../propagator/hpop/');
  t.after(() => { estimator.destroy?.(); hpop.destroy?.(); });
  const seconds = Array.from({ length: 72 }, (_, k) => 600 * (k + 1));
  const truth = { B: 0.002, T: 2e-7 };
  const observations = await simulatePositions(hpop, { seconds, names: ['DRAG_AREA_OVER_MASS', 'IN_TRACK_ACCELERATION'], values: [truth.B, truth.T], sigma: 1, seed: 20261010 });
  const start = LEO.truth.map((x, i) => x + [200, -300, 100, 0.2, 0.1, -0.1][i]);

  const alone = await runFit(estimator, fitEnvelope({ state: start, observations, kinds: [sds.prwDynamicParameter.DRAG_AREA_OVER_MASS], values: [0.01], options: { parameterLowerBounds: [0] } }),
    hpopAnswerer(hpop, { names: ['DRAG_AREA_OVER_MASS'] }));
  assert.equal(alone.error, undefined, alone.error);
  assert.equal(alone.result.status, 0);
  assert.ok(Math.min(...alone.queried.map((q) => q.parameterValues[0])) >= 0, 'no negative B was asked');
  assert.equal(alone.result.batchFit.estimate[6], 0);
  assert.deepEqual([...alone.result.batchFit.boundStatus], [1]);

  const kinds = [sds.prwDynamicParameter.DRAG_AREA_OVER_MASS, sds.prwDynamicParameter.IN_TRACK_ACCELERATION];
  const both = await runFit(estimator, fitEnvelope({ state: start, observations, kinds, values: [0.01, 0], options: { parameterLowerBounds: [0, NaN] } }),
    hpopAnswerer(hpop, { names: ['DRAG_AREA_OVER_MASS', 'IN_TRACK_ACCELERATION'] }));
  assert.equal(both.error, undefined, both.error);
  assert.equal(both.result.status, 0);
  const b = both.result.batchFit;
  const truthVector = [...(await hpopRun(hpop, { state: LEO.truth, from: at(0), epochs: [at(0)], names: ['DRAG_AREA_OVER_MASS', 'IN_TRACK_ACCELERATION'], values: [truth.B, truth.T] }))[0].state, truth.B, truth.T];
  const d2 = mahalanobis(b.estimate.map((v, i) => v - truthVector[i]), b.covariance, 8);
  t.diagnostic(`alone: ${alone.rounds} rounds, B held at 0, weighted RMS ${alone.result.batchFit.weightedRms.toFixed(1)}; with a_T: ${both.rounds} rounds, B ${b.estimate[6].toExponential(4)} (sigma ${Math.sqrt(b.covariance[54]).toExponential(2)}), a_T ${b.estimate[7].toExponential(4)} (sigma ${Math.sqrt(b.covariance[63]).toExponential(2)}), d2 ${d2.toFixed(2)}, weighted RMS ${b.weightedRms.toFixed(3)}`);
  assert.ok(d2 < chiSquareQuantile(8, 3.719), `d2 ${d2}`);
});

test('thirteen dynamic parameters at once: B, the eleven ECOM2 terms and the in-track acceleration', async (t) => {
  // Truth: B = 0.01 m^2/kg, ECOM2 coefficients of a few 1e-8 m/s^2 (radiation
  // pressure through ECOM2 only), in-track 5e-9 m/s^2; positions every 2 min
  // over 24 h, sigma 0.1 m. A priori: the state 1 km, 1 m/s; B 0.01 about
  // 0.012; each acceleration 1e-7 m/s^2 about 0 (the truth lies within it).
  // Version 1 refused more than four parameters. The 19-dimensional
  // Mahalanobis distance of the estimate from the truth must be below the
  // chi-square(19) 0.9999 quantile, 48.4.
  const estimator = await harness('../');
  const hpop = await harness('../../../propagator/hpop/');
  t.after(() => { estimator.destroy?.(); hpop.destroy?.(); });
  const names = ['DRAG_AREA_OVER_MASS', ...ECOM2_NAMES, 'IN_TRACK_ACCELERATION'];
  const truth = [0.01, 3e-8, -2e-8, 1e-8, 2e-8, -1e-8, 5e-9, -5e-9, 1.5e-8, -1e-8, 8e-9, -6e-9, 5e-9];
  const start = [0.012, ...Array(12).fill(0)];
  const ecom2 = (exec) => {
    exec.FORCES.RADIATION_PRESSURE_MODEL = sds.prwRadiationPressureFamily.NONE;
    exec.FORCES.ECOM2 = makeTable('PRWEcom2', Object.fromEntries(ECOM2_FIELDS.map((k) => [k, 0])));
  };
  const seconds = Array.from({ length: 720 }, (_, k) => 120 * (k + 1));
  const observations = await simulatePositions(hpop, { seconds, names, values: truth, sigma: 0.1, seed: 13, edit: ecom2 });
  const sigmas = [1e3, 1e3, 1e3, 1, 1, 1, 0.01, ...Array(12).fill(1e-7)];
  const apriori = Array(19 * 19).fill(0);
  sigmas.forEach((v, i) => { apriori[i * 20] = v * v; });
  const initial = LEO.truth.map((x, i) => x + [300, -200, 100, 0.1, -0.2, 0.1][i]);
  const { result, error, rounds } = await runFit(estimator, fitEnvelope({ state: initial, observations, kinds: names.map((n) => sds.prwDynamicParameter[n]), values: start, options: { aprioriCovariance: apriori } }),
    hpopAnswerer(hpop, { names, edit: ecom2 }));
  assert.equal(error, undefined, error);
  assert.equal(result.status, 0);
  const b = result.batchFit;
  assert.equal(b.estimate.length, 19);
  const truthVector = [...(await hpopRun(hpop, { state: LEO.truth, from: at(0), epochs: [at(0)], names, values: truth, edit: ecom2 }))[0].state, ...truth];
  const d2 = mahalanobis(b.estimate.map((v, i) => v - truthVector[i]), b.covariance, 19);
  const z = b.estimate.slice(6).map((v, i) => ((v - truth[i]) / Math.sqrt(b.covariance[(6 + i) * 20])).toFixed(2));
  t.diagnostic(`${rounds} rounds; d2 ${d2.toFixed(2)}; parameter errors in sigma: ${z.join(' ')}; weighted RMS ${b.weightedRms.toFixed(3)}`);
  assert.ok(d2 < chiSquareQuantile(19, 3.719), `d2 ${d2}`);
});

// pair_statistics, fit_calibration, calibrate_covariance and dcp_covariance (orbit-accuracy-experiments E14).
// Every expected value is computed here in closed form from designed inputs, independently of the module:
// - d^2 of designed RTN errors under diagonal covariances (sums of squares), and its invariance when the whole
//   configuration (states, error, covariance) is rotated by a known rotation;
// - factors from designed samples: k^2 = mean |e|^2 / 3 under unit covariance, the type-7 quantile of d^2 over
//   the chi-square(3) 0.95 quantile (7.814727903251178, NIST/SEMATECH table value 7.815), per-axis mean squares;
// - calibrated covariances: diagonal scalings and the rotation of a diagonal RTN covariance to inertial axes;
//   linear interpolation of two bins at their midpoint;
// - DCP weights: 2 * integral of (t - s) over each whole day / t^2 at t = 3 days is 5/9, 3/9, 1/9 (Hejduk 2019);
//   sigma_eff^2 = w' C w; the start-relative sensitivity S(t) - Phi(t) Phi(s0)^-1 S(s0) for designed matrices.
import assert from 'node:assert/strict';
import test from 'node:test';
import { json, call as ermCall, invoke } from './erm-harness.mjs';

// Each port's value in its readable form; the harness sends it as the method's $ERM record and decodes the output.
const call = (t, methodId, inputs) => ermCall(methodId, inputs);
async function refused(t, methodId, inputs, pattern) {
  const r = await invoke(methodId, inputs);
  assert.notEqual(r.statusCode, 0);
  assert.match(r.errorMessage ?? '', pattern);
}
const close = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${what}: ${a} vs ${b}`);
const lower = (m) => [m[0][0], m[1][0], m[1][1], m[2][0], m[2][1], m[2][2]];
// A rotation about z by 30 degrees then about x by 50 degrees (row-major 3x3), and its use on vectors and matrices.
const rot = (() => {
  const a = 30 * Math.PI / 180, b = 50 * Math.PI / 180;
  const rz = [[Math.cos(a), -Math.sin(a), 0], [Math.sin(a), Math.cos(a), 0], [0, 0, 1]];
  const rx = [[1, 0, 0], [0, Math.cos(b), -Math.sin(b)], [0, Math.sin(b), Math.cos(b)]];
  return rx.map((row) => [0, 1, 2].map((j) => row.reduce((s, x, k) => s + x * rz[k][j], 0)));
})();
const apply = (q, v) => q.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
const sandwich = (q, m) => q.map((ri) => q.map((rj) => [0, 1, 2].reduce((s, a) => s + ri[a] * [0, 1, 2].reduce((u, b) => u + m[a][b] * rj[b], 0), 0)));

test('pair_statistics: RTN error, d^2 combined and predicted alone, per-axis z; invariant under a rotation of the whole case', async (t) => {
  // Predicted state on the x axis moving along y: R = x, T = y, N = z. Truth displaced so predicted - truth = (10, -200, 5) m in RTN.
  const rp = [7000e3, 0, 0], vp = [0, 7500, 0];
  const e = [10, -200, 5];
  const rt = rp.map((x, i) => x - e[i]);
  const P = [[100, 0, 0], [0, 10000, 0], [0, 0, 25]], Tc = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const pairs = { pairs: [{ id: 'a', predicted: { position: rp, velocity: vp, covariance: lower(P), covarianceAxes: 'RTN' },
    truth: { position: rt, velocity: vp, covariance: lower(Tc), covarianceAxes: 'RTN' } }] };
  const out = await call(t, 'pair_statistics', [json('pairs', pairs)]);
  const p = out.pairs[0];
  p.errorRtn.forEach((x, k) => close(x, e[k], 1e-9, `error ${k}`));
  close(p.d2Predicted, 100 / 100 + 40000 / 10000 + 25 / 25, 1e-12, 'd2 predicted');
  close(p.d2Combined, 100 / 101 + 40000 / 10001 + 25 / 26, 1e-12, 'd2 combined');
  close(p.zPredicted[1], -200 / 100, 1e-12, 'z_T predicted');
  close(p.zCombined[0], 10 / Math.sqrt(101), 1e-12, 'z_R combined');

  // The same case rotated by `rot`: states and error rotate, the covariances given in inertial axes (Q P Q').
  // d^2 and the RTN error are invariant; UVW names the same axes as RTN.
  const qrp = apply(rot, rp), qvp = apply(rot, vp), qrt = apply(rot, rt);
  const rotated = { pairs: [{ id: 'b', predicted: { position: qrp, velocity: qvp, covariance: sandwich(rot, P).flat(), covarianceAxes: 'INERTIAL' },
    truth: { position: qrt, velocity: qvp, covariance: lower(Tc), covarianceAxes: 'UVW' } }] };
  const r2 = (await call(t, 'pair_statistics', [json('pairs', rotated)])).pairs[0];
  r2.errorRtn.forEach((x, k) => close(x, e[k], 1e-6, `rotated error ${k}`));
  close(r2.d2Predicted, p.d2Predicted, 1e-9, 'rotated d2 predicted');
  close(r2.d2Combined, p.d2Combined, 1e-9, 'rotated d2 combined');

  // A weighted sum of terms equals the summed covariance: P = 0.5 * 2P + 3 * (0) + 1 * diag(0, 0, 0).
  const terms = { pairs: [{ id: 'c', predicted: { position: rp, velocity: vp, covarianceAxes: 'RTN', covarianceTerms: [{ weight: 0.5, covariance: lower(P).map((x) => 2 * x) },
    { weight: 3, covariance: [0, 0, 0, 0, 0, 0] }] }, truth: { position: rt, velocity: vp, covariance: lower(Tc), covarianceAxes: 'RTN' } }] };
  close((await call(t, 'pair_statistics', [json('pairs', terms)])).pairs[0].d2Combined, p.d2Combined, 1e-12, 'terms d2');
  await refused(t, 'pair_statistics', [json('pairs', { pairs: [{ predicted: { position: rp, velocity: vp }, truth: { position: rt, velocity: vp } }] })], /predicted state needs a covariance/);
});

test('pair_statistics with ephemeris samples: Lagrange through the nearest degree + 1 reproduces a quintic exactly; covariance linear; no extrapolation', async (t) => {
  // Each axis a quintic in tau = t / 60 s (designed coefficients); velocity its derivative per second.
  const coef = [[7e6, 1e3, 2, -0.5, 0.01, -1e-4], [1e5, -7.4e5, 3, 0.2, -0.02, 2e-4], [-3e5, 2e4, -1, 0.1, 0.003, -5e-5]];
  const pos = (tau) => coef.map((c) => c.reduce((a, ck, k) => a + ck * tau ** k, 0));
  const vel = (tau) => coef.map((c) => c.reduce((a, ck, k) => a + (k ? k * ck * tau ** (k - 1) : 0), 0) / 60);
  const t0 = Date.UTC(2026, 9, 10, 12);
  const iso = (sec) => new Date(t0 + sec * 1000).toISOString().replace('Z', '');
  // RTN covariance diag(100 + i, 400 + 2i, 25) at sample i (lower triangle 3x3).
  const samples = Array.from({ length: 10 }, (_, i) => ({ epoch: iso(60 * i), position: pos(i), velocity: vel(i), covariance: [100 + i, 0, 400 + 2 * i, 0, 0, 25] }));
  const at = 270 / 60;  // between samples 4 and 5
  const out = await call(t, 'pair_statistics', [json('pairs', { pairs: [
    { id: 'in', predicted: { samples, epoch: iso(270), covarianceAxes: 'RTN' }, truth: { position: pos(at), velocity: vel(at) } },
    { id: 'out', predicted: { samples, epoch: iso(600), covarianceAxes: 'RTN' }, truth: { position: pos(10), velocity: vel(10) } }] })]);
  const [p, q] = out.pairs;
  p.errorRtn.forEach((x, k) => assert.ok(Math.abs(x) < 1e-6, `error ${k}: ${x}`));
  p.velocityErrorRtn.forEach((x, k) => assert.ok(Math.abs(x) < 1e-9, `velocity error ${k}: ${x}`));
  assert.deepEqual(p.predictedInterpolated, { degree: 5, from: 2, samples: 6 });
  [104.5, 409, 25].forEach((x, k) => close(p.predictedRtn[[0, 2, 5][k]], x, 1e-12, `covariance ${k}`));
  assert.equal(q.missing, 'predicted epoch outside its samples');
});

test('fit_calibration: scalar maximum likelihood, coverage-matched and per-axis factors', async (t) => {
  const I = [1, 0, 1, 0, 0, 1];
  // |e|^2 = 3, 6, 9, 0, 12 under unit covariance: mean d^2 / 3 = 30 / 5 / 3 = 2.
  const es = [[1, 1, 1], [2, 1, 1], [3, 0, 0], [0, 0, 0], [2, 2, 2]];
  const samples = es.map((e, i) => ({ stratum: 's', object: i % 3, error: e, covariance: I }));
  const scalar = (await call(t, 'fit_calibration', [json('samples', { samples }), json('options', { method: 'scalar-mle', minimumSamples: 5, minimumObjects: 3 })])).strata[0];
  assert.equal(scalar.status, 'FITTED');
  close(scalar.factor, 2, 1e-12, 'k^2');
  close(scalar.before.meanD2Over3, 2, 1e-12, 'mean before');
  close(scalar.after.meanD2Over3, 1, 1e-12, 'mean after');
  // Coverage 0.95: d^2 sorted 0, 3, 6, 9, 12; type-7 quantile at h = 4 * 0.95 = 3.8: 9 + 0.8 * 3 = 11.4.
  const cov = (await call(t, 'fit_calibration', [json('samples', { samples }), json('options', { method: 'coverage', coverage: 0.95 })])).strata[0];
  close(cov.factor, 11.4 / 7.814727903251178, 1e-9, 'coverage factor');
  // Per axis: mean e_R^2 = (1+4+9+0+4)/5 = 3.6, e_T^2 = (1+1+0+0+4)/5 = 1.2, e_N^2 = (1+1+0+0+4)/5 = 1.2.
  const axes = (await call(t, 'fit_calibration', [json('samples', { samples }), json('options', { method: 'axes-mle' })])).strata[0];
  [3.6, 1.2, 1.2].forEach((x, k) => close(axes.axesFactors[k], x, 1e-12, `axis ${k}`));
  // After S P S with S = diag(sqrt(3.6), sqrt(1.2), sqrt(1.2)): d^2 = e_R^2/3.6 + e_T^2/1.2 + e_N^2/1.2.
  const after = es.map((e) => e[0] ** 2 / 3.6 + e[1] ** 2 / 1.2 + e[2] ** 2 / 1.2);
  close(axes.after.meanD2Over3, after.reduce((a, b) => a + b) / 5 / 3, 1e-12, 'axes after');
  // Strata are separate; too few samples are INSUFFICIENT.
  const two = (await call(t, 'fit_calibration', [json('samples', { samples: [...samples, { stratum: 'x', object: 1, error: [1, 0, 0], covariance: I }] }),
    json('options', { minimumSamples: 2 })])).strata;
  assert.deepEqual(two.map((s) => [s.stratum, s.status]), [['s', 'FITTED'], ['x', 'INSUFFICIENT']]);
});

test('calibrate_covariance: factors by regime and horizon on a native covariance; the element-set model by age; inertial axes', async (t) => {
  const regimes = [{ id: 'LEO-L', altitudeKm: [0, 500], eccentricity: [0, 0.25] }, { id: 'LEO-M', altitudeKm: [500, 800], eccentricity: [0, 0.25] }];
  // A circular state 600 km up (WGS-84): LEO-M by its osculating elements.
  const r0 = 6378137 + 600e3, v0 = Math.sqrt(3.986004418e14 / r0);
  const rp = apply(rot, [r0, 0, 0]), vp = apply(rot, [0, v0, 0]);
  const native = [1, 0, 4, 0, 0, 9, 0, 0, 0, 1e-4, 0, 0, 0, 0, 4e-4, 0, 0, 0, 0, 0, 9e-4];  // diag(1, 4, 9, 1e-4, 4e-4, 9e-4) RTN
  const model = { kind: 'e14-factors', version: 'test-1', regimes, strata: [
    { regime: 'LEO-M', horizonDays: [0.375, 0.75], axesFactors: [2, 0.5, 1], status: 'CALIBRATED' },
    { regime: '*', horizonDays: [0.75, 1.5], factor: 3, status: 'UNCALIBRATED' }] };
  const objects = { objects: [
    { id: 'a', state: { position: rp, velocity: vp }, horizonDays: 0.5, covariance: native, covarianceAxes: 'RTN' },
    { id: 'b', regime: 'LEO-L', horizonDays: 1.0, covariance: native, covarianceAxes: 'RTN', objectFactor: 2 },
    { id: 'c', regime: 'LEO-L', horizonDays: 0.5, covariance: native } ] };
  const out = await call(t, 'calibrate_covariance', [json('model', model), json('objects', objects)]);
  assert.equal(out.calibrationVersion, 'test-1');
  const [a, b, c] = out.objects;
  assert.equal(a.regime, 'LEO-M');
  assert.equal(a.status, 'CALIBRATED');
  const diag21 = (m) => [m[0], m[2], m[5], m[9], m[14], m[20]];
  [2, 2, 9, 2e-4, 2e-4, 9e-4].forEach((x, k) => close(diag21(a.covarianceRtn)[k], x, 1e-12, `a diag ${k}`));
  // Inertial: Q diag(2, 2, 9) Q' in the position block (the state's RTN axes are Q's columns).
  const expected = sandwich(rot, [[2, 0, 0], [0, 2, 0], [0, 0, 9]]);
  for (let i = 0; i < 3; ++i) for (let j = 0; j < 3; ++j) close(a.covarianceInertial[6 * i + j], expected[i][j], 1e-9, `a inertial ${i}${j}`);
  assert.equal(b.status, 'UNCALIBRATED');
  [6, 24, 54].forEach((x, k) => close(diag21(b.covarianceRtn)[k], x, 1e-12, `b diag ${k}`));  // factor 3 x object factor 2
  assert.equal(c.status, 'NO_MODEL');  // LEO-L has no 0.5-day cell

  // Element-set model: two age bins (centres 0.5 and 2 days) with covariances diag(1, 4, 9) and diag(3, 8, 11) km^2,
  // factors 2 and 4; at 1.25 days the midpoint: diag(2, 6, 10) km^2 x factor 3, in m^2.
  const setModel = { kind: 'e14-element-set-model', version: 'test-2', regimes, ageBinsDays: [[0, 1], [1, 3]], minimumBinSamples: 30,
    strata: [{ regimeIndex: 1, ageIndex: 0, n: 40, covariance: [1, 0, 4, 0, 0, 9, ...Array(15).fill(0)] },
      { regimeIndex: 1, ageIndex: 1, n: 40, covariance: [3, 0, 8, 0, 0, 11, ...Array(15).fill(0)] },
      { regimeIndex: 0, ageIndex: 0, n: 10, covariance: [1, 0, 1, 0, 0, 1, ...Array(15).fill(0)] }],
    factors: [{ regimeIndex: 1, ageIndex: 0, factor: 2 }, { regimeIndex: 1, ageIndex: 1, factor: 4 }],
    status: [{ regimeIndex: 1, ageIndex: 1, status: 'CALIBRATED' }] };
  const out2 = await call(t, 'calibrate_covariance', [json('model', setModel), json('objects', { objects: [
    { id: 'm', state: { position: rp, velocity: vp }, ageDays: 1.25 },
    { id: 'n', regime: 'LEO-L', ageDays: 0.5 }] })]);
  const m = out2.objects[0];
  assert.equal(m.status, 'CALIBRATED');
  close(m.factor, 3, 1e-12, 'interpolated factor');
  [2e6 * 3, 6e6 * 3, 10e6 * 3].forEach((x, k) => close(diag21(m.covarianceRtn)[k], x, 1e-12, `m diag ${k}`));
  assert.equal(out2.objects[1].status, 'NO_MODEL');  // LEO-L's only bin has fewer than minimumBinSamples
});

test('dcp_covariance: Hejduk\'s 5/9, 3/9, 1/9 at three days; sigma_eff from the lead covariance; start-relative sensitivity', async (t) => {
  const day = (d, h = 0) => new Date(Date.UTC(2026, 0, 10 + d, h)).toISOString().replace('Z', '');
  const segments = [1, 2, 3].map((k) => ({ from: day(k - 1), to: day(k), lead: k }));
  const C = [[0.04, 0.01, 0], [0.01, 0.09, 0.02], [0, 0.02, 0.16]];
  const g = [1, -2000, 3, 0.1, 0.2, -0.3];
  const out = await call(t, 'dcp_covariance', [json('request', { leadCovariance: C, start: day(0), segments,
    epochs: [{ epoch: day(3), sensitivity: g }, { epoch: day(1, 12), sensitivity: g }, { epoch: day(0), sensitivity: g }] })]);
  const [e3, e15, e0] = out.epochs;
  [5 / 9, 3 / 9, 1 / 9].forEach((w, k) => close(e3.weights[k], w, 1e-12, `weight ${k}`));
  const w = [5 / 9, 3 / 9, 1 / 9];
  const s2 = w.reduce((a, wi, i) => a + w.reduce((b, wj, j) => b + wi * C[i][j] * wj, 0), 0);
  close(e3.sigmaEff, Math.sqrt(s2), 1e-12, 'sigma_eff at 3 d');
  for (let i = 0; i < 6; ++i) for (let j = 0; j < 6; ++j) close(e3.covariance[6 * i + j], s2 * g[i] * g[j], 1e-12, `P ${i}${j}`);
  // At 1.5 days: day 1 weight (1.5^2 - 0.5^2) / 1.5^2 = 8/9, day 2 weight 0.5^2 / 1.5^2 = 1/9.
  close(e15.weights[0], 8 / 9, 1e-12, 'w1 at 1.5 d');
  close(e15.weights[1], 1 / 9, 1e-12, 'w2 at 1.5 d');
  assert.equal(e0.sigmaEff, 0);

  // Start-relative sensitivity: Phi(s0) = I, S(s0) = s0; Phi(t) = A, S(t) = s: g = B (s - A s0).
  const A = Array.from({ length: 36 }, (_, k) => (k % 7 === 0 ? 1 : 0) + (k === 3 ? 600 : 0));  // identity plus dx/dvx = 600 s
  const s0 = [0, 0, 0, 1e-3, 0, 0], s = [5, 2, 0, 2e-3, 0, 0], B = 0.02;
  const out2 = await call(t, 'dcp_covariance', [json('request', { leadCovariance: C, start: day(0), segments, ballisticCoefficient: B,
    startSample: { stm: Array.from({ length: 36 }, (_, k) => (k % 7 === 0 ? 1 : 0)), s: s0 },
    epochs: [{ epoch: day(2), stm: A, s, base: Array(21).fill(0) }] })]);
  const gx = [B * (5 - 600 * 1e-3), B * 2, 0, B * (2e-3 - 1e-3), 0, 0];
  out2.epochs[0].sensitivity.forEach((x, k) => close(x, gx[k], 1e-12, `g ${k}`));
  close(out2.epochs[0].total[0], out2.epochs[0].covariance[0], 1e-15, 'total = base + P');
  await refused(t, 'dcp_covariance', [json('request', { leadCovariance: [[1, -2], [-2, 1]], start: day(0), segments: segments.slice(0, 2),
    epochs: [{ epoch: day(2), sensitivity: g }] })], /not positive semidefinite/);
});

test('noise_responses: unit white-acceleration responses from an STM; a free particle gives q [[t^3/3, t^2/2], [t^2/2, t]] exactly', async (t) => {
  // Free particle: Phi(t, t0) = [[I, t I], [0, I]]; the states fix R, T, N to x, y, z. Each sub-step's closed form
  // propagated by Phi sums to the continuous integral exactly, so the expected responses are closed forms.
  const t0 = Date.UTC(2026, 0, 1);
  const iso = (sec) => new Date(t0 + sec * 1000).toISOString().replace('Z', '');
  const phi = (s) => Array.from({ length: 36 }, (_, k) => { const r = Math.floor(k / 6), c = k % 6; return r === c ? 1 : c === r + 3 ? s : 0; });
  const epochs = new Set();
  for (const T of [9000, 7000]) { const n = Math.ceil(T / 600 - 1e-9), h = T / n; for (let j = 1; j <= n; ++j) epochs.add(Math.round(j * h * 1000) / 1000); }
  const samples = [...epochs].sort((a, b) => a - b).map((s) => ({ epoch: iso(s), state: [7000e3, 0, 0, 0, 7500, 0], stm: phi(s) }));
  const out = await call(t, 'noise_responses', [json('request', { start: iso(0), discretizationSeconds: 600, samples, targets: [iso(9000), iso(7000)] })]);
  // 7000 s is 12 steps of 583.33 s: epochs on whole milliseconds put the STMs within 1e-6 of the exact step ends.
  for (const [i, T, tol] of [[0, 9000, 1e-12], [1, 7000, 1e-6]]) {
    const r = out.targets[i];
    assert.equal(r.steps, Math.ceil(T / 600 - 1e-9));
    for (const k of [0, 1, 2]) {
      const u = r.u[k];
      close(u[6 * k + k], T ** 3 / 3, tol, `pp axis ${k} at ${T}`);
      close(u[6 * k + 3 + k], T ** 2 / 2, tol, `pv axis ${k} at ${T}`);
      close(u[6 * (3 + k) + 3 + k], T, tol, `vv axis ${k} at ${T}`);
      assert.equal(u[6 * ((k + 1) % 3) + ((k + 1) % 3)], 0, 'other axes untouched');
    }
  }
  await refused(t, 'noise_responses', [json('request', { start: iso(0), discretizationSeconds: 600, samples: samples.filter((x) => x.epoch !== iso(600)), targets: [iso(9000)] })], /no sample at a step end/);
});

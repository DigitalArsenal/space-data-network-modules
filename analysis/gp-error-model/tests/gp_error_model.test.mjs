import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import { validateArtifactWithStandards } from 'space-data-module-sdk/compliance';

// Expected values are independent of the module:
// - Vallado SGP4-VER element sets with their t = 0 TEME states and pyerfa GCRF
//   states (analysis/epoch-state/tests/vallado-verification.json);
// - python-sgp4 2.27 (WGS-72) for 06251 propagated 360, 2520 and 2880 min,
//   as RTN differences from its t = 0 state;
// - moments, quantiles and clip counts of offsets designed here.
// Units: km, km/s. Frame: GCRF (reference mode) and TEME (differences).
const root = process.env.SPACE_DATA_STANDARDS_ROOT ?? path.dirname(createRequire(import.meta.url).resolve('spacedatastandards.org/package.json'));
const require = createRequire(path.join(root, 'package.json'));
const flatbuffers = require('flatbuffers');
const load = async (code) => import(pathToFileURL(path.join(root, `lib/js/${code}/main.js`)));
const [OMM, OEM] = await Promise.all(['OMM', 'OEM'].map(load));
const wasmPath = fileURLToPath(new URL('../dist/isomorphic/module.wasm', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(new URL('../plugin-manifest.json', import.meta.url)));
const wasm = fs.readFileSync(wasmPath);
const vallado = JSON.parse(fs.readFileSync(new URL('../../epoch-state/tests/vallado-verification.json', import.meta.url))).cases;
const caseOf = (satnum) => vallado.find((c) => c.satnum === satnum);

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => a.map((x) => x / Math.sqrt(dot(a, a)));
const axes = (r, v) => { const R = unit(r), N = unit(cross(r, v)); return [R, cross(N, R), N]; };

function omm(c, epoch = c.epochIso.replace('Z', '')) {
  const t = new OMM.OMMT();
  Object.assign(t, { EPOCH: epoch, NORAD_CAT_ID: c.satnum, MEAN_ELEMENT_THEORY: OMM.meanElementSource.SGP4, MEAN_MOTION: c.MEAN_MOTION,
    ECCENTRICITY: c.ECCENTRICITY, INCLINATION: c.INCLINATION, RA_OF_ASC_NODE: c.RA_OF_ASC_NODE, ARG_OF_PERICENTER: c.ARG_OF_PERICENTER,
    MEAN_ANOMALY: c.MEAN_ANOMALY, BSTAR: c.BSTAR });
  const b = new flatbuffers.Builder(512);
  OMM.OMM.finishSizePrefixedOMMBuffer(b, t.pack(b));
  return Buffer.from(b.asUint8Array());
}
// Reference states at the case's epoch: its GCRF state displaced by each
// RTN offset (taken in the state's own RTN axes).
function reference(c, offsets) {
  const [R, T, N] = axes(c.gcrfR, c.gcrfV);
  const lines = offsets.map((o) => {
    const l = new OEM.ephemerisDataLineT();
    l.EPOCH = c.epochIso;
    [l.X, l.Y, l.Z] = c.gcrfR.map((x, i) => x + o[0] * R[i] + o[1] * T[i] + o[2] * N[i]);
    [l.X_DOT, l.Y_DOT, l.Z_DOT] = c.gcrfV;
    return l;
  });
  const block = new OEM.ephemerisDataBlockT();
  Object.assign(block, { CENTER_NAME: 'EARTH', TIME_SYSTEM: OEM.timingStandard.UTC, EPHEMERIS_DATA_LINES: lines });
  block.OBJECT = Object.assign(new OEM.CATT(), { NORAD_CAT_ID: c.satnum });
  block.REFERENCE_FRAME = Object.assign(new OEM.RFMT(), { NAME: 'GCRF' });
  const b = new flatbuffers.Builder(4096);
  OEM.OEM.finishSizePrefixedOEMBuffer(b, Object.assign(new OEM.OEMT(), { EPHEMERIS_DATA_BLOCK: [block] }).pack(b));
  return { portId: 'reference', payload: Buffer.from(b.asUint8Array()), typeRef: { schemaName: 'OEM.fbs', fileIdentifier: '$OEM', rootTypeName: 'OEM', wireFormat: 'flatbuffer' } };
}
// Expected sample: SGP4's GCRF state minus the displaced state, in the displaced state's RTN axes.
function expectedError(c, o) {
  const [R, T, N] = axes(c.gcrfR, c.gcrfV);
  const truth = c.gcrfR.map((x, i) => x + o[0] * R[i] + o[1] * T[i] + o[2] * N[i]);
  const d = c.gcrfR.map((x, i) => x - truth[i]);
  return axes(truth, c.gcrfV).map((a) => dot(d, a));
}
const json = (portId, value) => ({ portId, payload: Buffer.from(JSON.stringify(value)), typeRef: { schemaName: 'application/json' } });

async function call(t, methodId, inputs) {
  const h = await createBrowserModuleHarness({ wasmSource: wasm, manifest, surface: 'direct' });
  t.after(() => h.destroy());
  const r = await h.invoke({ methodId, inputs });
  assert.equal(r.statusCode, 0, r.errorMessage);
  return JSON.parse(Buffer.from(r.outputs[0].payload).toString());
}
const elements = (...records) => ({ portId: 'elements', payload: Buffer.concat(records), typeRef: { schemaName: 'OMM.fbs', fileIdentifier: '$OMM', rootTypeName: 'OMM', wireFormat: 'flatbuffer' } });
const stratum = (model, regime, age) => model.strata.find((s) => s.regime === regime && s.ageIndex === age);

test('the artifact satisfies the SDK contract', async () => {
  const report = await validateArtifactWithStandards({ wasmPath, manifest, standardsRoot: root });
  assert.equal(report.ok, true, JSON.stringify(report.issues));
});

test('consecutive-set differences: the first later set in each age bin, in its RTN axes', async (t) => {
  // 06251 at its epoch, and copies of the same elements 360 min and 2 days
  // later: near-Earth SGP4 does not depend on the epoch, so each later copy's
  // state equals 06251's t = 0 state and each difference is SGP4 over the age.
  const c = caseOf(6251);
  const iso = (minutes) => { const ms = Date.parse(c.epochIso.slice(0, 23) + 'Z') + minutes * 60000; return new Date(ms).toISOString().slice(0, 23) + c.epochIso.slice(23, 26); };
  const acc = await call(t, 'accumulate', [elements(omm(c), omm(c, iso(360)), omm(c, iso(2880)))]);
  const model = await call(t, 'finalize', [json('accumulator', acc)]);
  assert.equal(model.mode, 'gp-differences');
  assert.equal(model.counts.samples, 3);
  const expected = [  // python-sgp4 2.27: SGP4(t) - SGP4(0) in RTN of SGP4(0)
    [0, [-1521.755083000, -4296.589915665, 86.325068906, 4.846700762, -1.727943738, 0.075706746]],   // 360 min, 0-0.5 d
    [2, [-6118.231856963, 6722.921661893, 44.619096667, -7.581476308, -6.904544103, -0.846086304]],  // 2520 min, 1-2 d
    [3, [-2018.493692852, 4768.151442481, 578.442844559, -5.354967682, -2.226859069, -0.709424983]], // 2880 min, 2-3 d
  ];
  for (const [age, x] of expected) {
    const s = stratum(model, 'LEO below 450 km', age);
    assert.equal(s.n, 1, `age bin ${age}`);
    s.mean.forEach((m, i) => assert.ok(Math.abs(m - x[i]) < (i < 3 ? 1e-6 : 1e-9), `age bin ${age} component ${i}: ${m} vs ${x[i]}`));
  }
});

test('reference states: moments of designed offsets, TEME to GCRF, prior batches', async (t) => {
  const c = caseOf(6251);
  const offsets = [[0.1, 1.0, -0.2], [-0.1, -1.0, 0.2], [0.3, 2.0, 0], [-0.3, -2.0, 0]];
  const batch1 = await call(t, 'accumulate', [elements(omm(c)), reference(c, offsets.slice(0, 2)), json('options', { referenceStepSeconds: 0 })]);
  const acc = await call(t, 'accumulate', [elements(omm(c)), reference(c, offsets.slice(2)), json('options', { referenceStepSeconds: 0 }), json('prior', batch1)]);
  const model = await call(t, 'finalize', [json('accumulator', acc)]);
  assert.equal(model.mode, 'reference');
  const s = stratum(model, 'LEO below 450 km', 0);
  assert.equal(s.n, 4);
  const x = offsets.map((o) => expectedError(c, o));
  const mean = [0, 1, 2].map((k) => x.reduce((a, e) => a + e[k], 0) / 4);
  const cov = (a, b) => x.reduce((acc2, e) => acc2 + (e[a] - mean[a]) * (e[b] - mean[b]), 0) / 3;
  [0, 1, 2].forEach((k) => assert.ok(Math.abs(s.mean[k] - mean[k]) < 1e-6, `mean ${k}`));
  // Lower triangle: RR, TR, TT, NR, NT, NN.
  [[0, 0, 0], [1, 1, 0], [2, 1, 1], [3, 2, 0], [4, 2, 1], [5, 2, 2]].forEach(([i, a, b]) =>
    assert.ok(Math.abs(s.covariance[i] - cov(a, b)) < 1e-6, `cov ${a}${b}: ${s.covariance[i]} vs ${cov(a, b)}`));
  // Velocity: the reference carries SGP4's own GCRF velocity; the module's
  // TEME -> GCRF omits the frame rate (below 1e-7 km/s).
  [3, 4, 5].forEach((k) => assert.ok(Math.abs(s.mean[k]) < 1e-7, `velocity ${k} ${s.mean[k]}`));
});

test('quantiles, robust sigma and clipping on a normal design', async (t) => {
  // 200 along-track offsets at the normal quantiles of (k + 0.5) / 200, sigma
  // 2 km, radial 0.1 of that: the robust sigma is 2 km within the histogram's
  // 12 % bins, and clipping at 1 sigma keeps the offsets inside +-2 km.
  const c = caseOf(28057);
  const z = Array.from({ length: 200 }, (_, k) => normalQuantile((k + 0.5) / 200));
  const offsets = z.map((q) => [0.2 * q, 2 * q, 0]);
  const errors = offsets.map((o) => expectedError(c, o));
  const inside = errors.filter((e) => Math.abs(e[1]) <= 2 && Math.abs(e[0]) <= 1e3 && Math.abs(e[2]) <= 1e3).length;
  const clip = { k: 1, strata: [{ regime: 2, age: 0, centre: [0, 0, 0], scale: [1e3, 2, 1e3] }] };
  const acc = await call(t, 'accumulate', [elements(omm(c)), reference(c, offsets), json('options', { referenceStepSeconds: 0, clip })]);
  const model = await call(t, 'finalize', [json('accumulator', acc)]);
  const s = stratum(model, 'LEO 600-800 km', 0);
  assert.equal(s.n, 200);
  assert.ok(Math.abs(s.robustSigma[1] / 2 - 1) < 0.15, `robust sigma T ${s.robustSigma[1]}`);
  assert.ok(Math.abs(s.robustSigma[0] / 0.2 - 1) < 0.15, `robust sigma R ${s.robustSigma[0]}`);
  assert.ok(Math.abs(s.median[1]) < 0.1, `median T ${s.median[1]}`);
  assert.equal(s.clipped.n, inside);
  assert.ok(Math.abs(s.clipped.fractionRemoved - (1 - inside / 200)) < 1e-12);
});

test('coverage: zero-mean Mahalanobis d^2 against the stratum covariance, every sample counted', async (t) => {
  // Model: 06251's stratum (LEO below 450 km, age 0-0.5 d) with position
  // covariance diag(0.04, 1, 0.09) km^2. Along-track offsets of 1, sqrt 5,
  // sqrt 10 and sqrt 20 km give d^2 of about 1, 5, 10 and 20 (exactly as
  // computed here from the expected errors). Chi-square (3 dof) table
  // quantiles: 3.5267 (68.27 %), 8.0249 (95.45 %), 14.1564 (99.73 %).
  const c = caseOf(6251);
  const model = { kind: 'gp-error-model', mode: 'gp-differences', strata: [{ regimeIndex: 0, ageIndex: 0,
    covariance: [0.04, 0, 1, 0, 0, 0.09, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1] }] };
  const offsets = [1, 5, 10, 20].map((d2) => [0, Math.sqrt(d2), 0]);
  const d2 = offsets.map((o) => { const e = expectedError(c, o); return e[0] ** 2 / 0.04 + e[1] ** 2 + e[2] ** 2 / 0.09; });
  const acc = await call(t, 'accumulate', [elements(omm(c)), reference(c, offsets), json('options', { referenceStepSeconds: 0 }), json('model', model)]);
  const out = await call(t, 'finalize', [json('accumulator', acc), json('options', { gate: { minimumSamples: 4, minimumObjects: 1 } })]);
  const g = stratum(out, 'LEO below 450 km', 0).coverage;
  assert.equal(g.n, 4);
  assert.deepEqual(g.inside, [0.25, 0.5, 0.75]);
  assert.ok(Math.abs(g.meanD2 - d2.reduce((a, b) => a + b) / 4) < 1e-6, `mean d2 ${g.meanD2}`);
  assert.equal(g.status, 'FAILED');
  // F(d^2) for chi-square 3 dof: 0.199, 0.828, 0.981, 0.9998 -> bins 3, 16, 19, 19.
  const expectedPit = Array(20).fill(0); expectedPit[3] = 0.25; expectedPit[16] = 0.25; expectedPit[19] = 0.5;
  assert.deepEqual(g.pit, expectedPit);
  const insufficient = await call(t, 'finalize', [json('accumulator', acc)]);
  assert.equal(stratum(insufficient, 'LEO below 450 km', 0).coverage.status, 'INSUFFICIENT');
});

test('scale_model: position covariance scaled to the reference second moment about zero', async (t) => {
  // Model diag(1, 1, 1) km^2; reference clipped covariance diag(4, 9, 16) with
  // mean (1, 0, 0) km: second moments 5, 9, 16, factors sqrt 5, 3, 4.
  const unitCov = [1, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1];
  const model = { kind: 'gp-error-model', mode: 'gp-differences', strata: [{ regimeIndex: 2, ageIndex: 1, clipped: { covariance: unitCov } }] };
  const truth = { kind: 'gp-error-model', mode: 'reference', strata: [{ regimeIndex: 2, ageIndex: 1,
    clipped: { n: 100, mean: [1, 0, 0, 0, 0, 0], covariance: [4, 0, 9, 0, 0, 16, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1] } }] };
  const out = await call(t, 'scale_model', [json('model', model), json('truth', truth)]);
  const s = out.strata[0];
  [Math.sqrt(5), 3, 4].forEach((f, k) => assert.ok(Math.abs(s.scale.factors[k] - f) < 1e-12));
  [[0, 5], [2, 9], [5, 16], [9, 1], [14, 1], [20, 1]].forEach(([i, v]) => assert.ok(Math.abs(s.clipped.covariance[i] - v) < 1e-12, `entry ${i}`));
  const thin = await call(t, 'scale_model', [json('model', model), json('truth', truth), json('options', { minimumSamples: 101 })]);
  assert.equal(thin.strata[0].scale, null);
});

// Acklam's rational approximation to the normal quantile (|error| < 1.2e-9).
function normalQuantile(p) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const tail = (q) => (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  if (p < 0.02425) return tail(Math.sqrt(-2 * Math.log(p)));
  if (p > 1 - 0.02425) return -tail(Math.sqrt(-2 * Math.log(1 - p)));
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

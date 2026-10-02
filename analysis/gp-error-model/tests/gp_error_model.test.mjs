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
// RTN offset (taken in the state's own RTN axes); `more` adds other objects' blocks.
function reference(c, offsets, more = []) {
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
  const blocks = [block, ...more.map((x) => x.block)];
  OEM.OEM.finishSizePrefixedOEMBuffer(b, Object.assign(new OEM.OEMT(), { EPHEMERIS_DATA_BLOCK: blocks }).pack(b));
  return { block, portId: 'reference', payload: Buffer.from(b.asUint8Array()), typeRef: { schemaName: 'OEM.fbs', fileIdentifier: '$OEM', rootTypeName: 'OEM', wireFormat: 'flatbuffer' } };
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

test('screening_evaluation: alert rules on designed misses with known errors', async (t) => {
  // Two objects (06251 and a copy numbered 99999), one reference sample each,
  // in one stratum with isotropic position covariance 1e-4 km^2 (10 m). The
  // copy's reference state is displaced 50 m radially, so its error is exactly
  // (-0.05, 0, 0) km and the relative error is +-50 m radial in both encounter
  // planes. Per object the plane covariance is s^2 I (s = 10 m), relative
  // 2 s^2 I. For predicted relative position p (|p| = d), hard-body radius
  // R = 20 m:
  //   bounded set   alert iff d - k sqrt2 s <= R, k^2 = -2 ln(1 - 0.9973);
  //   possibility   alert iff F_chi2_3(((d - R) / 2s)^2) < 0.9973, that is
  //                 (d - R) / 2s < sqrt(14.1564), and always when d <= R;
  //   probabilistic Pc = integral of N(p, 2 s^2 I) over the disk (computed
  //                 here on a 400 x 720 polar grid), alert iff Pc >= 1e-4.
  const c = caseOf(6251), copy = { ...c, satnum: 99999 };
  const iso = [1e-4, 0, 1e-4, 0, 0, 1e-4, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1];
  const model = { kind: 'gp-error-model', mode: 'reference', strata: [{ regimeIndex: 0, ageIndex: 0, covariance: iso }] };
  const misses = [0, 10, 50, 60, 90, 100, 500];
  const options = { referenceStepSeconds: 0, hardBodyRadiusM: 20, missDistancesM: misses, directions: 4, pairsPerStratum: 10 };
  const both = reference(c, [[0, 0, 0]], [reference(copy, [[0.05, 0, 0]])]);
  const out = await call(t, 'screening_evaluation', [elements(omm(c), omm(copy)), both,
    json('model', model), json('options', options)]);
  assert.equal(out.kind, 'screening-evaluation');
  assert.equal(out.strata.length, 1);
  assert.equal(out.strata[0].objects, 2);
  assert.equal(out.strata[0].pairs, 10);

  const e = expectedError(copy, [0.05, 0, 0]);
  assert.ok(Math.abs(e[0] + 0.05) < 1e-12 && Math.abs(e[1]) < 1e-12 && Math.abs(e[2]) < 1e-12);
  const s = 0.01, R = 0.02, k = Math.sqrt(-2 * Math.log(1 - 0.9973)), sr = Math.SQRT2 * s;
  const pc = (px, py) => {
    let sum = 0;
    for (let a = 0; a < 400; ++a) {
      const rho = (a + 0.5) * R / 400;
      for (let b = 0; b < 720; ++b) {
        const th = (b + 0.5) * 2 * Math.PI / 720, dx = rho * Math.cos(th) - px, dy = rho * Math.sin(th) - py;
        sum += rho * (R / 400) * (2 * Math.PI / 720) * Math.exp(-(dx * dx + dy * dy) / (2 * sr * sr));
      }
    }
    return sum / (2 * Math.PI * sr * sr);
  };
  for (const geometry of ['head-on', 'crossing-90']) {
    const rows = out.strata[0].geometries.find((g) => g.geometry === geometry).rows;
    misses.forEach((m, i) => {
      // Either pair order gives the same multiset of |p| over the 4 directions.
      const cases = [0, 1, 2, 3].map((d) => {
        const phi = (d + 0.5) * Math.PI / 2;
        const px = m * 1e-3 * Math.cos(phi) + 0.05, py = m * 1e-3 * Math.sin(phi), dist = Math.hypot(px, py);
        const p = pc(px, py);
        return { p, bound: dist - k * sr <= R, possible: dist <= R || (dist - R) / (2 * s) < Math.sqrt(14.156413) };
      });
      const rate = (f) => cases.filter(f).length / 4;
      const row = rows[i];
      assert.equal(row.missM, m);
      assert.equal(row.collision, m <= 20);
      assert.equal(row.cases, 40);
      assert.equal(row.boundedSetAlertRate, rate((x) => x.bound), `${geometry} ${m} m bounded`);
      assert.equal(row.possibilityAlertRate, rate((x) => x.possible), `${geometry} ${m} m possibility`);
      assert.equal(row.pcAlertRate, rate((x) => x.p >= 1e-4), `${geometry} ${m} m Pc`);
      const meanPc = cases.reduce((a, x) => a + x.p, 0) / 4;
      assert.ok(Math.abs(row.meanPc - meanPc) <= 1e-4 * Math.max(meanPc, 1e-12) + 1e-15, `${geometry} ${m} m mean Pc ${row.meanPc} vs ${meanPc}`);
    });
  }
  // The designed outcome: at 100 m only possibility still alerts, on the two
  // directions the relative error brings to 74 m.
  const at100 = out.summary['head-on'][5];
  assert.deepEqual([at100.pcAlertRate, at100.boundedSetAlertRate, at100.possibilityAlertRate], [0, 0, 0.5]);
});

test('hpop_arcs: reference epochs at the requested ages, truth copied, P0 rotated from RTN to GCRF', async (t) => {
  // 06251 at its epoch; reference lines 60 s, 0.25 d + 300 s, 0.75 d + 2000 s
  // (beyond the 900 s tolerance) and 1.5 d - 100 s after it. P0 diagonal in
  // RTN; expected G = J P J' with J = diag(A', A'), A the RTN rows of the
  // pyerfa GCRF epoch state (independent of the module), in SI.
  const c = caseOf(6251);
  const e0 = Date.parse(c.epochIso);
  const at = (s) => new Date(e0 + s * 1000).toISOString();
  const lines = [[60, 1], [0.25 * 86400 + 300, 2], [0.75 * 86400 + 2000, 3], [1.5 * 86400 - 100, 4]].map(([s, k]) => {
    const l = new OEM.ephemerisDataLineT();
    l.EPOCH = at(s);
    [l.X, l.Y, l.Z, l.X_DOT, l.Y_DOT, l.Z_DOT] = [7000 + k, k, -k, 7.5 + k / 10, k / 10, -k / 10];
    return l;
  });
  const block = new OEM.ephemerisDataBlockT();
  Object.assign(block, { CENTER_NAME: 'EARTH', TIME_SYSTEM: OEM.timingStandard.UTC, EPHEMERIS_DATA_LINES: lines });
  block.OBJECT = Object.assign(new OEM.CATT(), { NORAD_CAT_ID: c.satnum });
  block.REFERENCE_FRAME = Object.assign(new OEM.RFMT(), { NAME: 'GCRF' });
  const b = new flatbuffers.Builder(4096);
  OEM.OEM.finishSizePrefixedOEMBuffer(b, Object.assign(new OEM.OEMT(), { EPHEMERIS_DATA_BLOCK: [block] }).pack(b));
  const ref = { ...reference(c, []), payload: Buffer.from(b.asUint8Array()) };
  const diag = [1e-4, 4e-4, 9e-4, 1e-8, 4e-8, 9e-8];
  const p0 = []; for (let a = 0; a < 6; ++a) for (let k = 0; k <= a; ++k) p0.push(a === k ? diag[a] : 0);
  const model = { kind: 'hpop-covariance-model', version: 1, regimes: [{ regimeIndex: 0, regime: 'LEO below 450 km', p0,
    processNoise: { spectralDensityM2S3: [1e-12, 2e-12, 3e-12], discretizationSeconds: 600 } }] };
  const plan = await call(t, 'hpop_arcs', [elements(omm(c)), ref, json('model', model),
    json('options', { targetAgesDays: [0, 0.25, 0.75, 1.5] })]);
  assert.equal(plan.arcs.length, 1);
  const arc = plan.arcs[0];
  assert.deepEqual(arc.targets.map((x) => x.nominalDays), [0, 0.25, 1.5]);
  assert.deepEqual(arc.targets.map((x) => x.epoch), [lines[0].EPOCH, lines[1].EPOCH, lines[3].EPOCH]);
  // Date keeps milliseconds: the line epochs are up to 1 ms off the set's microsecond epoch.
  assert.ok(Math.abs(arc.targets[1].ageDays - (0.25 + 300 / 86400)) < 2e-8);
  assert.deepEqual(arc.targets[2].truth, [7004, 4, -4, 7.9, 0.4, -0.4]);
  assert.deepEqual(arc.processNoise.spectralDensityM2S3, [1e-12, 2e-12, 3e-12]);
  const A = axes(c.gcrfR, c.gcrfV);
  for (let i = 0; i < 6; ++i) for (let j = 0; j < 6; ++j) {
    const block = Math.floor(i / 3) === Math.floor(j / 3);
    let g = 0;
    if (block) for (let k = 0; k < 3; ++k) g += A[k][i % 3] * diag[3 * Math.floor(i / 3) + k] * A[k][j % 3];
    assert.ok(Math.abs(arc.covariance[6 * i + j] - g * 1e6) <= 1e-6 * diag[0] * 1e6, `G[${i}][${j}] ${arc.covariance[6 * i + j]} vs ${g * 1e6}`);
    assert.equal(arc.covariance[6 * i + j], arc.covariance[6 * j + i]);
  }
});

test('hpop_coverage: P0 from age-0 errors, maximum-likelihood process noise, held-out coverage', async (t) => {
  // Truth r = (7000, 0, 0) km, v = (0, 7.5, 0) km/s: R, T, N are x, y, z.
  // Predicted state = truth + designed error (SI).
  const truth = [7000, 0, 0, 0, 7.5, 0];
  const arcOf = (arc, norad, nominal, epoch) => ({ arc, norad, epoch: '2026-08-01T00:00:00Z', regimeIndex: 0, regime: 'LEO below 450 km',
    targets: [{ nominalDays: nominal, ageDays: nominal + 0.2, epoch, truth }] });
  const state = (e) => truth.map((x, k) => x * 1e3 + (k < 3 ? e[k] : 0));
  const run = (mode, plan, predictions, model, extra = {}) => call(t, 'hpop_coverage', [json('plan', { kind: 'hpop-arc-plan', arcs: plan }),
    json('predictions', { arcs: predictions }), ...(model ? [json('model', model)] : []),
    json('options', { mode, window: ['2026-08-02T00:00:00Z', '2026-08-03T00:00:00Z'], ...extra })]);

  // epoch: second moment about zero of the kept errors; the 100 km outlier
  // lies beyond 5 robust sigma and is left out; the target outside the window is not a sample.
  const errors = [[100, 200, 0], [-100, 200, 50], [100, -200, -50], [-100, -200, 0], [100000, 0, 0]];
  const plan0 = errors.map((_, i) => arcOf(i, 1 + (i % 3), 0, '2026-08-02T06:00:00Z')).concat([arcOf(9, 9, 0, '2026-08-04T00:00:00Z')]);
  const pred0 = errors.map((e, i) => ({ arc: i, samples: [{ state: state(e) }] })).concat([{ arc: 9, samples: [{ state: state([0, 0, 0]) }] }]);
  const epoch = await run('epoch', plan0, pred0);
  const r = epoch.regimes[0];
  assert.equal(r.n, 5);
  assert.equal(r.kept, 4);
  assert.equal(epoch.counts.targetsOutsideWindow, 1);
  // km^2, mean over the four kept: RR = 0.01, TR = 0, TT = 0.04, NR = -0.0025,
  // NT = 0.005, NN = 0.00125.
  [[0, 0.01], [1, 0], [2, 0.04], [3, -0.0025], [4, 0.005], [5, 0.00125]].forEach(([k, v]) => assert.ok(Math.abs(r.p0[k] - v) < 1e-12, `p0[${k}] ${r.p0[k]}`));

  // fit: A = I m^2, U_k = 1e12 m^2 on axis k alone. Mean squared errors 4, 0.25
  // and 10 m^2 give the closed-form maximum likelihood q = (s - 1) / 1e12
  // floored at zero: 3e-12, 0 and 9e-12 m^2/s^3.
  const a = [1, 0, 0, 1, 0, 1], u = [[1e12, 0, 0, 0, 0, 0], [0, 0, 0, 1e12, 0, 0], [0, 0, 0, 0, 0, 1e12]];
  const fitErrors = [[2, 0.5, Math.sqrt(10)], [-2, 0.5, -Math.sqrt(10)], [2, -0.5, -Math.sqrt(10)], [-2, -0.5, Math.sqrt(10)]];
  const plan1 = fitErrors.map((_, i) => arcOf(i, 1 + (i % 2), 1, '2026-08-02T12:00:00Z'));
  const pred1 = fitErrors.map((e, i) => ({ arc: i, samples: [{ state: state(e), a, u }] }));
  const fitted = await run('fit', plan1, pred1, epoch, { discretizationSeconds: 600 });
  const q = fitted.regimes[0].processNoise.spectralDensityM2S3;
  assert.ok(Math.abs(q[0] / 3e-12 - 1) < 1e-6 && q[1] === 0 && Math.abs(q[2] / 9e-12 - 1) < 1e-6, `q ${q}`);

  // Selection on the fit window: with A = I, errors along x with d^2 = 1 (14),
  // 5 (5) and 10 (1) give containment 0.70 / 0.95 / 1.00, so P0 alone passes
  // a 20-sample gate. Maximum likelihood (mean e^2 = 2.45, q_R = 1.45e-12)
  // shrinks them to 0.41 / 2.04 / 4.08, 0.95 inside 1 sigma: it fails, and
  // P0 alone is kept.
  const d2 = [...Array(14).fill(1), ...Array(5).fill(5), 10];
  const plan3 = d2.map((_, i) => arcOf(i, 1 + (i % 3), 1, '2026-08-02T12:00:00Z'));
  const pred3 = d2.map((v, i) => ({ arc: i, samples: [{ state: state([Math.sqrt(v), 0, 0]), a, u }] }));
  const chosen = await run('fit', plan3, pred3, epoch, { gate: { minimumSamples: 20, minimumObjects: 3 } });
  const noise = chosen.regimes[0].processNoise;
  assert.equal(noise.fit.selected, 'P0 alone');
  assert.deepEqual(noise.fit.fitStrataCalibrated, { maximumLikelihood: 0, p0Alone: 1 });
  assert.deepEqual(noise.spectralDensityM2S3, [0, 0, 0]);
  assert.ok(Math.abs(noise.fit.maximumLikelihoodM2S3[0] / 1.45e-12 - 1) < 1e-6);

  // test: P = A + q U = diag(4, 1, 10) m^2. d^2 = 1, 6.25, 16 against the
  // chi-square 3 quantiles 3.527, 8.025, 14.156; P0 alone gives 4, 62.5, 16.
  const testErrors = [[2, 0, 0], [0, 0, 2.5 * Math.sqrt(10)], [0, 4, 0]];
  const plan2 = testErrors.map((_, i) => arcOf(i, 1 + i, 1, '2026-08-02T18:00:00Z'));
  const pred2 = testErrors.map((e, i) => ({ arc: i, samples: [{ state: state(e), a, u }] }));
  const report = await run('test', plan2, pred2, fitted);
  const s = report.strata[0];
  assert.deepEqual([s.regimeIndex, s.ageIndex], [0, 2]);
  assert.deepEqual(s.coverage.inside.map((x) => Math.round(x * 3)), [1, 2, 2]);
  assert.deepEqual(s.coverageP0Only.inside.map((x) => Math.round(x * 3)), [0, 1, 1]);
  assert.equal(s.coverage.status, 'INSUFFICIENT');
});

#!/usr/bin/env node
// Registration (2026-11-03, modules-sdn-ap-third-body-short-period-eccentric-20261103; acceptance as ruled by the
// coordinator after the measurement): AP 0.4.11 takes the Sun's and the Moon's short-period terms of degree 2 to 10 by
// quadrature (SPEC 5.4) and their degree 4 to 10 averaged rates at every eccentricity (SPEC 16.8, the bound removed).
// Test builds of this package: PROBE adds two exports to abi.inc (the theory unchanged); OFF sets
// kThirdBodyTailDegree to 3 (degree 4 up off). PROBE reads TailSamples as f[element][node] (xp_theory.inc since 0.6.5,
// 24d7d75f; 0.6.4 held f[node][element]): read the old way, it ran past the array and every probe value was NaN.
// Acceptance:
// 1. term by term (PROBE): at e 0.05, 0.3 and 0.72 in SPEC 16.8's three orientations, n 2.0059 rev/day, the quadrature
//    terms of degree 2-3 and of degree 2-10 within 0.15 m RMS per element of a numerical integration over one orbit
//    (two-body plus the bodies' tidal terms of the same degrees, bodies fixed, RK4, 128,000 steps); SPEC 5's
//    closed-form degree 2-3 averaged rates within 0.1 m per day of the quadrature average (the averaged rates are
//    unchanged); the replaced closed form's mean-longitude error at G1 e 0.72 printed and within 1 m of 298.2 m RMS;
// 2. degree 4 up off (OFF; FFM EGM96 70x70, Sun and Moon from DE440; 72 h fits): day-1 along-track RMS of the half-day
//    fixture at most 95 m and of the Molniya fixture at most 85 m;
// 3. the release on the four HEO fixtures, flown hourly for 7 days after the fit: day-7 whole-day along-track and
//    radial RMS within 0.5 m of half-day 31.45/16.88, Molniya 238.50/174.28 and 12 h at 55 deg 66.61/5.68 m, GTO no
//    worse than 961/935 m (to the meter); the single day-7 sample printed and within 0.5 m of 30.22, 332.16, 64.94 and
//    275.78 m (re-recorded 2026-11-10 on 0.6.8 and FFM 2.2.1: 0.6.3's grid moved them, the history at the assertions;
//    re-recorded at 0.4.15, SPEC 16.11: 84.22/75.28, 149.82/175.90, 158.02/105.47 and the samples 202.04, 338.22, 303.15
//    before; GTO 929.45 at 0.4.14, 2449.15 m at 0.4.11);
// 4. default-FORCES XP digest bit-exact.
import assert from 'node:assert/strict';
import {requireTruth} from './lib/ffm-truth.mjs';
requireTruth('a9133120775291c4dfbf9151d0617850be560934943a178419fdd8e3fed765e4'); // the model truth: FFM 2.2.1 (modules 9cb02c8e)
import fs from 'node:fs';
import path from 'node:path';
import {Worker, isMainThread, parentPort, workerData} from 'node:worker_threads';
import {execFileSync} from 'node:child_process';
import {reproduceConformance} from './lib/conformance-step.mjs';
import {fileURLToPath} from 'node:url';

const GEOMETRIES = {G1: [63.4, 300, 270], G2: [63.4, 60, 90], G3: [55, 180, 0]};
const NAMES = ['af', 'ag', 'chi', 'psi', 'lambda', 'n as a'];

if (!isMainThread) {
  const {kind, c} = workerData;
  if (kind === 'fixture') {
    const {runModelTruth} = await import('./lib/heo-model-truth.mjs');
    const r = await runModelTruth(c);
    parentPort.postMessage({days: r.days, wholeDay: r.wholeDay});
  } else {
    // PROBE build (SDNAP_WASM): per case, RMS per element of numerical minus quadrature, and of numerical minus
    // closed form, over one orbit; the averaged-rate differences in meters per day
    const {openModule} = await import('./lib/module.mjs');
    const m = await openModule(), x = m.x, K = 64, py = x.sdnap_alloc(48), po = x.sdnap_alloc(8 * 18 * (K + 1));
    const d50 = Date.parse('2026-10-29T00:00:00Z') / 86400000 + 2440587.5 - 2433281.5, deg = Math.PI / 180, out = [];
    for (const [g, [i, node, argp]] of Object.entries(GEOMETRIES))
      for (const e of [0.05, 0.3, 0.72]) {
        const n = 2.0059 * 2 * Math.PI / 1440, a = 6378.1363 * Math.pow(0.0743668599541789 / n, 2 / 3);
        const scale = [1, 1, 1, 1, 1, -(2 / 3) / n].map((s) => s * a * 1000);
        new Float64Array(m.harness.memory.buffer, py, 6).set([e * Math.cos((argp + node) * deg), e * Math.sin((argp + node) * deg),
          Math.tan(i * deg / 2) * Math.sin(node * deg), Math.tan(i * deg / 2) * Math.cos(node * deg), 0.3 + (argp + node) * deg, n]);
        const row = {g, e};
        for (const hi of [3, 10]) {
          assert.equal(x.sdnap_test_sp_verify(py, d50, K, hi, po), 0);
          const o = Array.from(new Float64Array(m.harness.memory.buffer, po, 18 * (K + 1)));
          const rms = (col) => NAMES.map((_, j) => Math.sqrt(Array.from({length: K + 1}, (_, k) => ((o[18 * k + j] - o[18 * k + col + j]) * scale[j]) ** 2).reduce((s, v) => s + v, 0) / (K + 1)));
          row[`quadrature${hi}`] = rms(6);
          if (hi === 3) row.closedForm = rms(12);
        }
        assert.equal(x.sdnap_test_rate_compare(py, d50, po), 0);
        const r = Array.from(new Float64Array(m.harness.memory.buffer, po, 12));
        row.averagedRatesMetersPerDay = NAMES.map((_, j) => Math.abs((r[j] - r[6 + j]) * scale[j]) * 1440);
        out.push(row);
      }
    m.destroy();
    parentPort.postMessage(out);
  }
} else {
  const {wasmPath} = await import('./lib/module.mjs');
  const {scratchRoot} = await import('./lib/scratch.mjs');
  const scratch = path.join(scratchRoot, 'third-body-short-period');
  const modules = fileURLToPath(new URL('../../../', import.meta.url)), packageRoot = path.join(modules, 'propagator/sdn-ap');
  fs.mkdirSync(scratch, {recursive: true});
  const testBuild = (name, edits) => {
    const tree = path.join(scratch, name), copy = path.join(tree, 'propagator/sdn-ap');
    fs.rmSync(tree, {recursive: true, force: true});
    fs.cpSync(packageRoot, copy, {recursive: true, filter: (p) => !/\/(node_modules|test|dist)(\/|$)/.test(p.slice(packageRoot.length))});
    for (const [file, a, b] of edits) {
      const source = path.join(copy, 'src', file);
      const text = fs.readFileSync(source, 'utf8');
      assert.equal(text.split(a).length, 2, `${name}: one ${a.slice(0, 60)}`);
      fs.writeFileSync(source, text.replace(a, b));
    }
    fs.symlinkSync(path.join(packageRoot, 'node_modules'), path.join(copy, 'node_modules'));
    fs.symlinkSync(path.join(modules, 'foundation'), path.join(tree, 'foundation'));
    try {
      execFileSync(process.execPath, ['build.mjs'], {cwd: copy, stdio: 'ignore', env: {...process.env, SPACE_DATA_NETWORK_MODULES_ROOT: modules, SDNAP_DIST_DIR: path.join(tree, 'dist')}});
    } finally {
      fs.unlinkSync(path.join(copy, 'node_modules'));
      fs.unlinkSync(path.join(tree, 'foundation'));
    }
    return path.join(tree, 'dist/isomorphic/module.wasm');
  };
  const PROBES = String.raw`SDNAP_EXPORT("sdnap_test_sp_verify")
int32_t sdnap_test_sp_verify(const double* yin, double d50, int32_t K, int32_t hi, double* out) {
  using namespace sdnap::xpt;
  double ym[6];
  for (int j = 0; j < 6; ++j) ym[j] = yin[j];
  const Bodies b = bodies_at(d50);
  TailSamples s;
  tail_samples(ym, frame_of(ym), b, 2, hi, s);
  double avg[6] = {0, 0, 0, 0, 0, 0};
  for (int j = 0; j < kThirdBodyTailNodes; ++j)
    for (int m = 0; m < 6; ++m) avg[m] += s.w[j] * s.f[m][j] / kThirdBodyTailNodes;
  const auto closed = [&](const double* y, double* d) {
    const Kepler km = kepler_of(y);
    double Em = km.m + km.e * std::sin(km.m);
    for (int it = 0; it < 50; ++it) {
      const double dE = (Em - km.e * std::sin(Em) - km.m) / (1.0 - km.e * std::cos(Em));
      Em -= dE;
      if (std::fabs(dE) < 1e-15) break;
    }
    const double n = y[kN], etam = std::sqrt(1.0 - km.e * km.e);
    const AngleTrig agm = angle_trig(km);
    const Perifocal pfm = perifocal_of(agm);
    const Vec3 us[2] = {b.sun_u, b.moon_u};
    const double rs[2] = {b.sun_r, b.moon_r}, ms[2] = {kSunMass, kMoonMass};
    double six[6] = {0, 0, 0, 0, 0, 0};
    double coef[kOutput_sixCoefs];
    output_six_coefs(km.e, n, etam, km.i, km.argp, Em, coef);
    for (int j = 0; j < 2; ++j) {
      double A, B, C;
      direction_cosines(pfm, us[j], A, B, C);
      const double ar = km.a / rs[j];
      const double C2 = ms[j] * ar * ar * ar * n;
      output_six(coef, A, B, C, C2, C2 * ar, six);
    }
    six_to_equinoctial(agm, six, d);
  };
  double y0[6] = {0, 0, 0, 0, 0, 0};
  third_body_short_period(ym, frame_of(ym), b, eccentric_longitude(ym), 2, hi, y0);
  for (int m = 0; m < 6; ++m) y0[m] += ym[m];
  Vec3 r, v;
  double w0;
  state_at_F(y0, frame_of(y0), eccentric_longitude(y0), r, v, w0);
  const auto acc = [&](Vec3 x) {
    const double rn = norm(x);
    return (-kMu / (rn * rn * rn)) * x + tidal_tail(x, b.sun_u, b.sun_r, kSunMass, 2, hi) +
           tidal_tail(x, b.moon_u, b.moon_r, kMoonMass, 2, hi);
  };
  const double T = sdnap::kTwoPi / ym[kN];
  const int sub = 2000;
  const double h = T / (K * sub);
  for (int k = 0; k <= K; ++k) {
    if (k > 0)
      for (int q = 0; q < sub; ++q) {
        const Vec3 k1v = acc(r), k1r = v;
        const Vec3 k2v = acc(r + (0.5 * h) * k1r), k2r = v + (0.5 * h) * k1v;
        const Vec3 k3v = acc(r + (0.5 * h) * k2r), k3r = v + (0.5 * h) * k2v;
        const Vec3 k4v = acc(r + h * k3r), k4r = v + h * k3v;
        r = r + (h / 6.0) * (k1r + 2.0 * k2r + 2.0 * k3r + k4r);
        v = v + (h / 6.0) * (k1v + 2.0 * k2v + 2.0 * k3v + k4v);
      }
    const double t = k * T / K;
    double yo[6] = {0, 0, 0, 0, 0, 0}, yb[6], dq[6] = {0, 0, 0, 0, 0, 0}, dc[6];
    {
      const Vec3 hv = cross(r, v);
      const Vec3 w = (1.0 / norm(hv)) * hv;
      yo[kChi] = w.x / (1.0 + w.z);
      yo[kPsi] = -w.y / (1.0 + w.z);
      const double rn = norm(r), inva = 2.0 / rn - dot(v, v) / kMu, a = 1.0 / inva;
      yo[kN] = std::sqrt(kMu * inva * inva * inva);
      const Frame fq = frame_of(yo);
      const Vec3 ev = (1.0 / kMu) * cross(v, hv) - (1.0 / rn) * r;
      const double kk = dot(ev, fq.f), hh = dot(ev, fq.g);
      yo[kAf] = kk;
      yo[kAg] = hh;
      const double eta = std::sqrt(1.0 - kk * kk - hh * hh), beta = 1.0 / (1.0 + eta);
      const double X = dot(r, fq.f) / a + kk, Y = dot(r, fq.g) / a + hh;
      const double cF = ((1.0 - kk * kk * beta) * X - hh * kk * beta * Y) / eta;
      const double sF = (-hh * kk * beta * X + (1.0 - hh * hh * beta) * Y) / eta;
      yo[kLam] = std::atan2(sF, cF) + hh * cF - kk * sF;
    }
    for (int m = 0; m < 6; ++m) yb[m] = ym[m] + avg[m] * t;
    yb[kLam] = ym[kLam] + (ym[kN] + avg[kLam]) * t;
    third_body_short_period(yb, frame_of(yb), b, eccentric_longitude(yb), 2, hi, dq);
    closed(yb, dc);
    double* o = out + 18 * k;
    for (int m = 0; m < 6; ++m) {
      o[m] = yo[m] - yb[m];
      o[6 + m] = dq[m];
      o[12 + m] = dc[m];
    }
    o[kLam] -= sdnap::kTwoPi * std::round(o[kLam] / sdnap::kTwoPi);
  }
  return 0;
}

SDNAP_EXPORT("sdnap_test_rate_compare")
int32_t sdnap_test_rate_compare(const double* yin, double d50, double* out) {
  using namespace sdnap::xpt;
  double y[6];
  for (int j = 0; j < 6; ++j) y[j] = yin[j];
  const Frame fr = frame_of(y);
  const Kepler k = kepler_of(y, fr.a);
  const Bodies b = bodies_at(d50);
  const AngleTrig ag = angle_trig(k);
  const Perifocal pf = perifocal_of(ag);
  const Vec3 us[2] = {b.sun_u, b.moon_u};
  const double rs[2] = {b.sun_r, b.moon_r}, ms[2] = {kSunMass, kMoonMass};
  double six[6] = {0, 0, 0, 0, 0, 0};
  double coef[kThird_body_sixCoefs];
  third_body_six_coefs(k.e, fr.n, fr.eta, k.i, k.argp, coef);
  for (int j = 0; j < 2; ++j) {
    double A, B, C;
    direction_cosines(pf, us[j], A, B, C);
    const double ar = fr.a / rs[j];
    const double C2 = ms[j] * ar * ar * ar * fr.n;
    third_body_six(coef, A, B, C, C2, C2 * ar, six);
  }
  six_to_equinoctial(ag, six, out);
  TailSamples s;
  tail_samples(y, fr, b, 2, 3, s);
  for (int m = 0; m < 6; ++m) {
    out[6 + m] = 0.0;
    for (int j = 0; j < kThirdBodyTailNodes; ++j) out[6 + m] += s.w[j] * s.f[m][j] / kThirdBodyTailNodes;
  }
  return 0;
}

SDNAP_EXPORT("sdnap_frame_probe")`;
  const [PROBE, OFF] = [
    testBuild('probe', [['abi.inc', 'SDNAP_EXPORT("sdnap_frame_probe")', PROBES]]),
    testBuild('off', [['xp_theory.inc', 'constexpr int kThirdBodyTailDegree = 10;', 'constexpr int kThirdBodyTailDegree = 3;']]),
  ];

  const run = (data, env) => new Promise((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), {workerData: data, env: env ?? process.env});
    w.once('message', (m) => { w.terminate(); resolve(m); });
    w.once('error', reject);
  });
  const FIXTURES = {
    'half-day': {name: 'half-day-critical', n: 2.0059, e: 0.72, i: 63.4, raan: 300, argp: 270, ma: 10, drag: false},
    Molniya: {name: 'Molniya', n: 2, e: 0.74, i: 63.4, raan: 300, argp: 270, ma: 10, drag: true},
    '12-hour-55deg': {name: '12-hour-55deg', n: 2, e: 0.72, i: 55, raan: 300, argp: 270, ma: 10, drag: false},
    GTO: {name: 'GTO', n: 2.40, e: 0.72, i: 27, raan: 40, argp: 270, ma: 10, drag: false},
  };
  const jobs = [
    ...Object.entries(FIXTURES).map(([f, c]) => ({key: `release ${f}`, data: {kind: 'fixture', c: {...c, hourly: true, modulePath: wasmPath}}})),
    ...['half-day', 'Molniya'].map((f) => ({key: `off ${f}`, data: {kind: 'fixture', c: {...FIXTURES[f], hourly: true, modulePath: OFF}}})),
    {key: 'probe', data: {kind: 'probe'}, env: {...process.env, SDNAP_WASM: PROBE}},
  ];
  const results = {};
  let next = 0;
  await Promise.all(Array.from({length: 4}, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      results[job.key] = await run(job.data, job.env);
    }
  }));

  const probe = results.probe;
  for (const row of probe) console.log(JSON.stringify({termByTerm: `${row.g} e ${row.e}`, ...Object.fromEntries(['quadrature3', 'quadrature10', 'closedForm', 'averagedRatesMetersPerDay'].map((k) => [k, Object.fromEntries(NAMES.map((nm, j) => [nm, +row[k][j].toFixed(3)]))]))}));
  const single = (f) => results[`release ${f}`].days[7].e;
  const whole = (arm, f, d) => results[`${arm} ${f}`].wholeDay[d];
  const report = {
    offDay1AlongTrack: {'half-day': whole('off', 'half-day', 1).t, Molniya: whole('off', 'Molniya', 1).t},
    releaseDay7: Object.fromEntries(Object.keys(FIXTURES).map((f) => [f, {alongTrack: whole('release', f, 7).t, radial: whole('release', f, 7).r, crossTrack: whole('release', f, 7).n, singleSample: single(f)}])),
  };
  console.log(JSON.stringify(report));

  for (const row of probe) {
    for (const hi of [3, 10]) row[`quadrature${hi}`].forEach((v, j) => assert.ok(v <= 0.15, `${row.g} e ${row.e} degree 2-${hi} ${NAMES[j]}: ${v} m RMS against the integration`));
    row.averagedRatesMetersPerDay.forEach((v, j) => assert.ok(v <= 0.1, `${row.g} e ${row.e} ${NAMES[j]}: closed-form average ${v} m/day from the quadrature`));
  }
  const g1 = probe.find((r) => r.g === 'G1' && r.e === 0.72).closedForm[4];
  assert.ok(Math.abs(g1 - 298.2) <= 1, `G1 e 0.72: the closed form's mean-longitude error ${g1} m RMS`);
  assert.ok(report.offDay1AlongTrack['half-day'] <= 95, 'half-day day-1 along-track, degree 4 up off');
  assert.ok(report.offDay1AlongTrack.Molniya <= 85, 'Molniya day-1 along-track, degree 4 up off');
  // re-recorded 2026-11-10 on 0.6.8 and FFM 2.2.1's truth. 0.6.3 (7154b48d, the grid in E for the first-order tesseral
  // families above e 0.3, SPEC 16.11) moved every fixture; measured on 2.2.1, 0.6.2 against 0.6.3: half-day 34.34 / 22.97 /
  // 59.33 to 31.44 / 16.84 / 30.17 m, Molniya 276.53 / 208.40 / 393.01 to 238.03 / 173.92 / 331.47 m, 12 h at 55 deg
  // 67.33 / 25.13 / 55.96 to 66.68 / 5.70 / 65.12 m; 0.6.5 by at most 0.47 m since. The pins before: 0.4.15 (SPEC 16.11) and,
  // for Molniya, 0.4.16 (SPEC 16.12, 12.8: 291.41 / 219.72 / 419.70 at 0.4.15) on FFM 2.0.4's truth (half-day 34.33 /
  // 23.12 / 60.02, Molniya 276.44 / 208.33 / 392.90, 12 h 67.25 / 25.32 / 56.38 m)
  for (const [f, [t, r, s]] of Object.entries({'half-day': [31.45, 16.88, 30.22], Molniya: [238.50, 174.28, 332.16], '12-hour-55deg': [66.61, 5.68, 64.94]})) {
    assert.ok(Math.abs(report.releaseDay7[f].alongTrack - t) <= 0.5, `${f}: day-7 along-track RMS ${report.releaseDay7[f].alongTrack} m`);
    assert.ok(Math.abs(report.releaseDay7[f].radial - r) <= 0.5, `${f}: day-7 radial RMS ${report.releaseDay7[f].radial} m`);
    assert.ok(Math.abs(report.releaseDay7[f].singleSample - s) <= 0.5, `${f}: day-7 sample ${report.releaseDay7[f].singleSample} m`);
  }
  assert.ok(report.releaseDay7.GTO.alongTrack <= 961.5 && report.releaseDay7.GTO.radial <= 935.5, 'GTO: day 7 no worse than 961/935 m');
  // re-recorded 2026-11-10 on 0.6.8 and FFM 2.2.1 (0.6.2 258.96 m, 0.6.3 275.80 m on 2.2.1; the sample is a single state
  // and GTO's truth moved most between FFM 2.0.4 and 2.2.1, 2.5 m along-track RMS at day 7); 249.02 m at 0.4.15 on 2.0.4
  // (SPEC 16.11), 929.45 m at 0.4.14 (SPEC 16.10), 2449.15 m at 0.4.11-0.4.13
  assert.ok(Math.abs(report.releaseDay7.GTO.singleSample - 275.78) <= 0.5, `GTO: day-7 sample ${report.releaseDay7.GTO.singleSample} m`);
  reproduceConformance();
  console.log('third-body short-period eccentric E2E: PASS');
}

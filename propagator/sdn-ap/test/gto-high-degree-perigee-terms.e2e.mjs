#!/usr/bin/env node
// Registration (2026-11-03, modules-sdn-ap-gto-high-degree-perigee-terms-20261103): above e 0.3 (SPEC 16.11) AP's zonal
// tail carries every long-period term and its first-order tesseral set every q to |q| <= 10. Baseline the 0.4.14 release
// (git 8fdf5b1af). Test builds: VERIFY (this package with an export comparing the new terms with independent
// integrations) and, for the 4x4 case, this package and 0.4.14's sources with the Sun's and Moon's mass ratios and J5 zero.
// Acceptance, FFM model truth as test/lib/heo-model-truth.mjs (EGM96 70x70, Sun and Moon from DE440; 72 h fits from an
// osculating perigee; 7 days flown hourly; day-7 whole-day RMS along-track / radial, m):
// 1. GTO (n 2.40 rev/day, e 0.72, i 27 deg; perigee 220 km): each at most 250 and within 2 of 204.15 / 133.92 (0.4.14:
//    419.32 / 455.90);
// 2. re-recorded as improvements, each within 0.5 of the value here and below 0.4.14's: the 500 km perigee GTO 109.46 /
//    70.85, half-day 34.33 / 23.12, 12 h at 55 deg 67.25 / 25.32;
// 3. Molniya with drag, its coefficient fitted: re-recorded at 276.44 / 208.33 within 0.5 (0.4.16, SPEC 16.12; 0.4.15: 291.41 / 219.72) (0.4.14: 149.82 / 175.90; the
//    fitted coefficient 0.0457 against the truth's 0.044, SPEC 16.11, modules-sdn-ap-drag-high-eccentricity-20261103);
//    with the coefficient pinned at the truth's 0.044: along-track no worse than 0.4.14's;
// 4. the field cut to 4x4 on both sides, the Sun, Moon and J5 off on both sides, 2-minute samples: day-7 3D RMS at most
//    100 (0.4.14 printed first);
// 5. at the GTO fixture's elements, against independent integrations, each element within 0.1 m over one orbit: the
//    zonal tail's rates (J6-J20) against the potential averaged over M by quadrature; the first-order tesseral set's
//    displacements against a numerical integration of its rates (RMS) and against Hansen coefficients by quadrature in M;
// 6. default-FORCES XP digest bit-exact.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {runModelTruth} from './lib/heo-model-truth.mjs';
import {wasmPath} from './lib/module.mjs';

const BASE = '8fdf5b1af', scratch = '/Users/tj/software/terrain-work/body-look/codex-apfix-d9/gto-terms';
const modules = fileURLToPath(new URL('../../../', import.meta.url)), packageRoot = path.join(modules, 'propagator/sdn-ap');
fs.mkdirSync(scratch, {recursive: true});
const baseline = path.join(scratch, `release-${BASE}.wasm`);
fs.writeFileSync(baseline, execFileSync('git', ['-C', modules, 'show', `${BASE}:propagator/sdn-ap/dist/isomorphic/module.wasm`], {maxBuffer: 1 << 26}));

const VERIFY = String.raw`
SDNAP_EXPORT("sdnap_test_wide_verify")
int32_t sdnap_test_wide_verify(const double* yin, int32_t zd, int32_t td, double* out) {
  using namespace sdnap;
  using namespace sdnap::xpt;
  using namespace sdnap::xpt::tess;
  const double a = yin[0], e = yin[1], inc = yin[2], node = yin[3], argp = yin[4], M0 = yin[5], th0 = yin[6];
  const double n = kKe / std::pow(a, 1.5), eta = std::sqrt(1.0 - e * e), si = std::sin(inc), ci = std::cos(inc);
  const double na2 = n * a * a, tanhalf = si / (1.0 + ci), T = kTwoPi / n, toM = kRe * 1000.0;
  for (int k = 0; k < 32; ++k) out[k] = 0.0;
  // 1. The zonal tail's rates against the potential J6..Jzd averaged over M (8192 points in E).
  {
    const int count = zonal_count(zd, true);
    float* F = static_cast<float*>(std::malloc(4 * count * sizeof(float)));
    zonal_visit_terms(zd, true, inc, e, F);
    const Kepler kp{a, e, inc, node, argp, M0};
    double ana[6] = {0, 0, 0, 0, 0, 0};
    zonal_six(F, zd, true, kp, n, eta, si, ci, ana);
    std::free(F);
    const auto Rbar = [&](double aa, double ee, double ii, double ww) {
      constexpr int N = 8192;
      const double et = std::sqrt(1.0 - ee * ee), sI = std::sin(ii);
      double sum = 0.0;
      for (int k = 0; k < N; ++k) {
        const double E = kTwoPi * (k + 0.5) / N, sE = std::sin(E), cE = std::cos(E);
        const double roa = 1.0 - ee * cE, ir = 1.0 / (aa * roa), x = sI * std::sin(ww + std::atan2(et * sE, cE - ee));
        double p0 = 1.0, p1 = x, irl = ir * ir, R = 0.0;
        for (int l = 2; l <= zd; ++l) {
          const double p2 = ((2.0 * l - 1.0) * x * p1 - (l - 1.0) * p0) / l;
          p0 = p1;
          p1 = p2;
          irl *= ir;
          if (l >= 6) R += kEgmC[l][0] * std::sqrt(2.0 * l + 1.0) * p2 * irl;
        }
        sum += R * roa;
      }
      return kMu * sum / N;
    };
    const double hA = 1e-6 * a, h = 1e-6;
    const double dA = (Rbar(a + hA, e, inc, argp) - Rbar(a - hA, e, inc, argp)) / (2.0 * hA);
    const double dE = (Rbar(a, e + h, inc, argp) - Rbar(a, e - h, inc, argp)) / (2.0 * h);
    const double dI = (Rbar(a, e, inc + h, argp) - Rbar(a, e, inc - h, argp)) / (2.0 * h);
    const double dW = (Rbar(a, e, inc, argp + h) - Rbar(a, e, inc, argp - h)) / (2.0 * h);
    double num[6];
    num[1] = -eta * dW / (na2 * e);
    num[2] = ci * dW / (na2 * eta * si);
    num[3] = (eta / na2) * dE + e * tanhalf / (na2 * eta) * dI;
    num[4] = dI / (na2 * eta);
    num[5] = -(2.0 / (n * a)) * dA + (eta * e / (na2 * (1.0 + eta))) * dE + (tanhalf / (na2 * eta)) * dI;
    for (int k = 1; k < 6; ++k) {
      out[k - 1] = std::fabs(ana[k] - num[k]) * T * a * toM;
      out[20 + k - 1] = std::fabs(ana[k]) * T * a * toM;
    }
    out[18] = count;
  }
  // 2. The first-order tesseral set: its displacements against a numerical integration of its rates over one orbit
  //    (RK4, 0.1 min), the slow elements frozen and the angles at the secular J2 rates the set uses; 3. against Hansen
  //    coefficients by quadrature in M (8192 points).
  {
    const int cls = res::band_of(n), nd = td > kShallowCap ? kShallowCap : td, spd = td > kSpCap ? kSpCap : td;
    SpCoef* tab = static_cast<SpCoef*>(std::malloc(sp_bound(spd, e > kWideE) * sizeof(SpCoef)));
    const int count = sp_terms(spd, nd, cls, false, n, inc, e, tab);
    out[17] = count;
    const double p_sl = a * eta * eta, j2 = 1.5 * kJ2 / (p_sl * p_sl);
    const double node_rate = -j2 * n * ci, wdot = 0.5 * j2 * n * (5.0 * ci * ci - 1.0);
    const double mdot = n + 0.5 * j2 * n * eta * (3.0 * ci * ci - 1.0);
    const auto kp_at = [&](double t) { return Kepler{a, e, inc, node + node_rate * t, argp + wdot * t, M0 + mdot * t}; };
    const auto analytic = [&](const SpCoef* tb, double t, double* six) {
      for (int k = 0; k < 6; ++k) six[k] = 0.0;
      sp_six(tb, count, t, kp_at(t), n, eta, si, ci, th0, six);
    };
    const auto rates = [&](double t, double* r6) {
      const Kepler kp = kp_at(t);
      const double beta = kp.node - (th0 + kOmegaE * t);
      double sM = 0, sW = 0, sO = 0, sE = 0, sI = 0, sA = 0;
      for (int k = 0; k < count; ++k) {
        const SpCoef& c = tab[k];
        const int l = c.l, m = c.m, w = c.w, j = c.j;
        const double psi = w * kp.argp + j * kp.m + m * beta, cp = std::cos(psi), sp = std::sin(psi);
        const double C = kEgmC[l][m], S0 = kEgmS[l][m];
        const bool odd = ((l - m) & 1) != 0;
        const double Sv = odd ? -S0 * cp + C * sp : C * cp + S0 * sp;
        const double dS = odd ? S0 * sp + C * cp : -C * sp + S0 * cp;
        const double G = c.g0 + c.g1 * e, A = kMu * std::pow(1.0 / a, l + 1);
        sM += j * A * c.f * G * dS;
        sW += w * A * c.f * G * dS;
        sO += m * A * c.f * G * dS;
        sE += A * c.f * c.g1 * Sv;
        sI += A * c.df * G * Sv;
        sA += -(l + 1) * A * c.f * G * Sv / a;
      }
      r6[0] = -3.0 / (a * a) * sM;
      r6[1] = (eta * eta * sM - eta * sW) / (na2 * e);
      r6[2] = (ci * sW - sO) / (na2 * eta * si);
      r6[3] = (eta / na2) * sE + e * tanhalf / (na2 * eta) * sI;
      r6[4] = sI / (na2 * eta);
      r6[5] = -(2.0 / (n * a)) * sA + (eta * e / (na2 * (1.0 + eta))) * sE + (tanhalf / (na2 * eta)) * sI;
    };
    const double scale[6] = {(2.0 / 3.0) * a / n * toM, a * toM, a * toM, a * toM, a * toM, a * toM};
    double six0[6], y[6] = {0, 0, 0, 0, 0, 0}, ss[6] = {0, 0, 0, 0, 0, 0}, mag[6] = {0, 0, 0, 0, 0, 0};
    analytic(tab, 0.0, six0);
    const auto deriv = [&](double t, const double* yy, double* d) {
      rates(t, d);
      d[5] += six0[0] + yy[0];
    };
    const double hs = 0.1;
    const int steps = static_cast<int>(std::ceil(T / hs)), every = 20;
    int samples = 0;
    for (int s = 0; s < steps; ++s) {
      const double t = s * hs;
      double k1[6], k2[6], k3[6], k4[6], yt[6];
      deriv(t, y, k1);
      for (int k = 0; k < 6; ++k) yt[k] = y[k] + 0.5 * hs * k1[k];
      deriv(t + 0.5 * hs, yt, k2);
      for (int k = 0; k < 6; ++k) yt[k] = y[k] + 0.5 * hs * k2[k];
      deriv(t + 0.5 * hs, yt, k3);
      for (int k = 0; k < 6; ++k) yt[k] = y[k] + hs * k3[k];
      deriv(t + hs, yt, k4);
      for (int k = 0; k < 6; ++k) y[k] += hs * (k1[k] + 2.0 * k2[k] + 2.0 * k3[k] + k4[k]) / 6.0;
      if ((s + 1) % every == 0) {
        double six[6];
        analytic(tab, t + hs, six);
        for (int k = 0; k < 6; ++k) {
          const double d = (six[k] - six0[k] - y[k]) * scale[k];
          ss[k] += d * d;
          mag[k] += ((six[k] - six0[k]) * scale[k]) * ((six[k] - six0[k]) * scale[k]);
        }
        ++samples;
      }
    }
    for (int k = 0; k < 6; ++k) {
      out[5 + k] = std::sqrt(ss[k] / samples);
      out[26 + k] = std::sqrt(mag[k] / samples);
    }
    // Hansen coefficients by quadrature in M.
    constexpr int NM = 8192;
    double* aor = static_cast<double*>(std::malloc(NM * sizeof(double)));
    double* fv = static_cast<double*>(std::malloc(NM * sizeof(double)));
    for (int k = 0; k < NM; ++k) {
      const double M = kTwoPi * (k + 0.5) / NM;
      double E = M + e * std::sin(M);
      for (int it = 0; it < 50; ++it) {
        const double dE = (E - e * std::sin(E) - M) / (1.0 - e * std::cos(E));
        E -= dE;
        if (std::fabs(dE) < 1e-15) break;
      }
      aor[k] = 1.0 / (1.0 - e * std::cos(E));
      fv[k] = std::atan2(eta * std::sin(E), std::cos(E) - e);
    }
    SpCoef* tab2 = static_cast<SpCoef*>(std::malloc((count > 0 ? count : 1) * sizeof(SpCoef)));
    double worst = 0.0;
    for (int k = 0; k < count; ++k) {
      const SpCoef& c = tab[k];
      double G = 0.0;
      for (int q = 0; q < NM; ++q) {
        const double M = kTwoPi * (q + 0.5) / NM;
        G += std::pow(aor[q], c.l + 1) * std::cos(c.w * fv[q] - c.j * M);
      }
      G /= NM;
      tab2[k] = c;
      tab2[k].g0 = static_cast<float>(G - c.g1 * e);
      const double Gt = c.g0 + c.g1 * e;
      if (std::fabs(G) > 1e-9) worst = std::fmax(worst, std::fabs(Gt - G) / std::fabs(G));
    }
    out[19] = worst;
    double ss2[6] = {0, 0, 0, 0, 0, 0};
    int n2 = 0;
    for (double t = 0.0; t <= T; t += 2.0, ++n2) {
      double s1[6], s2[6];
      analytic(tab, t, s1);
      analytic(tab2, t, s2);
      for (int k = 0; k < 6; ++k) ss2[k] += ((s1[k] - s2[k]) * scale[k]) * ((s1[k] - s2[k]) * scale[k]);
    }
    for (int k = 0; k < 6; ++k) out[11 + k] = std::sqrt(ss2[k] / n2);
    std::free(aor);
    std::free(fv);
    std::free(tab2);
    std::free(tab);
  }
  return 0;
}
`;

const testBuild = (name, sources, patches) => {
  const tree = path.join(scratch, name), copy = path.join(tree, 'propagator/sdn-ap');
  fs.rmSync(tree, {recursive: true, force: true});
  fs.cpSync(sources, copy, {recursive: true, filter: (p) => !/\/(node_modules|test|dist)(\/|$)/.test(p.slice(sources.length))});
  for (const [file, a, b] of patches) {
    const source = path.join(copy, 'src', file), text = fs.readFileSync(source, 'utf8');
    assert.equal(text.split(a).length, 2, `${name}: ${a.slice(0, 60)}`);
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
const NO_BODIES_J5 = [
  ['xp_theory.inc', 'constexpr double kSunMass = 332946.038;', 'constexpr double kSunMass = 0.0;'],
  ['xp_theory.inc', 'constexpr double kMoonMass = 0.012300034;', 'constexpr double kMoonMass = 0.0;'],
  ['xp_theory.inc', 'constexpr double kJ5 = -2.27296082868698e-7;', 'constexpr double kJ5 = 0.0;'],
];
const verify = testBuild('verify', packageRoot, [['abi.inc', 'SDNAP_EXPORT("sdnap_frame_probe")', VERIFY + '\nSDNAP_EXPORT("sdnap_frame_probe")']]);
const fourRelease = testBuild('four-release', packageRoot, NO_BODIES_J5);
const baseSources = path.join(scratch, 'base-sources');
fs.rmSync(baseSources, {recursive: true, force: true});
fs.mkdirSync(baseSources, {recursive: true});
const archive = path.join(scratch, 'base.tar');
fs.writeFileSync(archive, execFileSync('git', ['-C', modules, 'archive', '--format=tar', BASE, 'propagator/sdn-ap'], {maxBuffer: 1 << 28}));
execFileSync('tar', ['-xf', archive, '-C', baseSources]);
const fourBase = testBuild('four-base', path.join(baseSources, 'propagator/sdn-ap'), NO_BODIES_J5);

// 1-3: the fixtures on 0.4.14 and on this build
const FIXTURES = {
  GTO: {n: 2.40, e: 0.72, i: 27, raan: 40, argp: 270, ma: 10, drag: false},
  'GTO-500': {n: 2.40, e: 0.7081, i: 27, raan: 40, argp: 270, ma: 10, drag: false},
  'half-day': {n: 2.0059, e: 0.72, i: 63.4, raan: 300, argp: 270, ma: 10, drag: false},
  '12-hour-55deg': {n: 2, e: 0.72, i: 55, raan: 300, argp: 270, ma: 10, drag: false},
  Molniya: {n: 2, e: 0.74, i: 63.4, raan: 300, argp: 270, ma: 10, drag: true},
  'Molniya-pinned': {n: 2, e: 0.74, i: 63.4, raan: 300, argp: 270, ma: 10, drag: true, fitPolicy: {form: 'GAUSSIAN_SIGNED', mean: 0.044, sigma: 1e-7}},
};
const fixtures = {};
for (const [name, c] of Object.entries(FIXTURES)) {
  fixtures[name] = {};
  for (const [arm, modulePath] of [['0.4.14', baseline], ['release', wasmPath]]) {
    const r = await runModelTruth({name, ...c, hourly: true, modulePath});
    fixtures[name][arm] = {alongTrack: r.wholeDay[7].t, radial: r.wholeDay[7].r, crossTrack: r.wholeDay[7].n, bterm: r.fitted.bterm};
  }
  console.log(JSON.stringify({fixture: name, ...fixtures[name]}));
}

// 4: the 4x4 field on both sides, the Sun, Moon and J5 off on both sides
const four = {};
for (const [arm, modulePath] of [['0.4.14', fourBase], ['release', fourRelease]]) {
  const r = await runModelTruth({name: 'GTO-4x4', ...FIXTURES.GTO, hourly: true, gridMinutes: 2, field: [4, 4], thirdBody: false, forces: [4, 4], modulePath});
  four[arm] = r.wholeDay[7].e;
}
console.log(JSON.stringify({fixture: 'GTO 4x4, Sun, Moon and J5 off', day7ThreeD: four}));

// 5: the new terms against independent integrations at the GTO fixture's elements (argument of perigee 270 deg, where
// the zonal e and i rates vanish) and with the argument of perigee at 300 deg
const host = await createStandaloneHarness('browser', verify, {surface: 'direct'});
const x = host.instance.exports, p = x.sdnap_alloc(64), q = x.sdnap_alloc(256);
const ke = 0.074366859954178854, n0 = 2.40 * 2 * Math.PI / 1440, rad = Math.PI / 180;
const ELEMENTS = ['e', 'i', 'e varpi', 'sin i Omega', 'lambda'];
const checks = [];
for (const argp of [270, 300]) {
  new Float64Array(host.memory.buffer, p, 7).set([(ke / n0) ** (2 / 3), 0.72, 27 * rad, 40 * rad, argp * rad, 10 * rad, 0.0]);
  assert.equal(x.sdnap_test_wide_verify(p, 20, 31, q), 0);
  const v = Array.from(new Float64Array(host.memory.buffer, q, 32));
  checks.push({
    argp,
    zonalRates: Object.fromEntries(ELEMENTS.map((k, j) => [k, {differenceM: v[j], sizeM: v[20 + j]}])),
    tesseralIntegration: Object.fromEntries(['n', ...ELEMENTS].map((k, j) => [k, {rmsM: v[5 + j], sizeM: v[26 + j]}])),
    tesseralHansen: Object.fromEntries(['n', ...ELEMENTS].map((k, j) => [k, {rmsM: v[11 + j]}])),
    tesseralTerms: v[17], zonalTerms: v[18], worstHansenRelative: v[19],
  });
  console.log(JSON.stringify(checks.at(-1)));
}
x.sdnap_free(p);
x.sdnap_free(q);
await host.close?.();

const near = (got, want, tol) => Math.abs(got - want) <= tol;
assert.ok(fixtures.GTO.release.alongTrack <= 250 && fixtures.GTO.release.radial <= 250, `GTO day 7: ${fixtures.GTO.release.alongTrack} / ${fixtures.GTO.release.radial} m`);
assert.ok(near(fixtures.GTO.release.alongTrack, 204.15, 2) && near(fixtures.GTO.release.radial, 133.92, 2), 'GTO within 2 m of 204.15 / 133.92');
for (const [name, [t, r]] of Object.entries({'GTO-500': [109.46, 70.85], 'half-day': [34.33, 23.12], '12-hour-55deg': [67.25, 25.32]})) {
  assert.ok(near(fixtures[name].release.alongTrack, t, 0.5) && near(fixtures[name].release.radial, r, 0.5), `${name}: within 0.5 m of ${t} / ${r}`);
  assert.ok(fixtures[name].release.alongTrack < fixtures[name]['0.4.14'].alongTrack && fixtures[name].release.radial < fixtures[name]['0.4.14'].radial, `${name}: below 0.4.14`);
}
// Molniya re-recorded at 0.4.16 (SPEC 16.12, 12.8; 291.41 / 219.72 at 0.4.15)
assert.ok(near(fixtures.Molniya.release.alongTrack, 276.44, 0.5) && near(fixtures.Molniya.release.radial, 208.33, 0.5), 'Molniya, coefficient fitted: within 0.5 m of 276.44 / 208.33');
assert.ok(fixtures['Molniya-pinned'].release.alongTrack <= fixtures['Molniya-pinned']['0.4.14'].alongTrack, 'Molniya, coefficient pinned: along-track no worse than 0.4.14');
assert.ok(four.release <= 100, `4x4: ${four.release} m`);
for (const check of checks) {
  for (const [k, c] of Object.entries(check.zonalRates)) assert.ok(c.differenceM <= 0.1, `zonal ${k}: ${c.differenceM} m over one orbit`);
  for (const [k, c] of Object.entries(check.tesseralIntegration)) assert.ok(c.rmsM <= 0.1, `tesseral integration ${k}: ${c.rmsM} m RMS`);
  for (const [k, c] of Object.entries(check.tesseralHansen)) assert.ok(c.rmsM <= 0.1, `tesseral Hansen ${k}: ${c.rmsM} m RMS`);
}
execFileSync(process.execPath, [new URL('./conformance.e2e.mjs', import.meta.url).pathname, '--reproduce', new URL('./results/conformance.json', import.meta.url).pathname],
  {stdio: 'inherit', env: {...process.env, SDN_AP_ORACLE_ROOT: process.env.SDN_AP_ORACLE_ROOT ?? '/Users/tj/software/spacedatanetwork-stack/repos/main-packages/space-data-network-closed-modules/packages/sgp4-xp-oracle'}});
console.log('GTO high-degree perigee terms E2E: PASS');

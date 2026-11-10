#!/usr/bin/env node
// Registration (2026-11-03, modules-sdn-ap-gto-high-degree-perigee-terms-20261103): above e 0.3 (SPEC 16.11) AP's zonal
// tail carries every long-period term and its first-order tesseral set every q to |q| <= 10. Baseline the 0.4.14 release
// (git 8fdf5b1af). Test builds: VERIFY (this package with an export comparing the new terms with independent
// integrations) and, for the 4x4 case, this package and 0.4.14's sources with the Sun's and Moon's mass ratios and J5 zero.
// Acceptance, FFM model truth as test/lib/heo-model-truth.mjs (EGM96 70x70, Sun and Moon from DE440; 72 h fits from an
// osculating perigee; 7 days flown hourly; day-7 whole-day RMS along-track / radial, m):
// 1. GTO (n 2.40 rev/day, e 0.72, i 27 deg; perigee 220 km): each at most 250 and within 2 of 192.87 / 123.44 (0.4.14:
//    422.11 / 459.10);
// 2. re-recorded as improvements, each within 0.5 of the value here and below 0.4.14's: the 500 km perigee GTO 94.07 /
//    56.07, half-day 31.44 / 16.84, 12 h at 55 deg 66.68 / 5.70 (0.6.3, FFM 2.2.1 truth);
// 3. Molniya with drag, its coefficient fitted: re-recorded at 238.03 / 173.92 within 0.5 (0.6.3; 0.4.14: 460.98 / 260.43; the
//    fitted coefficient 0.04462 against the truth's 0.044, SPEC 16.11, modules-sdn-ap-drag-high-eccentricity-20261103);
//    with the coefficient pinned at the truth's 0.044: along-track no worse than 0.4.14's;
// 4. the field cut to 4x4 on both sides, the Sun, Moon and J5 off on both sides, 2-minute samples: day-7 3D RMS at most
//    100 (0.4.14 printed first);
// 5. at the GTO fixture's elements, against an independent integration, each element within 0.1 m over one orbit: the
//    zonal tail's rates (J6-J20) against the potential averaged over M by quadrature (the first-order tesseral families,
//    a grid from 0.6.3, are checked against the full-field quadrature in test/themis-ripple.e2e.mjs);
// 6. default-FORCES XP digest bit-exact.
import assert from 'node:assert/strict';
import {requireTruth} from './lib/ffm-truth.mjs';
requireTruth('a9133120775291c4dfbf9151d0617850be560934943a178419fdd8e3fed765e4'); // the model truth: FFM 2.2.1 (modules 9cb02c8e)
import fs from 'node:fs';
import {scratchTemp} from './lib/scratch.mjs';
import {spwFixtureText} from './lib/spw-constant.mjs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {reproduceConformance} from './lib/conformance-step.mjs';
import {fileURLToPath} from 'node:url';
import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {runModelTruth} from './lib/heo-model-truth.mjs';
import {wasmPath} from './lib/module.mjs';

const BASE = '8fdf5b1af';
const modules = fileURLToPath(new URL('../../../', import.meta.url)), packageRoot = path.join(modules, 'propagator/sdn-ap');
// a scratch outside the package: the test builds copy the package's sources, which cannot hold their own destination
const scratch = scratchTemp('sdn-ap-gto-terms-');
// The truth is pinned: the model truth's generator (propagator/ffm's dist, FFM 2.2.1 on SDS 1.279.0 at modules 9cb02c8e2) and its $SPW rows. A
// different generator or rows changes every figure below; the figures are re-recorded with a new pin, never silently.
const FFM_DIST_SHA256 = 'a9133120775291c4dfbf9151d0617850be560934943a178419fdd8e3fed765e4';
const SPW_ROWS_SHA256 = 'd7018d1d33afa58220f3f95219f3ef3bd3802129dee5aee378fd46b6c7971f42';
{
  const {createHash} = await import('node:crypto');
  const digest = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  assert.equal(digest(path.join(modules, 'propagator/ffm/dist/isomorphic/module.wasm')), FFM_DIST_SHA256, 'model truth generator (FFM dist) pinned');
  assert.equal(createHash('sha256').update(spwFixtureText()).digest('hex'), SPW_ROWS_SHA256, 'model truth $SPW rows pinned');
}
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
  // The first-order tesseral families above e 0.3 are the grid of SPEC 16.11; test/themis-ripple.e2e.mjs checks it against the
  // full-field quadrature, at this fixture's elements among others.
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
    zonalTerms: v[18],
  });
  console.log(JSON.stringify(checks.at(-1)));
}
x.sdnap_free(p);
x.sdnap_free(q);
await host.close?.();

const near = (got, want, tol) => Math.abs(got - want) <= tol;
assert.ok(fixtures.GTO.release.alongTrack <= 250 && fixtures.GTO.release.radial <= 250, `GTO day 7: ${fixtures.GTO.release.alongTrack} / ${fixtures.GTO.release.radial} m`);
assert.ok(near(fixtures.GTO.release.alongTrack, 192.87, 2) && near(fixtures.GTO.release.radial, 123.44, 2), 'GTO within 2 m of 192.87 / 123.44');
for (const [name, [t, r]] of Object.entries({'GTO-500': [94.07, 56.07], 'half-day': [31.44, 16.84], '12-hour-55deg': [66.68, 5.70]})) {
  assert.ok(near(fixtures[name].release.alongTrack, t, 0.5) && near(fixtures[name].release.radial, r, 0.5), `${name}: within 0.5 m of ${t} / ${r}`);
  assert.ok(fixtures[name].release.alongTrack < fixtures[name]['0.4.14'].alongTrack && fixtures[name].release.radial < fixtures[name]['0.4.14'].radial, `${name}: below 0.4.14`);
}
// Molniya re-recorded at 0.6.3 (the grid, exact keys in a fit; FFM 2.2.1 truth)
assert.ok(near(fixtures.Molniya.release.alongTrack, 238.03, 0.5) && near(fixtures.Molniya.release.radial, 173.92, 0.5), 'Molniya, coefficient fitted: within 0.5 m of 238.03 / 173.92');
assert.ok(fixtures['Molniya-pinned'].release.alongTrack <= fixtures['Molniya-pinned']['0.4.14'].alongTrack, 'Molniya, coefficient pinned: along-track no worse than 0.4.14');
assert.ok(four.release <= 100, `4x4: ${four.release} m`);
for (const check of checks) {
  for (const [k, c] of Object.entries(check.zonalRates)) assert.ok(c.differenceM <= 0.1, `zonal ${k}: ${c.differenceM} m over one orbit`);
}
reproduceConformance();
fs.rmSync(scratch, {recursive: true, force: true});
console.log('GTO high-degree perigee terms E2E: PASS');

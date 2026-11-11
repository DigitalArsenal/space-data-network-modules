#!/usr/bin/env node
// Registration: orbit-accuracy-experiments experiments/operator-theory/THEMIS-RIPPLE-FIX.md (modules-sdn-ap-tesseral-series-ripple-20261105).
// Above e 0.3 (SPEC 16.11) the first-order tesseral families of degree 2 to 12 are a closed-form grid in the eccentric anomaly.
// 1. Against the full-field quadrature (each (l, m) of the pinned field evaluated directly on the Kepler ellipse, 2,048 mean anomalies
//    by 32 arguments of perigee, |j| <= 1023, the table's admission rules), 7 days at 300 s at the mean elements of the AP (31, 20) fits
//    of THEMIS D 2013-02-12 and THEMIS E 2013-02-16 and at the GTO fixture's: RMS <= 1 m, maximum <= 5 m, median |second difference|
//    of the difference <= 0.1 m.
// 3. The 12 THEMIS windows as recorded on this source's build against the base: median roughness under 0.2 m; the paired ratio's
//    upper bootstrap bound at days 1, 3 and 7 at or below 1.05.
// 2. No harm at e 0.3 and below: AP (31, 20) seeded sets (LEO, geostationary, Etalon-like, GPS-like, e 0.25, e 0.3) and a
//    fitted AP set flown 2 days at 600 s give ephemerides within NO_HARM (below) on this build and on BASE (sdn-ap 0.6.21,
//    SHA-256 checked; sdn-ap 0.6.2 until 0.6.20, history at NO_HARM); the SGP4XP seed byte-identical.
import assert from 'node:assert/strict';
import {requireTruth} from './lib/ffm-truth.mjs';
requireTruth('ea4576901f9e8dc21af2c24feb7887645706ef934488cb9756a0b5c21ab47934'); // the model truth: FFM 2.3.0 (modules 48a00fd6), 2.2.1's truth bit for bit
import crypto from 'node:crypto';
import fs from 'node:fs';
import {scratchTemp} from './lib/scratch.mjs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {wasmPath} from './lib/module.mjs';
import {seedOcm, flight, T} from './lib/ocm.mjs';
import {oemDistance} from './lib/oem-distance.mjs';
import {configuration} from './lib/pcf.mjs';

const BASE_VERSION = '0.6.21', BASE = '589749f63', BASE_SHA256 = '5deb3d761f82f5d530952163827402c189039a84af55e023fd09d5f231048a6b';
// 2's bound on the AP seeds (fixed elements, 48 h at 600 s). Against sdn-ap 0.6.2 (modules c82160de7, SHA-256 84d50dca...)
// until 0.6.20: byte-identical until 0.6.5, whose speed changes move a flight of fixed elements by millimeters (SPEC 16.8);
// measured 2026-11-10 on 0.6.8, per seed: LEO 3.10, GEO 0.41, Etalon 3.62, GPS 5.01, e 0.25 9.11 and e 0.3 10.66 mm
// (velocity at most 0.0022 mm/s); the bound is 15 mm. The geostationary seed moved by design from 0.6.19 (the one-day
// class's resonant gravity above degree 4, stack #434, SPEC 16.2: 5.27 m over the 48 h), bounded apart at 6 m and 0.5
// mm/s against 0.6.2. 0.6.21 (SPEC 16.15 and 16.16, stack #464 and #472) moves them from 0.6.2: LEO 0.82, geostationary
// 5,273.24 (the one-day tail of 0.6.19), Etalon 3.62, GPS 5.02, e 0.25 9.11 and e 0.3 10.77 mm (velocity 0.69 to 382.78
// um/s) and the fitted set by 0.84 mm with its covariance by 1.226e-2 of a line's largest entry; SGP4XP byte-identical.
// The seeds carry no AGOM, so 0.6.21 flies them as 0.6.20 does: their millimeters from 0.6.2 are the earlier releases'
// changes to the theory of fixed elements. The fitted set carries the stored AP record's AGOM (-2e-7, sigma 9.5e-3
// m^2/kg): its covariance moves by 1.2 % of a line's largest entry because the covariance's moved sets fly AGOM through
// the shadow on 16.16's rates while its correlations come from that fit's partials (covariance.e2e.mjs: along-track
// response to AGOM at 48 h 1380.7 to 823.7 m per m^2/kg; a fit made and flown by 0.6.21 returns to its theory's numbers
// within 7.1e-5). From 0.6.21 the baseline is 0.6.21 (git 589749f6), every AP set under the one bound, 15 mm.
const NO_HARM = {posM: 0.015, velMmS: 0.01, covOfLargest: 1e-3};
const modules = fileURLToPath(new URL('../../../', import.meta.url)), packageRoot = path.join(modules, 'propagator/sdn-ap');
// a scratch outside the package: the test build copies the package's sources, which cannot hold its own destination
const scratch = scratchTemp('sdn-ap-themis-ripple-');
fs.mkdirSync(scratch, {recursive: true});

const VERIFY = String.raw`
namespace ripple_verify {
using namespace sdnap;
using namespace sdnap::xpt;
constexpr int NM = 2048, NW = 32;
struct Coef { double* re; double* im; int l; };
inline int idx(int w, int j, int l) { return (w + l) * NM + ((j % NM + NM) % NM); }
inline void pbar(int m, int L, double x, double* P) {
  const double c = std::sqrt(std::fmax(0.0, 1.0 - x * x));
  double pmm = 1.0;
  for (int k = 1; k <= m; ++k) pmm *= (k == 1 ? std::sqrt(3.0) : std::sqrt((2.0 * k + 1.0) / (2.0 * k))) * c;
  P[m] = pmm;
  if (m + 1 <= L) P[m + 1] = std::sqrt(2.0 * m + 3.0) * x * pmm;
  for (int l = m + 2; l <= L; ++l) {
    const double a = std::sqrt((2.0 * l + 1.0) * (2.0 * l - 1.0) / ((l - m) * double(l + m)));
    const double b = std::sqrt((2.0 * l + 1.0) * (l + m - 1.0) * (l - m - 1.0) / ((l - m) * double(l + m) * (2.0 * l - 3.0)));
    P[l] = a * x * P[l - 1] - b * P[l - 2];
  }
}
// the coefficient of e^{i (w omega + j M)} of V(beta = 0) - i V(beta = pi / 2m) for one (l, m) on the ellipse (a, e, i)
inline void quad(int l, int m, double a, double e, double inc, double* re, double* im, double* zr, double* zi, double* rr, double* ri) {
  const double si = std::sin(inc), ci = std::cos(inc), eta = std::sqrt(1 - e * e);
  double P[80];
  for (int iw = 0; iw < NW; ++iw) {
    const double w = kTwoPi * iw / NW;
    for (int iM = 0; iM < NM; ++iM) {
      const double M = kTwoPi * iM / NM;
      double E = e < 0.8 ? M : kPi;
      for (int it = 0; it < 60; ++it) { const double d = (E - e * std::sin(E) - M) / (1 - e * std::cos(E)); E -= d; if (std::fabs(d) < 1e-15) break; }
      const double r = a * (1 - e * std::cos(E)), f = std::atan2(eta * std::sin(E), std::cos(E) - e);
      const double u = w + f, su = std::sin(u), cu = std::cos(u), dl = std::atan2(ci * su, cu);
      pbar(m, l, si * su, P);
      const double rad = kMu / r * std::pow(1.0 / r, l) * P[l];
      const double v0 = rad * (tess::kEgmC[l][m] * std::cos(m * dl) + tess::kEgmS[l][m] * std::sin(m * dl));
      const double l1 = kPi / (2.0 * m) + dl;
      const double v1 = rad * (tess::kEgmC[l][m] * std::cos(m * l1) + tess::kEgmS[l][m] * std::sin(m * l1));
      zr[iw * NM + iM] = v0; zi[iw * NM + iM] = -v1;
    }
  }
  for (int w = -l; w <= l; ++w) {
    for (int iM = 0; iM < NM; ++iM) {
      double sr = 0, sj = 0;
      for (int iw = 0; iw < NW; ++iw) {
        const double ang = -kTwoPi * w * iw / NW, c = std::cos(ang), s = std::sin(ang);
        sr += zr[iw * NM + iM] * c - zi[iw * NM + iM] * s; sj += zr[iw * NM + iM] * s + zi[iw * NM + iM] * c;
      }
      rr[iM] = sr / NW; ri[iM] = sj / NW;
    }
    tess::fft_inplace(rr, ri, NM, false);
    for (int iM = 0; iM < NM; ++iM) { re[(w + l) * NM + iM] = rr[iM] / NM; im[(w + l) * NM + iM] = ri[iM] / NM; }
  }
}
inline void kep_pos(double a, double e, double i, double node, double argp, double M, double* r) {
  double E = M;
  for (int it = 0; it < 60; ++it) { const double d = (E - e * std::sin(E) - M) / (1 - e * std::cos(E)); E -= d; if (std::fabs(d) < 1e-15) break; }
  const double eta = std::sqrt(1 - e * e), x = a * (std::cos(E) - e), y = a * eta * std::sin(E);
  const double cw = std::cos(argp), sw = std::sin(argp), cO = std::cos(node), sO = std::sin(node), cI = std::cos(i), sI = std::sin(i);
  const double px = cw * x - sw * y, py = sw * x + cw * y;
  r[0] = cO * px - sO * cI * py; r[1] = sO * px + cO * cI * py; r[2] = sI * py;
}
inline void six_to_pos(const Kepler& k, double n, const double* six, double* dr) {
  const double d[6] = {-2.0 / 3.0 * k.a * six[0] / n, six[1], six[2], six[4] / std::sin(k.i), six[3] / k.e - six[4] / std::sin(k.i), six[5] - six[3] / k.e};
  const double base[6] = {k.a, k.e, k.i, k.node, k.argp, k.m};
  for (int c = 0; c < 3; ++c) dr[c] = 0;
  for (int q = 0; q < 6; ++q) {
    const double h = 1e-7 * (q == 0 ? k.a : 1.0);
    double p[6], mm[6], rp[3], rm[3];
    for (int z = 0; z < 6; ++z) { p[z] = base[z]; mm[z] = base[z]; }
    p[q] += h; mm[q] -= h;
    kep_pos(p[0], p[1], p[2], p[3], p[4], p[5], rp);
    kep_pos(mm[0], mm[1], mm[2], mm[3], mm[4], mm[5], rm);
    for (int c = 0; c < 3; ++c) dr[c] += (rp[c] - rm[c]) / (2 * h) * d[q] * kRe * 1000.0;
  }
}
}  // namespace ripple_verify

// in: n (rev/day), e, i, Omega, omega, M (deg), d50; out: RMS, maximum, roughness of the difference, families
SDNAP_EXPORT("sdnap_test_ripple_verify")
int32_t sdnap_test_ripple_verify(const double* in, double* out) {
  using namespace sdnap;
  using namespace sdnap::xpt;
  using namespace ripple_verify;
  const double n0 = in[0] * kTwoPi / kMinutesPerDay, e0 = in[1], i0 = in[2] * kDeg, O0 = in[3] * kDeg, w0 = in[4] * kDeg, M0 = in[5] * kDeg;
  const int cls = res::band_of(n0), steps = 7 * 288 + 1;
  const double a0 = std::pow(kKe / n0, kX2o3), eta = std::sqrt(1 - e0 * e0), p0 = a0 * eta * eta, c0 = std::cos(i0), si = std::sin(i0);
  const double j2 = 1.5 * kJ2 / (p0 * p0), na2 = n0 * a0 * a0;
  const double mdot = n0 + 0.5 * j2 * n0 * eta * (3 * c0 * c0 - 1), wdot = 0.5 * j2 * n0 * (5 * c0 * c0 - 1), node_rate = -j2 * n0 * c0;
  const double theta_g0 = gsto_afspc(in[6]), h = 1e-6;
  const res::TermSet carried = res::class_terms(cls);
  double* sixr = static_cast<double*>(std::calloc(6 * steps, sizeof(double)));  // the quadrature's six components per step
  const size_t one = 25 * NM;
  double* buf = static_cast<double*>(std::malloc((10 * one + 2 * NW * NM + 2 * NM) * sizeof(double)));
  if (sixr == nullptr || buf == nullptr) return 1;
  double *q0r = buf, *q0i = buf + one, *epr = buf + 2 * one, *epi = buf + 3 * one, *emr = buf + 4 * one, *emi = buf + 5 * one;
  double *ipr = buf + 6 * one, *ipi = buf + 7 * one, *imr = buf + 8 * one, *imi = buf + 9 * one;
  double *zr = buf + 10 * one, *zi = zr + NW * NM, *rr = zi + NW * NM, *ri = rr + NM;
  for (int l = 2; l <= 12; ++l)
    for (int m = 1; m <= l; ++m) {
      quad(l, m, a0, e0, i0, q0r, q0i, zr, zi, rr, ri);
      quad(l, m, a0, e0 + h, i0, epr, epi, zr, zi, rr, ri);
      quad(l, m, a0, e0 - h, i0, emr, emi, zr, zi, rr, ri);
      quad(l, m, a0, e0, i0 + h, ipr, ipi, zr, zi, rr, ri);
      quad(l, m, a0, e0, i0 - h, imr, imi, zr, zi, rr, ri);
      for (int w = -l; w <= l; w += 2)
        for (int j = -NM / 2 + 1; j < NM / 2; ++j) {
          const int at = idx(w, j, l);
          const double Zr = q0r[at], Zi = q0i[at];
          if (w == 0 && j == 0) continue;
          bool out_ = false;
          for (int t = 0; t < carried.count; ++t) if (carried.t[t].l == l && carried.t[t].m == m && carried.t[t].p == (l - w) / 2 && carried.t[t].q == j - w) out_ = true;
          if (cls == 2 && l > 5 && (m & 1) == 0 && j == m / 2) out_ = true;
          const double psidot = w * wdot + j * mdot + m * (node_rate - kOmegaE);
          if (out_ || std::fabs(psidot) < tess::kShallowBand * n0) continue;
          const double Zer = (epr[at] - emr[at]) / (2 * h), Zei = (epi[at] - emi[at]) / (2 * h), Zir = (ipr[at] - imr[at]) / (2 * h), Zii = (ipi[at] - imi[at]) / (2 * h);
          // rates (a, e, i, Omega, omega, M) of this harmonic, then divided by i psi-dot (lambda also by (i psi-dot)^2 through n)
          double R[6][2];
          R[0][0] = 2.0 / (n0 * a0) * (-j * Zi); R[0][1] = 2.0 / (n0 * a0) * (j * Zr);
          R[1][0] = eta * eta / (na2 * e0) * (-j * Zi) + eta / (na2 * e0) * w * Zi; R[1][1] = eta * eta / (na2 * e0) * (j * Zr) - eta / (na2 * e0) * w * Zr;
          R[2][0] = -(c0 * w - m) / (na2 * eta * si) * Zi; R[2][1] = (c0 * w - m) / (na2 * eta * si) * Zr;
          R[3][0] = Zir / (na2 * eta * si); R[3][1] = Zii / (na2 * eta * si);
          R[4][0] = eta / (na2 * e0) * Zer - c0 / (na2 * eta * si) * Zir; R[4][1] = eta / (na2 * e0) * Zei - c0 / (na2 * eta * si) * Zii;
          R[5][0] = 2.0 * (l + 1) / (n0 * a0 * a0) * Zr - eta * eta / (na2 * e0) * Zer; R[5][1] = 2.0 * (l + 1) / (n0 * a0 * a0) * Zi - eta * eta / (na2 * e0) * Zei;
          double D[6][2];
          for (int z = 0; z < 6; ++z) { D[z][0] = R[z][1] / psidot; D[z][1] = -R[z][0] / psidot; }
          const double xr = -1.5 * n0 / a0 * D[0][0], xi = -1.5 * n0 / a0 * D[0][1];
          const double dMr = D[5][0] + xi / psidot, dMi = D[5][1] - xr / psidot;
          const double c6[6][2] = {{-1.5 * n0 / a0 * D[0][0], -1.5 * n0 / a0 * D[0][1]}, {D[1][0], D[1][1]}, {D[2][0], D[2][1]},
                                   {e0 * (D[4][0] + D[3][0]), e0 * (D[4][1] + D[3][1])}, {si * D[3][0], si * D[3][1]},
                                   {dMr + D[4][0] + D[3][0], dMi + D[4][1] + D[3][1]}};
          for (int s = 0; s < steps; ++s) {
            const double t = 5.0 * s, node = O0 + node_rate * t, argp = w0 + wdot * t, M = M0 + mdot * t;
            const double psi = w * argp + j * M + m * (node - (theta_g0 + kOmegaE * t)), cp = std::cos(psi), sp = std::sin(psi);
            for (int z = 0; z < 6; ++z) sixr[6 * s + z] += c6[z][0] * cp - c6[z][1] * sp;
          }
        }
    }
  tess::WideGrid* g = tess::wide_grid_acquire(12, cls, n0, e0, i0);
  if (g == nullptr) return 2;
  double s2 = 0, mx = 0;
  double* d = static_cast<double*>(std::malloc(3 * steps * sizeof(double)));
  for (int s = 0; s < steps; ++s) {
    const double t = 5.0 * s;
    const Kepler k{a0, e0, i0, wrap(O0 + node_rate * t), wrap(w0 + wdot * t), wrap(M0 + mdot * t)};
    double sg[6] = {0, 0, 0, 0, 0, 0}, pr[3], pg[3];
    tess::wide_six(*g, t, k, theta_g0, sg);
    six_to_pos(k, n0, &sixr[6 * s], pr);
    six_to_pos(k, n0, sg, pg);
    double q = 0;
    for (int c = 0; c < 3; ++c) { d[3 * s + c] = pg[c] - pr[c]; q += d[3 * s + c] * d[3 * s + c]; }
    s2 += q; mx = std::fmax(mx, std::sqrt(q));
  }
  double* d2 = static_cast<double*>(std::malloc(steps * sizeof(double)));
  int nd = 0;
  for (int s = 1; s + 1 < steps; ++s) {
    double v = 0;
    for (int c = 0; c < 3; ++c) { const double dd = d[3 * (s + 1) + c] - 2 * d[3 * s + c] + d[3 * (s - 1) + c]; v += dd * dd; }
    d2[nd++] = std::sqrt(v);
  }
  std::sort(d2, d2 + nd);
  out[0] = std::sqrt(s2 / steps); out[1] = mx; out[2] = d2[nd / 2]; out[3] = g->count;
  tess::wide_grid_drop(g);
  std::free(d); std::free(d2); std::free(sixr); std::free(buf);
  return 0;
}
`;

/** This package's sources with the VERIFY export, built to the scratch directory. */
function verifyBuild() {
  const tree = path.join(scratch, 'verify'), copy = path.join(tree, 'propagator/sdn-ap');
  fs.rmSync(tree, {recursive: true, force: true});
  fs.cpSync(packageRoot, copy, {recursive: true, filter: (p) => !/\/(node_modules|test|dist|\.build)(\/|$)/.test(p.slice(packageRoot.length))});
  const abi = path.join(copy, 'src/abi.inc'), text = fs.readFileSync(abi, 'utf8'), anchor = 'SDNAP_EXPORT("sdnap_frame_probe")';
  assert.equal(text.split(anchor).length, 2, 'abi.inc export anchor');
  fs.writeFileSync(abi, text.replace(anchor, VERIFY + '\n' + anchor));
  fs.symlinkSync(path.join(packageRoot, 'node_modules'), path.join(copy, 'node_modules'));
  fs.symlinkSync(path.join(modules, 'foundation'), path.join(tree, 'foundation'));
  try {
    execFileSync(process.execPath, ['build.mjs'], {cwd: copy, stdio: 'ignore', env: {...process.env, SPACE_DATA_NETWORK_MODULES_ROOT: modules, SDNAP_DIST_DIR: path.join(tree, 'dist')}});
  } finally {
    fs.unlinkSync(path.join(copy, 'node_modules'));
    fs.unlinkSync(path.join(tree, 'foundation'));
  }
  return path.join(tree, 'dist/isomorphic/module.wasm');
}

// 1. the grid against the full-field quadrature (the AP (31, 20) vacuum fits' mean elements, experiments results/ap-truth/themis-ripple-fix/correctness/elements.json)
const WINDOWS = {
  'THEMIS D 2013-02-12': [1.0499037196959449, 0.8221736866449335, 8.132697128525981, 47.85625519596603, 68.66350938631257, 41.75807242078289, 23051.000694],
  'THEMIS E 2013-02-16': [1.049629485877949, 0.821468804683023, 8.169356618221114, 62.29116896052435, 56.74548178908685, 74.20597157594973, 23055.000694],
  // the GTO fixture of gto-high-degree-perigee-terms.e2e.mjs, both arguments of perigee
  'GTO fixture, omega 270': [2.40, 0.72, 27, 40, 270, 10, 23051.000694],
  'GTO fixture, omega 300': [2.40, 0.72, 27, 40, 300, 10, 23051.000694],
};
const verify = await createStandaloneHarness('browser', verifyBuild(), {surface: 'direct'});
const x = verify.instance.exports, pin = x.sdnap_alloc(64), pout = x.sdnap_alloc(64);
const quadrature = {};
for (const [name, elements] of Object.entries(WINDOWS)) {
  new Float64Array(verify.memory.buffer, pin, 7).set(elements);
  assert.equal(x.sdnap_test_ripple_verify(pin, pout), 0, `${name}: verify`);
  const [rmsM, maxM, roughM, families] = Array.from(new Float64Array(verify.memory.buffer, pout, 4));
  quadrature[name] = {rmsM, maxM, roughM, families};
  console.log(JSON.stringify({window: name, ...quadrature[name]}));
}
x.sdnap_free(pin);
x.sdnap_free(pout);
await verify.close?.();

// 2. no harm at e 0.3 and below: BASE's dist by git show, SHA-256 checked
const basePath = path.join(scratch, `sdn-ap-${BASE}.wasm`);
const baseBytes = execFileSync('git', ['-C', modules, 'show', `${BASE}:propagator/sdn-ap/dist/isomorphic/module.wasm`], {maxBuffer: 1 << 26});
assert.equal(crypto.createHash('sha256').update(baseBytes).digest('hex'), BASE_SHA256, `${BASE_VERSION} dist`);
fs.writeFileSync(basePath, baseBytes);
const AP = {tesseral: 31, zonal: 20};
const SEEDS = {
  'LEO, AP': {n: 15.07, e: 0.0008, i: 51.6, raan: 40, argp: 30, ma: 10, ...AP},
  'LEO, SGP4XP': {n: 15.07, e: 0.0008, i: 51.6, raan: 40, argp: 30, ma: 10},
  'geostationary, AP': {n: 1.0027, e: 0.0002, i: 0.05, raan: 40, argp: 30, ma: 10, ...AP},
  'Etalon-like, AP': {n: 2.13, e: 0.0007, i: 64.9, raan: 40, argp: 30, ma: 10, ...AP},
  'GPS-like, AP': {n: 2.0056, e: 0.01, i: 55, raan: 40, argp: 30, ma: 10, ...AP},
  'e 0.25, AP': {n: 2.4, e: 0.25, i: 27, raan: 40, argp: 270, ma: 10, ...AP},
  'e 0.3, AP': {n: 2.4, e: 0.3, i: 27, raan: 40, argp: 270, ma: 10, ...AP},
};
const epoch = '2026-10-01T00:00:00.000';
const output = {START_TIME: epoch, STOP_TIME: '2026-10-03T00:00:00.000', STEP_SECONDS: 600};
// this build's $OEM with PRODUCER's version read as BASE's (the version string is the one difference a release step makes)
const now = JSON.parse(fs.readFileSync(path.join(packageRoot, 'plugin-manifest.json'), 'utf8')).version;
const producer = (v) => Buffer.from(`com.spacedatanetwork.sdn-ap-propagator ${v}`);
const asBase = (bytes) => {
  const b = Buffer.from(bytes);
  for (let at = b.indexOf(producer(now)); at >= 0; at = b.indexOf(producer(now), at + 1)) producer(BASE_VERSION).copy(b, at);
  return b;
};
const fly = async (file, payload) => {
  const h = await createStandaloneHarness('browser', file, {surface: 'direct'});
  const r = await h.invoke({methodId: 'propagate', inputs: flight([payload], {output})});
  await h.close?.();
  assert.equal(r.statusCode, 0, `${path.basename(file)}: ${r.errorCode} ${r.errorMessage}`);
  const bytes = new Uint8Array(r.outputs.find((o) => o.portId === 'ephemeris').payload);
  return file === basePath ? Buffer.from(bytes) : asBase(bytes);
};
const noHarm = {};
const compare = (name, a, b) => {
  const d = oemDistance(a, b);
  noHarm[name] = d;
  console.log(JSON.stringify({seed: name, identical: d.bytesEqual, positionMm: 1000 * d.posM, velocityUmS: 1000 * d.velMmS, covarianceOfLargest: d.covOfLargest}));
};
for (const [name, s] of Object.entries(SEEDS)) {
  const payload = seedOcm({epoch, ...s});
  compare(name, await fly(wasmPath, payload), await fly(basePath, payload));
}
// a fitted AP set (analysis/catalog-composer's fixture, LEO), flown on the same output grid
{
  const payload = new Uint8Array(fs.readFileSync(path.join(modules, 'analysis/catalog-composer/tests/fixtures/ap-fit-sdn-ap-0.5.1.ocm')));
  compare('fitted AP set (catalog-composer fixture)', await fly(wasmPath, payload), await fly(basePath, payload));
}

// 4. grid retention leaves no trace (exact keys; a fit's grids freed under tess::FitGridScope): in one instance a fit
//    that succeeds and a fit that is refused, then a flight above e 0.3, give the flight's bytes of a fresh instance
const {runModelTruth} = await import('./lib/heo-model-truth.mjs');
const gto = {n: 2.40, e: 0.72, i: 27, raan: 40, argp: 270, ma: 10};
const fitFrames = await runModelTruth({name: 'GTO', ...gto, drag: false, hourly: true, fitInput: true, modulePath: wasmPath});
const gtoSet = seedOcm({epoch, ...gto, ...AP});
const flightBytes = async (h) => {
  const r = await h.invoke({methodId: 'propagate', inputs: flight([gtoSet], {output})});
  assert.equal(r.statusCode, 0, `GTO flight: ${r.errorCode}`);
  return crypto.createHash('sha256').update(new Uint8Array(r.outputs.find((o) => o.portId === 'ephemeris').payload)).digest('hex');
};
// the cache's grids and their bytes (sdnap_wide_grid_cache; out[2], the builds so far, is not compared)
const cacheOf = (h) => {
  const x = h.instance.exports, p = x.sdnap_alloc(24);
  x.sdnap_wide_grid_cache(p);
  const v = Array.from(new Float64Array(h.memory.buffer, p, 2));
  x.sdnap_free(p);
  return v;
};
const fitOf = (h) => h.invoke({methodId: 'fit', inputs: [fitFrames.ephemeris, fitFrames.configuration, fitFrames.spaceWeather]});
const refuseOf = (h) => h.invoke({methodId: 'fit', inputs: [{...fitFrames.ephemeris, payload: new Uint8Array(32)}, fitFrames.configuration]});
const fresh = await createStandaloneHarness('browser', wasmPath, {surface: 'direct'});
const alone = await flightBytes(fresh);
const freshCache = cacheOf(fresh);
await fresh.close?.();
// order 1: fit, refused fit, flight
const shared = await createStandaloneHarness('browser', wasmPath, {surface: 'direct'});
const fitted = await fitOf(shared);
const highWater = shared.memory.buffer.byteLength;
const refused = await refuseOf(shared);
const after = await flightBytes(shared);
const afterCache = cacheOf(shared);
await shared.close?.();
// order 2: flight, fit, refused fit, flight
const other = await createStandaloneHarness('browser', wasmPath, {surface: 'direct'});
const before2 = await flightBytes(other);
await fitOf(other);
await refuseOf(other);
const after2 = await flightBytes(other);
await other.close?.();
console.log(JSON.stringify({switchTrace: {fitStatus: fitted.statusCode, refusedStatus: refused.statusCode, identical: after === alone, secondOrder: before2 === alone && after2 === alone,
  freshCache, afterCache, fitHighWaterMB: +(highWater / 1048576).toFixed(1)}}));
assert.equal(fitted.statusCode, 0, 'the fit succeeds');
assert.notEqual(refused.statusCode, 0, 'the second fit is refused');
assert.equal(after, alone, 'a flight after a fit and a refused fit equals a fresh instance\'s');
assert.ok(before2 === alone && after2 === alone, 'flight, fit, refused fit, flight: both flights equal a fresh instance\'s');
assert.deepEqual(afterCache, freshCache, 'the cache after fit-then-flight holds what a fresh instance holds after the flight');
assert.ok(highWater <= 160 * 1048576, `a GTO fit's linear-memory high-water ${highWater} bytes within 160 MiB`);

// 3. the 12 THEMIS windows (registration (b) to (d), Amendment 8's paired test): each window's roughness and day 1 / 3 / 7 3D RMS on
//    the base (sdn-ap 0.6.1, dist 05dd4a66) and on this source's build (a7771b14), as recorded in orbit-accuracy-experiments
//    results/ap-truth/themis-ripple-fix/investigation.json, arm L (rows: operator-theory/themis-ripple-fix/fit-investigation).
const THEMIS = [
  // window, roughness (m), base day 1 / 3 / 7, build day 1 / 3 / 7 (m)
  ['THEMIS A 2013-02-11', 0.2452, 377.0, 1217.7, 2661.9, 379.9, 1234.0, 2665.1],
  ['THEMIS A 2013-02-13', 0.0887, 123.5, 311.2, 990.2, 113.7, 298.0, 961.8],
  ['THEMIS A 2013-02-15', 0.0631, 211.7, 314.1, 419.9, 201.1, 294.3, 421.8],
  ['THEMIS A 2013-02-17', 0.0391, 148.7, 276.7, 914.2, 138.2, 273.9, 910.7],
  ['THEMIS D 2013-02-11', 0.0975, 282.6, 713.9, 864.1, 273.1, 707.0, 886.0],
  ['THEMIS D 2013-02-13', 0.0518, 234.4, 605.1, 1019.1, 224.4, 587.5, 962.3],
  ['THEMIS D 2013-02-15', 0.0589, 178.5, 411.6, 696.6, 168.7, 419.4, 720.6],
  ['THEMIS D 2013-02-17', 0.0779, 164.0, 363.8, 1154.0, 149.1, 366.3, 1203.8],
  ['THEMIS E 2013-02-11', 0.1055, 230.2, 788.6, 1184.7, 220.5, 772.5, 1155.5],
  ['THEMIS E 2013-02-13', 0.0714, 236.2, 709.7, 1385.3, 232.2, 720.3, 1377.2],
  ['THEMIS E 2013-02-15', 0.0590, 148.6, 398.6, 767.3, 135.1, 404.3, 813.4],
  ['THEMIS E 2013-02-17', 0.0531, 155.4, 342.6, 1052.6, 131.7, 312.4, 1004.3],
];
const median = (v) => { const s = [...v].sort((a, b) => a - b), k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
/** The registration's window-cluster bootstrap: 10,000 draws, seed 20261106, 95 % percentile interval of the median. */
function interval(v) {
  let s = 20261106 >>> 0;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const m = [];
  for (let b = 0; b < 10000; b += 1) m.push(median(v.map(() => v[Math.floor(rnd() * v.length)])));
  m.sort((a, b) => a - b);
  return [m[250], m[9750]];
}
const paired = Object.fromEntries([1, 2, 3].map((d, k) => {
  const ratios = THEMIS.map((w) => w[5 + k] / w[2 + k]);
  return [[1, 3, 7][k], {median: median(ratios), interval: interval(ratios)}];
}));
const roughness = median(THEMIS.map((w) => w[1]));
console.log(JSON.stringify({windows: THEMIS.length, roughnessM: roughness, paired}));

assert.ok(roughness < 0.2, `THEMIS roughness ${roughness} m over 12 windows`);
for (const [day, p] of Object.entries(paired)) assert.ok(p.interval[1] <= 1.05, `day ${day}: paired upper bound ${p.interval[1]}`);
for (const [name, q] of Object.entries(quadrature)) {
  assert.ok(q.rmsM <= 1, `${name}: ${q.rmsM} m RMS against the quadrature`);
  assert.ok(q.maxM <= 5, `${name}: ${q.maxM} m at most`);
  assert.ok(q.roughM <= 0.1, `${name}: ${q.roughM} m second difference`);
}
for (const [name, d] of Object.entries(noHarm)) {
  if (/SGP4XP/.test(name)) assert.ok(d.bytesEqual, `${name}: byte-identical to ${BASE_VERSION}`);
  else assert.ok(d.posM <= NO_HARM.posM && d.velMmS <= NO_HARM.velMmS && d.covOfLargest <= NO_HARM.covOfLargest, `${name}: ${JSON.stringify(d)} from ${BASE_VERSION} (within ${JSON.stringify(NO_HARM)})`);
}
fs.rmSync(scratch, {recursive: true, force: true});
console.log('THEMIS ripple E2E: PASS');

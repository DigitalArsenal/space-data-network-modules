#!/usr/bin/env node
// SPEC 16.3, DigitalArsenal/spacedatanetwork-stack#451: the first-order short-period terms of J3 to J5, closed form in the
// true anomaly, exact in the eccentricity (src/zonal_short_period.inc).
// The outcome: against two-body plus J3 to J5 integrated over one orbit, the terms agree to within 1 cm per coordinate, at e
// 0.001 (690 km, i 50 deg) and at e 0.83 (a THEMIS-like orbit, i 10 deg).
// - The integration is RK4 in Cartesian coordinates, 200,000 steps an orbit, in a test build's export (C++; no orbital
//   dynamics in JavaScript).
// - It starts from the osculating state of mean + terms(M0).
// - It is compared with mean(t) + terms(M(t)), the mean elements drifting at the same closed form's first-order rates of <R>.
//   Nothing is fitted.
// - Measured: 0.068 and 0.133 mm RMS, at most 0.165 and 0.632 mm. Without the terms (the same drift, from mean = osculating)
//   the same comparison is 20.5 and 24.7 m RMS (43.0 and 53.5 m at most).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {scratchTemp} from './lib/scratch.mjs';

const VERIFY = String.raw`
namespace zsp_verify {
using namespace sdnap;
using namespace sdnap::xpt;
struct Kep { double a, e, i, O, w, M; };
inline Kep kep_of(const double* y) {
  Kep k;
  k.a = std::cbrt(kMu / (y[kN] * y[kN]));
  k.e = std::hypot(y[kAf], y[kAg]);
  const double vp = std::atan2(y[kAg], y[kAf]);
  k.O = std::atan2(y[kChi], y[kPsi]);
  k.i = 2.0 * std::atan(std::hypot(y[kChi], y[kPsi]));
  k.w = vp - k.O;
  k.M = y[kLam] - vp;
  return k;
}
inline void state_of(const Kep& k, double* r, double* v) {
  double E = k.M + k.e * std::sin(k.M);
  for (int it = 0; it < 60; ++it) { const double d = (E - k.e * std::sin(E) - k.M) / (1 - k.e * std::cos(E)); E -= d; if (std::fabs(d) < 1e-15) break; }
  const double eta = std::sqrt(1 - k.e * k.e), n = std::sqrt(kMu / (k.a * k.a * k.a)), rr = k.a * (1 - k.e * std::cos(E));
  const double xp = k.a * (std::cos(E) - k.e), yp = k.a * eta * std::sin(E);
  const double vxp = -k.a * n * std::sin(E) * k.a / rr, vyp = k.a * n * eta * std::cos(E) * k.a / rr;
  const double cO = std::cos(k.O), sO = std::sin(k.O), cw = std::cos(k.w), sw = std::sin(k.w), ci = std::cos(k.i), si = std::sin(k.i);
  const double P[3] = {cw * cO - sw * sO * ci, cw * sO + sw * cO * ci, sw * si};
  const double Q[3] = {-sw * cO - cw * sO * ci, -sw * sO + cw * cO * ci, cw * si};
  for (int j = 0; j < 3; ++j) { r[j] = xp * P[j] + yp * Q[j]; v[j] = vxp * P[j] + vyp * Q[j]; }
}
inline void accel(const double* r, double* acc) {
  const double rr = std::sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2]), s = r[2] / rr;
  for (int j = 0; j < 3; ++j) acc[j] = -kMu * r[j] / (rr * rr * rr);
  for (int l = 3; l <= 5; ++l) {
    double P0 = 1, P1 = s;
    for (int n = 1; n < l; ++n) { const double P2 = ((2 * n + 1) * s * P1 - n * P0) / (n + 1); P0 = P1; P1 = P2; }
    const double dP = l * (s * P1 - P0) / (s * s - 1);
    const double c = kMu * zsp::kJ[l] * std::pow(rr, -(l + 2)), fr = c * ((l + 1) * P1 + s * dP);
    for (int j = 0; j < 3; ++j) acc[j] += fr * r[j] / rr;
    acc[2] -= c * dP;
  }
}
}  // namespace zsp_verify
// in: n (rad/min), e, i, Omega, omega, M0 (rad), terms on (1) or off (0, the mean drift kept); out: RMS and maximum per
// coordinate (Earth radii)
SDNAP_EXPORT("sdnap_test_zsp_verify")
int32_t sdnap_test_zsp_verify(const double* in, double* out) {
  using namespace zsp_verify;
  const double n = in[0], e = in[1], inc = in[2], O = in[3], w = in[4], M0 = in[5];
  const bool on = in[6] != 0.0;
  const double y0[6] = {e * std::cos(w + O), e * std::sin(w + O), std::tan(inc / 2) * std::sin(O), std::tan(inc / 2) * std::cos(O), M0 + w + O, n};
  double d[6], rate[6];
  zsp::of_equinoctial(y0, 5, d, rate);
  if (!on) for (int j = 0; j < 6; ++j) d[j] = 0.0;  // without the terms: the same drift, no periodic part
  double yo[6];
  for (int j = 0; j < 6; ++j) yo[j] = y0[j] + d[j];
  double r[3], v[3];
  state_of(kep_of(yo), r, v);
  const int steps = 200000, every = 500;
  const double h = 2.0 * 3.14159265358979323846 / n / steps;
  double sum = 0.0, mx = 0.0;
  int count = 0;
  for (int s = 1; s <= steps; ++s) {
    double k1r[3], k1v[3], k2r[3], k2v[3], k3r[3], k3v[3], k4r[3], k4v[3], tr[3], tv[3], a[3];
    accel(r, a); for (int j = 0; j < 3; ++j) { k1r[j] = v[j]; k1v[j] = a[j]; tr[j] = r[j] + 0.5 * h * k1r[j]; tv[j] = v[j] + 0.5 * h * k1v[j]; }
    accel(tr, a); for (int j = 0; j < 3; ++j) { k2r[j] = tv[j]; k2v[j] = a[j]; tr[j] = r[j] + 0.5 * h * k2r[j]; tv[j] = v[j] + 0.5 * h * k2v[j]; }
    accel(tr, a); for (int j = 0; j < 3; ++j) { k3r[j] = tv[j]; k3v[j] = a[j]; tr[j] = r[j] + h * k3r[j]; tv[j] = v[j] + h * k3v[j]; }
    accel(tr, a); for (int j = 0; j < 3; ++j) { k4r[j] = tv[j]; k4v[j] = a[j]; }
    for (int j = 0; j < 3; ++j) { r[j] += h / 6 * (k1r[j] + 2 * k2r[j] + 2 * k3r[j] + k4r[j]); v[j] += h / 6 * (k1v[j] + 2 * k2v[j] + 2 * k3v[j] + k4v[j]); }
    if (s % every != 0) continue;
    const double t = s * h;
    double y[6];
    for (int j = 0; j < 6; ++j) y[j] = y0[j] + rate[j] * t;
    y[kLam] += n * t;
    double dd[6];
    zsp::of_equinoctial(y, 5, dd);
    if (!on) for (int j = 0; j < 6; ++j) dd[j] = 0.0;
    for (int j = 0; j < 6; ++j) y[j] += dd[j];
    double rp[3], vp[3];
    state_of(kep_of(y), rp, vp);
    for (int j = 0; j < 3; ++j) { const double q = rp[j] - r[j]; sum += q * q; mx = std::fmax(mx, std::fabs(q)); ++count; }
  }
  out[0] = std::sqrt(sum / count);
  out[1] = mx;
  return 0;
}
`;

const modules = fileURLToPath(new URL('../../../', import.meta.url)), packageRoot = path.join(modules, 'propagator/sdn-ap');
function verifyBuild() {
  const tree = scratchTemp('sdn-ap-zsp-verify-'), copy = path.join(tree, 'propagator/sdn-ap');
  fs.cpSync(packageRoot, copy, {recursive: true, filter: (p) => !/\/(node_modules|test|dist|\.build)(\/|$)/.test(p.slice(packageRoot.length))});
  const abi = path.join(copy, 'src/abi.inc'), text = fs.readFileSync(abi, 'utf8'), anchor = 'SDNAP_EXPORT("sdnap_frame_probe")';
  assert.equal(text.split(anchor).length, 2, 'abi.inc export anchor');
  fs.writeFileSync(abi, text.replace(anchor, VERIFY + '\n' + anchor));
  fs.symlinkSync(path.join(packageRoot, 'node_modules'), path.join(copy, 'node_modules'));
  fs.symlinkSync(path.join(modules, 'foundation'), path.join(tree, 'foundation'));
  const env = {...process.env, SDM_MODULE_UNSIGNED_BUILD: '1', SPACE_DATA_NETWORK_MODULES_ROOT: modules, SDNAP_DIST_DIR: path.join(tree, 'dist')};
  delete env.SDM_MODULE_SIGNING_KEYPAIR_PATH;
  try {
    execFileSync(process.execPath, ['build.mjs'], {cwd: copy, stdio: 'ignore', env});
  } finally {
    fs.unlinkSync(path.join(copy, 'node_modules'));
    fs.unlinkSync(path.join(tree, 'foundation'));
  }
  return path.join(tree, 'dist/isomorphic/module.wasm');
}

const RE_M = 6378136.3, DEG = Math.PI / 180;
const MU = 0.074366859954178854 ** 2;  // Earth radii^3 / min^2 (SPEC 1.3)
const nOf = (aRe) => Math.sqrt(MU / aRe ** 3);
const CASES = {
  'e 0.001, 690 km, i 50': {n: nOf((6378.1363 + 690) / 6378.1363 / (1 - 0.001)), e: 0.001, i: 50},
  'e 0.83, THEMIS-like, i 10': {n: 1.0496 * 2 * Math.PI / 1440, e: 0.83, i: 10},
};
const h = await createStandaloneHarness('browser', verifyBuild(), {surface: 'direct'});
const x = h.instance.exports, pin = x.sdnap_alloc(64), pout = x.sdnap_alloc(16);
const rows = {};
for (const [name, c] of Object.entries(CASES)) {
  const run = (on) => {
    new Float64Array(h.memory.buffer, pin, 7).set([c.n, c.e, c.i * DEG, 0.7, 1.1, 0.3, on ? 1 : 0]);
    assert.equal(x.sdnap_test_zsp_verify(pin, pout), 0, `${name}: verify`);
    const [rms, max] = Array.from(new Float64Array(h.memory.buffer, pout, 2));
    return {rmsMm: +(rms * RE_M * 1000).toFixed(3), maxMm: +(max * RE_M * 1000).toFixed(3)};
  };
  rows[name] = {withTerms: run(true), withoutTerms: run(false)};
  console.log(JSON.stringify({case: name, ...rows[name]}));
}
x.sdnap_free(pin);
x.sdnap_free(pout);
await h.close?.();
for (const [name, r] of Object.entries(rows))
  assert.ok(r.withTerms.maxMm < 10, `${name}: the terms against the integration, at most ${r.withTerms.maxMm} mm per coordinate (bound 10 mm)`);
console.log('Zonal short-period E2E: PASS');
process.exit(0);

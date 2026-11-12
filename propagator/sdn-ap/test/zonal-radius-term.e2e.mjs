#!/usr/bin/env node
// E2E (SPEC 16.23, stack #503, #532): AP's output carries the zonal theory's constant radial term.
// Model truth (test/lib/synthetic-truth.mjs): FFM with the zonal field J2 to J5 alone (EGM2008 degree 5, order 0) and the
// Sun and Moon from DE440; AP with gravity terms (tesseral cap 0, zonal cap 5: J2 to J5 and its own Sun and Moon), fitted
// over 72 h and flown hourly for 7 days. Mean radial error (AP minus FFM, the reference's RTN) over days 1 to 5:
// - on this build, at most 0.5 m on the circular cases and 1.5 m at e 0.05;
// - on the circular cases, on 0.6.42 (git 86786933, its SHA-256 checked), the release before the term, within 0.5 m of the
//   closed form (R_E^4 / a^3) [J2^2 (199 c^4 - 80 c^2 + 25) / 32 - J4 (15/64)(35 s^4 - 40 s^2 + 8)] (at e 0.05 the offset
//   departs from that e = 0 form by 1.3 m, measured on 0.6.36, 0.6.39 and 0.6.42: stack #532);
// - this build's offset no larger in size than 0.6.42's by more than 0.3 m.
// Cases: circular at 420 km, i 87.5, 55 and 98 deg, and i 5 deg (near the equator, the largest); e 0.05 at a = R + 1,200 km,
// i 28.5 deg. Measured on 0.6.43: 0.18, -0.17, 0.16, -0.34 and -1.31 m (before the term 10.88, -2.43, 9.58, 42.37 and
// 11.12 m).
//   node test/zonal-radius-term.e2e.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {requireTruth} from './lib/ffm-truth.mjs';
requireTruth('ea4576901f9e8dc21af2c24feb7887645706ef934488cb9756a0b5c21ab47934'); // the model truth: FFM 2.3.0
import {runSyntheticTruth} from './lib/synthetic-truth.mjs';
import {scratchTemp} from './lib/scratch.mjs';

const MU = 398600.4415, RE = 6378.1363, J2 = 1.08262668355315e-3, J4 = -1.619621591367e-6;
const BASE = {version: '0.6.42', commit: '86786933e33415d306ac4eca8e7ab31939da6321', sha256: '3c389abfd8ce2ea1767f4d3040449e6ca9097f2edc31321d78cf6ca5f300e2df'};
const modules = fileURLToPath(new URL('../../../', import.meta.url));
const baseBytes = execFileSync('git', ['-C', modules, 'show', `${BASE.commit}:propagator/sdn-ap/dist/isomorphic/module.wasm`], {maxBuffer: 1 << 26});
assert.equal(createHash('sha256').update(baseBytes).digest('hex'), BASE.sha256, `${BASE.version} baseline sha256`);
const basePath = path.join(scratchTemp('sdn-ap-zonal-radius-'), `sdn-ap-${BASE.version}.wasm`);
fs.writeFileSync(basePath, baseBytes);

/** The closed form of SPEC 16.23, m: the offset the theory leaves without the term. */
const predicted = (aKm, iDeg) => {
  const c2 = Math.cos(iDeg * Math.PI / 180) ** 2, s2 = 1 - c2;
  return 1000 * RE ** 4 / aKm ** 3 * (J2 * J2 * (199 * c2 * c2 - 80 * c2 + 25) / 32 - J4 * 15 / 64 * (35 * s2 * s2 - 40 * s2 + 8));
};
const revPerDay = (aKm) => Math.sqrt(MU / aKm ** 3) * 86400 / (2 * Math.PI);
const CASES = [
  {name: '420 km, i 87.5', a: RE + 420, e: 0.0001, i: 87.5},
  {name: '420 km, i 55', a: RE + 420, e: 0.0001, i: 55},
  {name: '420 km, i 98', a: RE + 420, e: 0.0001, i: 98},
  {name: '420 km, i 5', a: RE + 420, e: 0.0001, i: 5},
  {name: 'a R + 1,200 km, e 0.05, i 28.5', a: RE + 1200, e: 0.05, i: 28.5},
];
const meanRadial = (r) => {
  const pr = r.profile.filter((q) => q.h > 24 && q.h <= 120);
  return pr.reduce((s, q) => s + q.r, 0) / pr.length;
};
const rows = [];
for (const c of CASES) {
  const kase = {name: c.name, n: revPerDay(c.a), e: c.e, i: c.i, raan: 40, argp: 30, ma: 10, drag: false,
    maxDegree: 5, maxOrder: 0, thirdBody: true, tesseral: 0, zonal: 5};
  const now = await runSyntheticTruth(kase), before = await runSyntheticTruth({...kase, modulePath: basePath});
  const row = {name: c.name, predictedM: predicted(c.a, c.i), beforeM: meanRadial(before), afterM: meanRadial(now)};
  rows.push(row);
  console.log(JSON.stringify(row));
}
for (const [k, r] of rows.entries()) {
  const circular = CASES[k].e < 0.01, bound = circular ? 0.5 : 1.5;
  assert.ok(Math.abs(r.afterM) <= bound, `${r.name}: mean radial ${r.afterM.toFixed(2)} m with the term (at most ${bound} m)`);
  if (circular) assert.ok(Math.abs(r.beforeM - r.predictedM) <= 0.5, `${r.name}: ${BASE.version}'s mean radial ${r.beforeM.toFixed(2)} m against the closed form's ${r.predictedM.toFixed(2)} m (within 0.5 m)`);
  assert.ok(Math.abs(r.afterM) <= Math.abs(r.beforeM) + 0.3, `${r.name}: ${r.afterM.toFixed(2)} m with the term against ${r.beforeM.toFixed(2)} m without it`);
}
console.log('zonal radius term E2E: PASS');
process.exit(0);

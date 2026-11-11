#!/usr/bin/env node
// E2E (stack #453, SPEC 16, a known defect: test/known-defects.json): with J2 alone on both sides, AP's orbit sits 3 to 4.5 m off
// in radius in low orbit. The offset is constant at the orbit's own period, with a 2/rev radial term of up to 1.9 m on inclined
// orbits, so no fit absorbs it. AP's J2 short-period set is first order (SPEC 8); the reading is that the missing piece is the
// J2 short-period terms beyond first order, chiefly their constant radial part (not verified).
// Theory isolated by a test build of this package's sources with the Sun's and Moon's masses and J3, J4 and J5 at 0, FORCES 0,2
// (no tesseral terms, no zonal tail). Truth: test/lib/heo-model-truth.mjs (FFM 2.3.0, named below by its SHA-256): EGM96 2 x 0,
// no third bodies, no drag, no SRP, zero EOP, RK78 1e-12 and 300 s, from an osculating perigee state; a 72 h fit (30 min states,
// BTERM and AGOM pinned at 0), 7 days flown on a 1 h grid. Made-up near-circular orbits (e 0.001): 690 km at i 98, 800 km at i 50.
// Asserted: the day-1 whole-day radial RMS at most 1 m on both. Measured 2026-11-11 (the build of #448's candidate, 0.6.15's J2
// terms): 4.18 m and 4.12 m.
//   node test/j2-second-order-radial.e2e.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {requireTruth} from './lib/ffm-truth.mjs';
import {runModelTruth} from './lib/heo-model-truth.mjs';
import {scratchTemp} from './lib/scratch.mjs';
const FFM_SHA256 = 'ea4576901f9e8dc21af2c24feb7887645706ef934488cb9756a0b5c21ab47934';
requireTruth(FFM_SHA256);
const modules = fileURLToPath(new URL('../../../', import.meta.url)), packageRoot = path.join(modules, 'propagator/sdn-ap');
// a scratch outside the package: the test build copies the package's sources, which cannot hold their own destination
const scratch = scratchTemp('sdn-ap-j2-radial-');
const PATCHES = [
  ['xp_theory.inc', 'constexpr double kSunMass = 332946.038;', 'constexpr double kSunMass = 0.0;'],
  ['xp_theory.inc', 'constexpr double kMoonMass = 0.012300034;', 'constexpr double kMoonMass = 0.0;'],
  ['xp_theory.inc', 'constexpr double kJ3 = -2.53265648533224e-6;', 'constexpr double kJ3 = 0.0;'],
  ['xp_theory.inc', 'constexpr double kJ4 = -1.619621591367e-6;', 'constexpr double kJ4 = 0.0;'],
  ['xp_theory.inc', 'constexpr double kJ5 = -2.27296082868698e-7;', 'constexpr double kJ5 = 0.0;'],
];
const tree = path.join(scratch, 'j2-only'), copy = path.join(tree, 'propagator/sdn-ap');
fs.cpSync(packageRoot, copy, {recursive: true, filter: (p) => !/\/(node_modules|test|dist)(\/|$)/.test(p.slice(packageRoot.length))});
for (const [file, a, b] of PATCHES) {
  const source = path.join(copy, 'src', file), text = fs.readFileSync(source, 'utf8');
  assert.equal(text.split(a).length, 2, `${file}: ${a}`);
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
const modulePath = path.join(tree, 'dist/isomorphic/module.wasm');
const KE = 0.074366859954178854, RE = 6378.1363;
const nOf = (h) => KE * Math.pow(RE / (RE + h), 1.5) * 1440 / (2 * Math.PI);
const BOUND = 1;
// [name, altitude km, i deg, RAAN deg, measured 2026-11-11 (day-1 radial RMS, m)]
const CASES = [['690 km, i 98', 690, 98, 30, 4.18], ['800 km, i 50', 800, 50, 77, 4.12]];
const failures = [];
for (const [name, h, i, raan, measured] of CASES) {
  const r = await runModelTruth({name, n: nOf(h), e: 0.001, i, raan, argp: 90, ma: 0, drag: false, field: [2, 0], forces: [0, 2], thirdBody: false,
    fitDays: 3, hourly: true, gridMinutes: 60, modulePath});
  assert.equal(r.ffmSha256, FFM_SHA256, 'the truth flown by the named FFM build');
  const d1 = r.wholeDay[1];
  console.log(JSON.stringify({name, day1RadialMeters: +d1.r.toFixed(2), day1AlongMeters: +d1.t.toFixed(2), day1CrossMeters: +d1.n.toFixed(2), fitRmsMeters: +(r.fitted.wrms * 1000).toFixed(2), bound: BOUND, measured20261111: measured}));
  if (!(d1.r <= BOUND)) failures.push(`${name}: day-1 radial RMS ${d1.r.toFixed(2)} m above ${BOUND} m (J2 beyond first order, #453)`);
}
fs.rmSync(scratch, {recursive: true, force: true});
if (failures.length) {
  console.error(`FAIL\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('J2 second-order radial E2E: PASS');
process.exit(0);

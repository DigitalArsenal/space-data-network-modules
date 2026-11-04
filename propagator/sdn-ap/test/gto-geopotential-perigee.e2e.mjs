#!/usr/bin/env node
// Registration (2026-11-03, modules-sdn-ap-gto-geopotential-perigee-20261103): AP's half-day class (SPEC 16.10) steps
// at most a 32nd of the period of its resonant angle lambda - 2 theta instead of two revolutions. Baseline the 0.4.13
// release (git c938b91d8); a test build REFERENCE of this package steps the class at 23.75 min (converged: 11.875 min
// moves it by under 0.003 m in 7 days).
// Acceptance, FFM model truth as test/lib/heo-model-truth.mjs (EGM96 70x70, Sun and Moon from DE440; 72 h fits from an
// osculating perigee; 7 days flown hourly; day-7 whole-day RMS):
// 1. the GTO fixture (n 2.40 rev/day, e 0.72, i 27 deg; perigee 220 km): along-track and radial each at most 500 m,
//    0.4.13's values printed first (960.82 / 935.27 m);
// 2. the GTO-like fixture with a 500 km perigee (e 0.7081): along-track and radial no worse than 0.4.13's by more than
//    1 m;
// 3. the half-day, Molniya and 12 h at 55 deg fixtures: whole-day RMS and day-7 sample within 0.5 m of 0.4.13's;
// 4. the release against REFERENCE on seeded sets (FORCES 31,20) over one orbit: position RMS at most 0.1 m on both GTO
//    orbits, and at most 0.1 m over 7 days on Galileo-, BeiDou- and Etalon-like orbits;
// 5. default-FORCES XP digest bit-exact.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import * as fb from 'flatbuffers';
import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {OEM, OEMT} from 'spacedatastandards.org/lib/js/OEM/OEM.js';
import {OMM, OMMT} from 'spacedatastandards.org/lib/js/OMM/OMM.js';
import {OMMUserDefinedParameterT} from 'spacedatastandards.org/lib/js/OMM/OMMUserDefinedParameter.js';
import {CATT} from 'spacedatastandards.org/lib/js/OEM/CAT.js';
import {ephemerisDataBlockT as Block} from 'spacedatastandards.org/lib/js/OEM/ephemerisDataBlock.js';
import {ephemerisDataLineT as Line} from 'spacedatastandards.org/lib/js/OEM/ephemerisDataLine.js';
import {timingStandard} from 'spacedatastandards.org/lib/js/OEM/timingStandard.js';
import {pcfOutputFrame} from 'spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js';
import {runModelTruth} from './lib/heo-model-truth.mjs';
import {seedOcm, flight} from './lib/ocm.mjs';
import {wasmPath} from './lib/module.mjs';
import {packOem, rfm} from './lib/frames.mjs';
import {configuration} from './lib/pcf.mjs';

const BASE = 'c938b91d8', scratch = '/Users/tj/software/terrain-work/body-look/codex-apfix-d9/gto-step';
const modules = fileURLToPath(new URL('../../../', import.meta.url)), packageRoot = path.join(modules, 'propagator/sdn-ap');
fs.mkdirSync(scratch, {recursive: true});
const baseline = path.join(scratch, `release-${BASE}.wasm`);
fs.writeFileSync(baseline, execFileSync('git', ['-C', modules, 'show', `${BASE}:propagator/sdn-ap/dist/isomorphic/module.wasm`], {maxBuffer: 1 << 26}));
// 1-3 measure the 0.4.14 release (git 8fdf5b1af), the build this registration is about: 0.4.15 (SPEC 16.11) moves the
// eccentric fixtures, test/gto-high-degree-perigee-terms.e2e.mjs.
const release = path.join(scratch, 'release-8fdf5b1af.wasm');
fs.writeFileSync(release, execFileSync('git', ['-C', modules, 'show', '8fdf5b1af:propagator/sdn-ap/dist/isomorphic/module.wasm'], {maxBuffer: 1 << 26}));
const reference = (() => {
  const tree = path.join(scratch, 'reference'), copy = path.join(tree, 'propagator/sdn-ap');
  fs.rmSync(tree, {recursive: true, force: true});
  fs.cpSync(packageRoot, copy, {recursive: true, filter: (p) => !/\/(node_modules|test|dist)(\/|$)/.test(p.slice(packageRoot.length))});
  const source = path.join(copy, 'src/xp_theory.inc'), text = fs.readFileSync(source, 'utf8');
  const a = '  return slip > 0.0 ? std::fmin(two_revolutions, kTwoPi / slip / 32.0) : two_revolutions;';
  assert.equal(text.split(a).length, 2, 'the step rule');
  fs.writeFileSync(source, text.replace(a, '  (void)slip;\n  return std::fmin(two_revolutions, 23.75);'));
  fs.symlinkSync(path.join(packageRoot, 'node_modules'), path.join(copy, 'node_modules'));
  fs.symlinkSync(path.join(modules, 'foundation'), path.join(tree, 'foundation'));
  try {
    execFileSync(process.execPath, ['build.mjs'], {cwd: copy, stdio: 'ignore', env: {...process.env, SPACE_DATA_NETWORK_MODULES_ROOT: modules, SDNAP_DIST_DIR: path.join(tree, 'dist')}});
  } finally {
    fs.unlinkSync(path.join(copy, 'node_modules'));
    fs.unlinkSync(path.join(tree, 'foundation'));
  }
  return path.join(tree, 'dist/isomorphic/module.wasm');
})();

// 1-3: the fixtures on 0.4.13 and on this build
const FIXTURES = {
  GTO: {name: 'GTO', n: 2.40, e: 0.72, i: 27, raan: 40, argp: 270, ma: 10, drag: false},
  'GTO-500': {name: 'GTO-500', n: 2.40, e: 0.7081, i: 27, raan: 40, argp: 270, ma: 10, drag: false},
  'half-day': {name: 'half-day-critical', n: 2.0059, e: 0.72, i: 63.4, raan: 300, argp: 270, ma: 10, drag: false},
  Molniya: {name: 'Molniya', n: 2, e: 0.74, i: 63.4, raan: 300, argp: 270, ma: 10, drag: true},
  '12-hour-55deg': {name: '12-hour-55deg', n: 2, e: 0.72, i: 55, raan: 300, argp: 270, ma: 10, drag: false},
};
const fixtures = {};
for (const [name, c] of Object.entries(FIXTURES)) {
  fixtures[name] = {};
  for (const [arm, modulePath] of [['0.4.13', baseline], ['release', release]]) {
    const r = await runModelTruth({...c, hourly: true, modulePath});
    fixtures[name][arm] = {alongTrack: r.wholeDay[7].t, radial: r.wholeDay[7].r, crossTrack: r.wholeDay[7].n, singleSample: r.days[7].e};
  }
  console.log(JSON.stringify({fixture: name, ...fixtures[name]}));
}

// 4: the release against REFERENCE on seeded sets
const epoch = '2026-10-29T00:00:00.000', t0 = Date.parse(epoch + 'Z');
const type = (n) => ({schemaName: n + '.fbs', fileIdentifier: '$' + n, rootTypeName: n});
const iso = (ms) => new Date(ms).toISOString().replace('Z', '');
const hosts = [await createStandaloneHarness('browser', wasmPath, {surface: 'command'}), await createStandaloneHarness('browser', reference, {surface: 'command'})];
const ORBITS = {'GTO': [2.40, 0.72, 27, 'orbit'], 'GTO-500': [2.40, 0.7081, 27, 'orbit'], 'Galileo-like': [1.7047, 0.0002, 56, 'week'], 'BeiDou-like': [1.8613, 0.0005, 55, 'week'], 'Etalon-like': [2.1318, 0.0007, 64.9, 'week']};
const integration = {};
for (const [name, [n, e, i, span]] of Object.entries(ORBITS)) {
  const minutes = span === 'orbit' ? 1440 / n : 7 * 1440, lines = [];
  for (let t = 0; t <= minutes; t += 2) lines.push(Object.assign(new Line(), {EPOCH: iso(t0 + t * 60000)}));
  // the seeded AP set (caps 31 and 20 on the theory's flux model), alone, at the lines' epochs in GCRF
  const omm = seedOcm({epoch, n, e, i, raan: 40, argp: 270, ma: 10, norad: 99001, name: 'STEP', tesseral: 31, zonal: 20});
  const eph = [];
  for (const h of hosts) {
    const r = await h.invoke({methodId: 'propagate', inputs: flight([omm], {output: {EPOCHS: lines.map((l) => l.EPOCH), FRAME: pcfOutputFrame.GCRF}})});
    assert.equal(r.statusCode, 0, `${r.errorCode}: ${r.errorMessage}`);
    eph.push(OEM.getRootAsOEM(new fb.ByteBuffer(r.outputs.find((v) => v.portId === 'ephemeris').payload)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES);
  }
  let ss = 0, max = 0;
  for (let k = 0; k < eph[0].length; ++k) { const d = 1000 * Math.hypot(eph[0][k].X - eph[1][k].X, eph[0][k].Y - eph[1][k].Y, eph[0][k].Z - eph[1][k].Z); ss += d * d; max = Math.max(max, d); }
  integration[name] = {span, rmsMeters: Math.sqrt(ss / eph[0].length), maxMeters: max};
  console.log(JSON.stringify({againstReference: name, ...integration[name]}));
}
for (const h of hosts) await h.close?.();

assert.ok(fixtures.GTO.release.alongTrack <= 500 && fixtures.GTO.release.radial <= 500, `GTO day 7: ${fixtures.GTO.release.alongTrack} / ${fixtures.GTO.release.radial} m`);
for (const k of ['alongTrack', 'radial']) assert.ok(fixtures['GTO-500'].release[k] <= fixtures['GTO-500']['0.4.13'][k] + 1, `GTO-500 ${k}: no worse than 0.4.13 by more than 1 m`);
for (const name of ['half-day', 'Molniya', '12-hour-55deg'])
  for (const k of ['alongTrack', 'radial', 'crossTrack', 'singleSample'])
    assert.ok(Math.abs(fixtures[name].release[k] - fixtures[name]['0.4.13'][k]) <= 0.5, `${name} ${k}: within 0.5 m of 0.4.13`);
for (const [name, r] of Object.entries(integration)) assert.ok(r.rmsMeters <= 0.1, `${name}: ${r.rmsMeters} m RMS against the converged step over one ${r.span}`);
execFileSync(process.execPath, [new URL('./conformance.e2e.mjs', import.meta.url).pathname, '--reproduce', new URL('./results/conformance.json', import.meta.url).pathname],
  {stdio: 'inherit', env: {...process.env, SDN_AP_ORACLE_ROOT: process.env.SDN_AP_ORACLE_ROOT ?? '/Users/tj/software/spacedatanetwork-stack/repos/main-packages/space-data-network-closed-modules/packages/sgp4-xp-oracle'}});
console.log('GTO geopotential perigee E2E: PASS');

#!/usr/bin/env node
// SPEC 9 and 16.10, DigitalArsenal/spacedatanetwork-stack#445: above e0 0.3 the long-period regime's step resolves the
// perigee pass, h = min(h0, 0.5 (1 - e0)^(3/2) / n0).
// Fixture: a THEMIS-like orbit, n 1.0496 rev/day, e 0.822, perigee 900 km, i 10 deg. It is in the one-day class, period
// 1,372 min, and its step is 8.20 min against the one-day class's 38.
// 1. Convergence. The seeded set (FORCES 31,20, B 0.01, AGOM 0.0125 m^2/kg) flown 7 days at 300 s by the module and by a
//    test build at half its step. Outcome: their day-5 RMS difference is within 0.5 m.
//    Against a 2.375-minute step, day 5: 0.08 m at the rule's step, 0.33 m at 12.67 min, 8.99 m at 19 min, 174.11 m at 38 min.
// 2. Model truth. FFM: EGM96 70 x 70, Sun and Moon from DE440, no drag or radiation pressure on either side. AP: a 72 h fit
//    with drag and AGOM pinned at 0, flown 7 days on a 10-minute grid. Outcome: the day-5 whole-day 3D RMS is within 200 m.
//    Measured 122.9 m; 918.6 m at 38 min (through 0.6.15). With the Sun and Moon off on both sides it is 120.9 m at either step.
import assert from 'node:assert/strict';
import {requireTruth} from './lib/ffm-truth.mjs';
requireTruth('ea4576901f9e8dc21af2c24feb7887645706ef934488cb9756a0b5c21ab47934'); // the model truth: FFM 2.3.0 (modules 48a00fd6), 2.2.1's truth bit for bit
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import * as fb from 'flatbuffers';
import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {OEM} from 'spacedatastandards.org/lib/js/OEM/OEM.js';
import {pcfOutputFrame} from 'spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js';
import {wasmPath} from './lib/module.mjs';
import {seedOcm, flight} from './lib/ocm.mjs';
import {scratchTemp} from './lib/scratch.mjs';
import {runModelTruth} from './lib/heo-model-truth.mjs';

const MU = 398600.8, RE = 6378.135, n = 1.0496;
const e = +(1 - (RE + 900) / Math.cbrt(MU / (n * 2 * Math.PI / 86400) ** 2)).toFixed(6);
const fixture = {n, e, i: 10, raan: 30, argp: 300};

// 1. the module against a test build at half its step (unsigned, in the test scratch)
const modules = fileURLToPath(new URL('../../../', import.meta.url)), packageRoot = path.join(modules, 'propagator/sdn-ap');
function halfStepBuild() {
  const tree = scratchTemp('sdn-ap-half-step-'), copy = path.join(tree, 'propagator/sdn-ap');
  fs.cpSync(packageRoot, copy, {recursive: true, filter: (p) => !/\/(node_modules|test|dist|\.build)(\/|$)/.test(p.slice(packageRoot.length))});
  const file = path.join(copy, 'src/xp_theory.inc'), text = fs.readFileSync(file, 'utf8');
  const anchor = 'inline double long_period_step(const RateContext& ctx) { return ctx.branch.lp_step; }';
  assert.equal(text.split(anchor).length, 2, 'xp_theory.inc: long_period_step');
  fs.writeFileSync(file, text.replace(anchor, anchor.replace('return ctx.branch.lp_step;', 'return 0.5 * ctx.branch.lp_step;')));
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
const epoch = '2026-10-29T00:00:00.000', t0 = Date.parse(epoch + 'Z');
const set = seedOcm({epoch, ...fixture, ma: 10, bterm: 0.01, agom: 0.0125, norad: 99001, tesseral: 31, zonal: 20});
const epochs = [...Array(7 * 288)].map((_, k) => new Date(t0 + (k + 1) * 300000).toISOString().replace('Z', ''));
const fly = async (file) => {
  const h = await createStandaloneHarness('browser', file, {surface: 'command'});
  const r = await h.invoke({methodId: 'propagate', inputs: flight([set], {output: {EPOCHS: epochs, FRAME: pcfOutputFrame.GCRF}})});
  await h.close?.();
  assert.equal(r.statusCode, 0, `${file}: ${r.errorCode} ${r.errorMessage}`);
  return OEM.getRootAsOEM(new fb.ByteBuffer(r.outputs.find((o) => o.portId === 'ephemeris').payload)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES;
};
const [full, half] = [await fly(wasmPath), await fly(halfStepBuild())];
const diff = full.map((a, k) => 1000 * Math.hypot(a.X - half[k].X, a.Y - half[k].Y, a.Z - half[k].Z));
const dayRms = (d) => Math.sqrt(diff.slice((d - 1) * 288, d * 288).reduce((s, x) => s + x * x, 0) / 288);
const convergence = Object.fromEntries([1, 3, 5, 7].map((d) => [d, +dayRms(d).toFixed(3)]));
console.log(JSON.stringify({convergenceRmsM: convergence, maxM: +Math.max(...diff).toFixed(3)}));
assert.ok(dayRms(5) <= 0.5, `the module against half its step, day 5: ${dayRms(5).toFixed(3)} m (bound 0.5 m)`);

// 2. FFM model truth
const r = await runModelTruth({name: 'THEMIS-like', ...fixture, ma: 0, drag: false, field: [70, 70], forces: [31, 20], hourly: true, gridMinutes: 10});
const days = Object.fromEntries(Object.entries(r.wholeDay).map(([d, v]) => [d, {e: +v.e.toFixed(1), r: +v.r.toFixed(1), t: +v.t.toFixed(1), n: +v.n.toFixed(1)}]));
console.log(JSON.stringify({fixture: {...fixture, perigeeKm: +r.perigeeKm.toFixed(1)}, fitWrmsM: +(r.fitted.wrms * 1000).toFixed(1), wholeDayM: days, apSha256: r.apSha256}));
assert.ok(r.wholeDay[5].e <= 200, `THEMIS-like model truth, day 5: ${r.wholeDay[5].e.toFixed(1)} m (bound 200 m; measured 122.9 m, 918.6 m at 38 min)`);
console.log('Long-period perigee step E2E: PASS');
process.exit(0);

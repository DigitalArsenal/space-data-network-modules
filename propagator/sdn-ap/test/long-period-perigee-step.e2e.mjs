#!/usr/bin/env node
// SPEC 9 and 16.10, DigitalArsenal/spacedatanetwork-stack#445 and #450: above e0 0.3 the long-period regime's nodes are even
// in the eccentric anomaly of the epoch orbit, t_k = (G(E0 + k dE) - G(E0)) / n0, G(E) = E - e0 sin E,
// dE = min(0.5 sqrt(1 - e0), 0.85 h0 n0), h0 38 min (the one-day class) or 95 min.
// 1. Integration error. A THEMIS-like set (n 1.0496 rev/day, e 0.822, perigee 900 km, i 10 deg; the one-day class, 42 nodes a
//    revolution) and a Chandra-like set (0.37795 rev/day, e 0.685, i 72; class 0, 46 nodes a revolution), FORCES 31,20,
//    flown 7 days at 300 s by the module and by a test build at a uniform fine step (2.375 and 11.875 min). Outcome: their
//    day-5 RMS difference is within 4 m (THEMIS-like; measured 2.60 m) and 15 m (Chandra-like; measured 9.99 m).
// 2. One grid. In a test build: a covariance's moved set (CovBankScope) and a fit iterate's moved set (BranchScope, the
//    iterate's branch) at elements moved from the nominal's fly exactly the nominal's node times over 400 nodes, and those
//    are the rule's t_k. Outcome: the moved sets' differences are 0, the rule's within 1e-9 min (rounding).
// 3. Model truth. FFM: EGM96 70 x 70, Sun and Moon from DE440, no drag or radiation pressure on either side. AP: a 72 h fit
//    of the THEMIS-like set with drag and AGOM pinned at 0, flown 7 days on a 10-minute grid. Outcome: the day-5 whole-day
//    3D RMS is within 200 m. Measured 119.6 m; 122.9 m with 0.6.16's uniform 8.2-minute step, 918.6 m at 38 min.
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
const THEMIS = {n, e, i: 10, raan: 30, argp: 300, h0: 38};
const CHANDRA = {n: 0.37795, e: 0.685, i: 72, raan: 330, argp: 270, h0: 95};
const nodesPerRev = (o) => 2 * Math.PI / Math.min(0.5 * Math.sqrt(1 - o.e), 0.85 * o.h0 * o.n * 2 * Math.PI / 1440);

const modules = fileURLToPath(new URL('../../../', import.meta.url)), packageRoot = path.join(modules, 'propagator/sdn-ap');
function testBuild(prefix, patches) {
  const tree = scratchTemp(prefix), copy = path.join(tree, 'propagator/sdn-ap');
  fs.cpSync(packageRoot, copy, {recursive: true, filter: (p) => !/\/(node_modules|test|dist|\.build)(\/|$)/.test(p.slice(packageRoot.length))});
  for (const [name, from, to] of patches) {
    const file = path.join(copy, 'src', name), text = fs.readFileSync(file, 'utf8');
    assert.equal(text.split(from).length, 2, `${name}: ${from.slice(0, 60)}`);
    fs.writeFileSync(file, text.replace(from, to));
  }
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

// 1. against a uniform fine step
const fine = testBuild('sdn-ap-lp-fine-', [
  ['xp_theory.inc', '      b.lp_even = 1;', '      b.lp_even = 0;'],
  ['xp_theory.inc', '      b.lp_step = b.lp_dE / n0;  // the mean step', '      b.lp_step = b.resonance == 1 ? 2.375 : 11.875;'],
]);
const epoch = '2026-10-29T00:00:00.000', t0 = Date.parse(epoch + 'Z');
const epochs = [...Array(7 * 288)].map((_, k) => new Date(t0 + (k + 1) * 300000).toISOString().replace('Z', ''));
const fly = async (file, set) => {
  const h = await createStandaloneHarness('browser', file, {surface: 'command'});
  const r = await h.invoke({methodId: 'propagate', inputs: flight([set], {output: {EPOCHS: epochs, FRAME: pcfOutputFrame.GCRF}})});
  await h.close?.();
  assert.equal(r.statusCode, 0, `${file}: ${r.errorCode} ${r.errorMessage}`);
  return OEM.getRootAsOEM(new fb.ByteBuffer(r.outputs.find((o) => o.portId === 'ephemeris').payload)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES;
};
const convergence = {};
for (const [name, o, bound] of [['THEMIS-like', THEMIS, 4], ['Chandra-like', CHANDRA, 15]]) {
  const set = seedOcm({epoch, n: o.n, e: o.e, i: o.i, raan: o.raan, argp: o.argp, ma: 10, bterm: 0.01, agom: 0.0125, norad: 99001, tesseral: 31, zonal: 20});
  const [a, b] = [await fly(wasmPath, set), await fly(fine, set)];
  const d = a.map((p, k) => 1000 * Math.hypot(p.X - b[k].X, p.Y - b[k].Y, p.Z - b[k].Z));
  const dayRms = (day) => Math.sqrt(d.slice((day - 1) * 288, day * 288).reduce((s, x) => s + x * x, 0) / 288);
  convergence[name] = {nodesPerRevolution: +nodesPerRev(o).toFixed(1), rmsM: Object.fromEntries([1, 3, 5, 7].map((day) => [day, +dayRms(day).toFixed(3)])), boundM: bound};
  console.log(JSON.stringify({[name]: convergence[name]}));
  assert.ok(dayRms(5) <= bound, `${name} against a fine uniform step, day 5: ${dayRms(5).toFixed(3)} m (bound ${bound} m)`);
}

// 2. one grid for a nominal, its covariance's moved set and a fit iterate's moved set
const PROBE = String.raw`
SDNAP_EXPORT("sdnap_test_lp_nodes")
int32_t sdnap_test_lp_nodes(const double* in, double* out) {
  using namespace sdnap;
  using namespace sdnap::xpt;
  tess::active() = tess::Terms{31, 20};
  Elements e{};
  e.epoch_jd_whole = in[0]; e.epoch_jd_frac = in[1]; e.xno = in[2]; e.eo = in[3]; e.xincl = in[4]; e.xnodeo = in[5];
  e.omegao = in[6]; e.xmo = in[7];
  Elements m = e;
  m.xno *= 1.0 + 1e-6; m.eo += 1e-5; m.xincl += 1e-5; m.xmo += 1e-4;
  static XpSat nom, cov, fit;
  if (xp_init(e, nom) != 0) return -1;
  { CovBankScope scope(&nom); if (xp_init(m, cov) != 0) return -2; }
  { const Branch b = nom.ctx.branch; BranchScope pin(&b); if (xp_init(m, fit) != 0) return -3; }
  if (!nom.ctx.branch.lp_even || !cov.ctx.branch.lp_even || !fit.ctx.branch.lp_even) return -4;
  Node a = nom.epoch, b = cov.epoch, c = fit.epoch;
  double d_cov = 0.0, d_fit = 0.0, d_rule = 0.0;
  for (int k = 0; k < 400; ++k) {
    Node a1, b1, c1;
    if (!next_node(nom.ctx, a, 1, a1) || !next_node(cov.ctx, b, 1, b1) || !next_node(fit.ctx, c, 1, c1)) return -5;
    d_cov = std::fmax(d_cov, std::fabs(b1.t - a1.t));
    d_fit = std::fmax(d_fit, std::fabs(c1.t - a1.t));
    d_rule = std::fmax(d_rule, std::fabs(a1.t - lp_node_time(nom.ctx.branch, a1.index)));
    a = a1; b = b1; c = c1;
  }
  out[0] = d_cov; out[1] = d_fit; out[2] = d_rule; out[3] = a.t; out[4] = nom.ctx.branch.lp_dE;
  return 0;
}
`;
const probe = testBuild('sdn-ap-lp-nodes-', [['abi.inc', 'SDNAP_EXPORT("sdnap_frame_probe")', PROBE + '\nSDNAP_EXPORT("sdnap_frame_probe")']]);
{
  const h = await createStandaloneHarness('browser', probe, {surface: 'direct'});
  const x = h.instance.exports, pin = x.sdnap_alloc(64), pout = x.sdnap_alloc(40), rad = Math.PI / 180;
  const jd = Date.UTC(2026, 9, 29) / 86400000 + 2440587.5;
  new Float64Array(h.memory.buffer, pin, 8).set([jd, 0, THEMIS.n * 2 * Math.PI / 1440, THEMIS.e, THEMIS.i * rad, THEMIS.raan * rad, THEMIS.argp * rad, 10 * rad]);
  const status = x.sdnap_test_lp_nodes(pin, pout);
  const [dCov, dFit, dRule, last, dE] = Array.from(new Float64Array(h.memory.buffer, pout, 5));
  console.log(JSON.stringify({oneGrid: {status, covarianceMovedSetMin: dCov, fitMovedSetMin: dFit, ruleMin: dRule, nodes: 400, spanDays: +(last / 1440).toFixed(3), dE}}));
  x.sdnap_free(pin);
  x.sdnap_free(pout);
  await h.close?.();
  assert.equal(status, 0, 'the probe ran');
  assert.ok(dCov === 0 && dFit === 0, `moved sets on the nominal's nodes: ${dCov} and ${dFit} min`);
  assert.ok(dRule <= 1e-9, `the nodes at the rule's t_k (to rounding): ${dRule} min`);
}

// 3. FFM model truth
const r = await runModelTruth({name: 'THEMIS-like', n, e, i: 10, raan: 30, argp: 300, ma: 0, drag: false, field: [70, 70], forces: [31, 20], hourly: true, gridMinutes: 10});
const days = Object.fromEntries(Object.entries(r.wholeDay).map(([d, v]) => [d, {e: +v.e.toFixed(1), r: +v.r.toFixed(1), t: +v.t.toFixed(1), n: +v.n.toFixed(1)}]));
console.log(JSON.stringify({modelTruth: {fixture: {n, e, i: 10, raan: 30, argp: 300}, fitWrmsM: +(r.fitted.wrms * 1000).toFixed(1), wholeDayM: days, apSha256: r.apSha256}}));
assert.ok(r.wholeDay[5].e <= 200, `THEMIS-like model truth, day 5: ${r.wholeDay[5].e.toFixed(1)} m (bound 200 m; measured 119.6 m)`);
console.log('Long-period perigee step E2E: PASS');
process.exit(0);

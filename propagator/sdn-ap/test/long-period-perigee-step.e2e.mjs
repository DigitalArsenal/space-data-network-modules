#!/usr/bin/env node
// SPEC 9 and 16.10, DigitalArsenal/spacedatanetwork-stack#445 and #450: above e0 0.3 the long-period regime's nodes are even
// in s = E - 0.5 e0 sin E, E the epoch orbit's eccentric anomaly: s(E_k) = s(E0) + k ds, t_k = (G(E_k) - G(E0)) / n0,
// G(E) = E - e0 sin E, ds = min(0.5 (1 - e0)^1.5, h0 n0), h0 38 min (the one-day class) or 95 min: 0.6.16's node count and
// mean step, min(0.5 tau_p, h0), tau_p = (1 - e0)^1.5 / n0, spread toward apogee.
// 1. Integration error, as a conjunction screen sees it. A THEMIS-like set (n 1.0496 rev/day, e 0.822, perigee 900 km, i 10
//    deg; the one-day class) and a Chandra-like set (0.37795 rev/day, e 0.685, i 72; class 0), FORCES 31,20, drag and
//    radiation on, at four epochs a season apart (the Sun and Moon geometry moves the step's error 2 to 10 times), each flown
//    7 days at 60 s by the module and by a test build at a uniform fine step (2.375 and 11.875 min). Outcome: the worst over
//    the four epochs of the difference's RMS near perigee (the lowest tenth of the radius) and of its largest value is at
//    most 0.6.20's worst: THEMIS-like 0.789 / 1.816 m (measured 0.363 / 1.078 m), Chandra-like 30.683 / 50.215 m (measured
//    5.779 / 8.865 m).
// 2. One grid. In a test build: a covariance's moved set (CovBankScope) and a fit iterate's moved set (BranchScope, the
//    iterate's branch) at elements moved from the nominal's fly exactly the nominal's node times over 400 nodes, and those
//    are the rule's t_k. Outcome: the moved sets' differences are 0, the rule's within 1e-9 min (rounding).
// 3. Model truth. FFM: EGM96 70 x 70, Sun and Moon from DE440, no drag or radiation pressure on either side. AP: a 72 h fit
//    of the THEMIS-like set with drag and AGOM pinned at 0, flown 7 days on a 10-minute grid. Outcome: the day-5 whole-day
//    3D RMS is within 200 m. Measured 122.9 m, as with 0.6.16's uniform 8.2-minute step (918.6 m at 38 min): at this node
//    count the step's error is under a meter and the theory's is the figure.
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
const nodesPerRev = (o) => 2 * Math.PI / Math.min(0.5 * (1 - o.e) ** 1.5, o.h0 * o.n * 2 * Math.PI / 1440);

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
const fly = async (file, set, epochs) => {
  const h = await createStandaloneHarness('browser', file, {surface: 'command'});
  const r = await h.invoke({methodId: 'propagate', inputs: flight([set], {output: {EPOCHS: epochs, FRAME: pcfOutputFrame.GCRF}})});
  await h.close?.();
  assert.equal(r.statusCode, 0, `${file}: ${r.errorCode} ${r.errorMessage}`);
  return OEM.getRootAsOEM(new fb.ByteBuffer(r.outputs.find((o) => o.portId === 'ephemeris').payload)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES;
};
// four Sun and Moon geometries a season apart; the bounds are 0.6.20's worst over them (its uniform step, min(0.5 tau_p, h0)):
// THEMIS-like 0.789 m near perigee (Jan 20) and 1.816 m at worst (Jan 20), Chandra-like 30.683 m and 50.215 m (Jan 20)
const EPOCHS = ['2026-01-20T00:00:00.000', '2026-04-20T00:00:00.000', '2026-07-20T00:00:00.000', '2026-10-29T00:00:00.000'];
const BOUND = {'THEMIS-like': {perigee: 0.789, largest: 1.816}, 'Chandra-like': {perigee: 30.683, largest: 50.215}};
const rms = (v) => Math.sqrt(v.reduce((s, x) => s + x * x, 0) / v.length);
for (const [name, o] of [['THEMIS-like', THEMIS], ['Chandra-like', CHANDRA]]) {
  const worst = {perigee: 0, largest: 0}, byEpoch = {};
  for (const epoch of EPOCHS) {
    const t0 = Date.parse(epoch + 'Z'), epochs = [...Array(7 * 1440)].map((_, k) => new Date(t0 + (k + 1) * 60000).toISOString().replace('Z', ''));
    const set = seedOcm({epoch, n: o.n, e: o.e, i: o.i, raan: o.raan, argp: o.argp, ma: 10, bterm: 0.01, agom: 0.0125, norad: 99001, tesseral: 31, zonal: 20});
    const [a, b] = [await fly(wasmPath, set, epochs), await fly(fine, set, epochs)];
    const d = a.map((p, k) => 1000 * Math.hypot(p.X - b[k].X, p.Y - b[k].Y, p.Z - b[k].Z)), r = b.map((p) => Math.hypot(p.X, p.Y, p.Z));
    const cut = r.toSorted((x, y) => x - y)[Math.floor(r.length / 10)];
    const got = {perigee: rms(d.filter((_, k) => r[k] <= cut)), largest: Math.max(...d), day5: rms(d.slice(4 * 1440, 5 * 1440))};
    byEpoch[epoch.slice(0, 10)] = {nearPerigeeM: +got.perigee.toFixed(3), largestM: +got.largest.toFixed(3), day5RmsM: +got.day5.toFixed(3)};
    worst.perigee = Math.max(worst.perigee, got.perigee);
    worst.largest = Math.max(worst.largest, got.largest);
  }
  console.log(JSON.stringify({[name]: {nodesPerRevolution: +nodesPerRev(o).toFixed(1), byEpoch, worstNearPerigeeM: +worst.perigee.toFixed(3),
    worstLargestM: +worst.largest.toFixed(3), boundM: BOUND[name]}}));
  for (const k of ['perigee', 'largest'])
    assert.ok(worst[k] <= BOUND[name][k], `${name} against a fine uniform step, the worst ${k} over 4 epochs: ${worst[k].toFixed(3)} m (0.6.20's worst: ${BOUND[name][k]} m)`);
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
assert.ok(r.wholeDay[5].e <= 200, `THEMIS-like model truth, day 5: ${r.wholeDay[5].e.toFixed(1)} m (bound 200 m; measured 122.9 m)`);
console.log('Long-period perigee step E2E: PASS');
process.exit(0);

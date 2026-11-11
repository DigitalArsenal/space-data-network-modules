#!/usr/bin/env node
// SPEC 16.11, 16.12, DigitalArsenal/spacedatanetwork-stack#497: an AP set carries drag above e 0.3 and the tesseral grid's
// families only where they act, each decided by the set's own epoch elements. Constant weather (F10.7 150, Ap 15:
// test/lib/spw-constant.mjs), FORCES 31,20, NRLMSISE-00, epoch 2026-10-29 00:00 UTC, every flight 7 days at 300 s.
// 1. Drag (16.12): e 0.7, i 63.4, RAAN 300, argp 270, M 10, AGOM 0.01, flown with B 0.05 m^2/kg and with B 0. Outcome: at an
//    epoch perigee height of 5,200 km every state is the same bit for bit (B is taken as 0); at 4,800 km the states differ
//    (the drag passage runs; the theory's density there is 1e-20 kg/m^3, so by millimeters).
// 2. The grid (16.11): sdnap_wide_families at degree 12 on a THEMIS-like set (22.9 h, perigee 900 km, i 10 deg) and a TESS-like
//    set (13.7 days, perigee 102,000 km, i 40). Outcome: the families left out sum to at most 10 cm and none is larger than a
//    family kept; THEMIS-like keeps 111 of its 288 families, TESS-like 11.
// 3. A transfer orbit below the drag line: n 2.26 rev/day, e 0.72 (perigee 387 km), i 27, RAAN 60, argp 180, M 10, B 0.01,
//    AGOM 0.01. Outcome: its positions at days 1 to 7 lie within 10 cm of 0.6.25's (the families left out sum to at most
//    10 cm; its drag is unchanged).
// Every number comes from the built module's own calls. JS only moves bytes and compares numbers the module produced.
//   node test/heo-cost-rules.e2e.mjs
import assert from 'node:assert/strict';
import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {wasmPath} from './lib/module.mjs';
import {T, seedOcm, rowsThrough} from './lib/ocm.mjs';
import {spwFixtureRows} from './lib/spw-constant.mjs';

const epoch = '2026-10-29T00:00:00.000', t0 = Date.parse(epoch + 'Z'), MU = 398600.4418, RE = 6378.1363;
const rows = rowsThrough(spwFixtureRows());
const meanMotion = (a) => 86400 / (2 * Math.PI * Math.sqrt(a ** 3 / MU));  // rev/day
const STEP = 300, N = (7 * 86400) / STEP, W = new Float64Array(N), F = new Float64Array(N);
for (let k = 0; k < N; ++k) { const d = (t0 + (k + 1) * STEP * 1000) / 86400000; W[k] = Math.floor(d) + 2440587.5; F[k] = d - Math.floor(d); }

// one set flown in its own instance: positions (km) every 300 s
async function fly(c) {
  const h = await createStandaloneHarness('browser', wasmPath, {surface: 'direct'});
  const x = h.instance.exports, out = x.sdnap_alloc(48);
  const r = await h.invoke({methodId: 'load_epochs', inputs: [{portId: 'ocm', typeRef: T('OCM'),
    payload: seedOcm({epoch, ...c, norad: 99001, msis: true, records: true, tesseral: 31, zonal: 20, rows})}]});
  assert.equal(r.statusCode, 0, `load_epochs: ${r.errorMessage}`);
  const s = new Float64Array(3 * N);
  for (let k = 0; k < N; ++k) {
    assert.equal(x.sdnap_epochs_set_at(0, 0, W[k], F[k], out), 0, `state ${k}`);
    s.set(new Float64Array(h.memory.buffer, out, 3), 3 * k);
  }
  await h.close?.();
  return s;
}
const largest = (a, b) => { let m = 0; for (let k = 0; k < N; ++k) m = Math.max(m, Math.hypot(a[3 * k] - b[3 * k], a[3 * k + 1] - b[3 * k + 1], a[3 * k + 2] - b[3 * k + 2])); return m * 1000; };

// 1. the drag line
const summary = {drag: {}, grid: {}};
for (const hp of [5200, 4800]) {
  const e = 0.7, c = {n: meanMotion((RE + hp) / (1 - e)), e, i: 63.4, raan: 300, argp: 270, ma: 10, agom: 0.01};
  const [withB, without] = [await fly({...c, bterm: 0.05}), await fly({...c, bterm: 0})];
  const same = withB.every((v, k) => Object.is(v, without[k]));
  summary.drag[`perigee ${hp} km`] = {sameBitForBit: same, largestDifferenceM: largest(withB, without)};
  if (hp > 5000) assert.ok(same, `perigee ${hp} km: B changes no state (${JSON.stringify(summary.drag)})`);
  else assert.ok(!same, `perigee ${hp} km: the drag passage runs (${JSON.stringify(summary.drag)})`);
}

// 2. the grid's families
{
  const h = await createStandaloneHarness('browser', wasmPath, {surface: 'direct'});
  const x = h.instance.exports, MAX = 400, inp = x.sdnap_alloc(32), out = x.sdnap_alloc(MAX * 4 * 8);
  const aOf = (days) => Math.cbrt(MU * ((days * 86400) / (2 * Math.PI)) ** 2);
  const SETS = {'THEMIS-like': [22.9 / 24, 900, 10, 111], 'TESS-like': [13.7, 102000, 40, 11]};
  for (const [name, [days, hp, i, keeps]] of Object.entries(SETS)) {
    const a = aOf(days);
    new Float64Array(h.memory.buffer, inp, 4).set([1 / days, 1 - (RE + hp) / a, i, 12]);
    const count = x.sdnap_wide_families(inp, out, MAX);
    assert.ok(count > 0 && count <= MAX, `${name}: sdnap_wide_families ${count}`);
    const r = Array.from({length: count}, (_, k) => Array.from(new Float64Array(h.memory.buffer, out + 32 * k, 4)));
    const kept = r.filter((f) => f[3] === 1), left = r.filter((f) => f[3] === 0);
    const leftSum = left.reduce((s, f) => s + f[2], 0), leftMax = Math.max(0, ...left.map((f) => f[2])), keptMin = Math.min(...kept.map((f) => f[2]));
    summary.grid[name] = {families: count, kept: kept.length, leftOutSumM: leftSum, largestLeftOutM: leftMax, smallestKeptM: keptMin,
      largestM: Math.max(...r.map((f) => f[2]))};
    assert.ok(r.every((f) => Number.isFinite(f[2]) && f[2] >= 0), `${name}: every size finite and not negative`);
    assert.ok(leftSum <= 0.1, `${name}: the families left out sum to ${leftSum} m (at most 0.1)`);
    assert.ok(leftMax <= keptMin, `${name}: no family left out (${leftMax} m) is larger than one kept (${keptMin} m)`);
    assert.equal(kept.length, keeps, `${name}: ${kept.length} of ${count} families kept (measured ${keeps})`);
  }
  await h.close?.();
}

// 3. the transfer orbit against 0.6.25's positions (km) at days 1 to 7
const V0625 = [
  [26727.975214569968, 24566.095749814842, -5421.7184309309405], [18333.389961258188, 37632.47661860267, 1751.0434158862486],
  [-198.42032284062395, 28950.73332329176, 7686.031573075238], [14531.61975105301, -1286.8492158357085, -6664.528899630524],
  [26130.784261323064, 28305.250061016504, -3738.5600057928536], [15394.827027246936, 38038.399625723156, 3640.6810182725694],
  [-3893.439511475748, 24270.288544540537, 8304.53559988769],
];
const gto = await fly({n: 2.26, e: 0.72, i: 27, raan: 60, argp: 180, ma: 10, bterm: 0.01, agom: 0.01});
const atDays = Array.from({length: 7}, (_, d) => Array.from(gto.subarray(3 * ((d + 1) * 288 - 1), 3 * ((d + 1) * 288))));
const off = atDays.map((p, d) => Math.hypot(p[0] - V0625[d][0], p[1] - V0625[d][1], p[2] - V0625[d][2]) * 1000);
summary.transferOrbit = {positionsKm: atDays, offFrom0625M: off};
console.log(JSON.stringify(summary));
assert.ok(off.every((d) => d <= 0.1), `the transfer orbit: ${off.map((d) => d.toFixed(4)).join(', ')} m from 0.6.25's positions (at most 0.1 m)`);
console.log('HEO cost rules E2E: PASS');
process.exit(0);

#!/usr/bin/env node
// Registration (2026-11-03, modules-sdn-ap-high-e-output-cost-20261103): above e 0.3 the drag's rates that place the
// pass's short-period steps (SPEC 16.12) are evaluated once per perigee passage and interpolated between passages instead
// of at every output sample. Baselines the 0.4.15 (git 4a02a6d90, cost) and 0.4.16 (git 1ec779200, positions) releases.
// The seeded HEO sets with drag (B 0.044, NRLMSISE-00 at constant weather, FORCES 31,20): Molniya (2 rev/day, e 0.74),
// GTO (2.40 rev/day, e 0.72, 220 km perigee), GTO-500 (e 0.7081).
// Acceptance:
// 1. `propagate` over 7 days on a 1 min grid (browser host, the releases interleaved, median of 9, test/drag-cost.mjs's
//    measure): ms per object-day at most 1.3 times 0.4.15's on each fixture;
// 2. the 1 min grid positions within 0.01 m of 0.4.16's at every sample over the 7 days on each fixture;
// 3. e at most 0.3 (an e 0.25 set with drag) and drag off (Molniya): positions byte-identical to 0.4.16's;
// 4. default-FORCES XP digest bit-exact.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runModelTruth} from './lib/heo-model-truth.mjs';
import {wasmPath} from './lib/module.mjs';

const scratch = '/Users/tj/software/terrain-work/body-look/codex-apfix-d9/cost-e2e';
const modules = fileURLToPath(new URL('../../../', import.meta.url));
fs.mkdirSync(scratch, {recursive: true});
const release = (sha) => {
  const p = path.join(scratch, `release-${sha}.wasm`);
  fs.writeFileSync(p, execFileSync('git', ['-C', modules, 'show', `${sha}:propagator/sdn-ap/dist/isomorphic/module.wasm`], {maxBuffer: 1 << 26}));
  return p;
};
const R415 = release('4a02a6d90'), R416 = release('1ec779200');
const FIXTURES = {
  Molniya: {n: 2, e: 0.74, i: 63.4, raan: 300, argp: 270, ma: 10},
  GTO: {n: 2.40, e: 0.72, i: 27, raan: 40, argp: 270, ma: 10},
  'GTO-500': {n: 2.40, e: 0.7081, i: 27, raan: 40, argp: 270, ma: 10},
};
const median = (a) => { const v = a.toSorted((x, y) => x - y), i = v.length >> 1; return v.length % 2 ? v[i] : (v[i - 1] + v[i]) / 2; };
const fly = (name, c, modulePath, drag = true) => runModelTruth({name, ...c, drag, mode: 'seed', costGridMinutes: 1, costFlown: true, modulePath});
for (const [name, c] of Object.entries(FIXTURES)) {
  const t = {at0415: [], release: []};
  for (let k = 0; k < 9; ++k)
    for (const [arm, modulePath] of [['at0415', R415], ['release', wasmPath]]) t[arm].push((await fly(name, c, modulePath)).costMs / 7);
  const cost = {at0415: median(t.at0415), release: median(t.release)};
  const a = (await fly(name, c, R416)).flown, b = (await fly(name, c, wasmPath)).flown;
  let worst = 0;
  for (let k = 0; k < a.length; ++k) worst = Math.max(worst, 1000 * Math.hypot(a[k][0] - b[k][0], a[k][1] - b[k][1], a[k][2] - b[k][2]));
  console.log(JSON.stringify({fixture: name, msPerObjectDay: cost, ratio: cost.release / cost.at0415, samples: a.length, worstMetersFrom0416: worst}));
  assert.ok(cost.release <= 1.3 * cost.at0415, `${name}: 1 min grid cost ${cost.release} against 0.4.15's ${cost.at0415} ms per object-day`);
  assert.ok(worst <= 0.01, `${name}: ${worst} m from 0.4.16`);
}
for (const [name, c, drag] of [['e 0.25', {n: 6, e: 0.25, i: 50, raan: 10, argp: 30, ma: 0}, true], ['Molniya drag off', FIXTURES.Molniya, false]]) {
  const a = (await fly(name, c, R416, drag)).flown, b = (await fly(name, c, wasmPath, drag)).flown;
  console.log(JSON.stringify({unchanged: name, identical: JSON.stringify(a) === JSON.stringify(b)}));
  assert.equal(JSON.stringify(b), JSON.stringify(a), `${name}: byte-identical to 0.4.16`);
}
execFileSync(process.execPath, [new URL('./conformance.e2e.mjs', import.meta.url).pathname, '--reproduce', new URL('./results/conformance.json', import.meta.url).pathname],
  {stdio: 'inherit', env: {...process.env, SDN_AP_ORACLE_ROOT: process.env.SDN_AP_ORACLE_ROOT ?? '/Users/tj/software/spacedatanetwork-stack/repos/main-packages/space-data-network-closed-modules/packages/sgp4-xp-oracle'}});
console.log('high-e output cost E2E: PASS');

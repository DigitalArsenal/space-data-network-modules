#!/usr/bin/env node
// Registration (2026-11-03): the eccentricity bound of SPEC 16.8's degree 4 to 10 tidal terms. Test builds of this
// module: ON (the bound lifted), OFF (the terms nowhere) and NUM23 (the bound lifted, and SPEC 5's closed-form degree 2
// and 3 averages replaced by the same quadrature over degrees 2 to 10). FFM EGM96 70x70 with Sun and Moon (DE440) as
// the reference, 72 h fits, 7 days flown hourly, day-7 3D RMS. Sweep: n 2.0059 rev/day; orientations G1 (i 63.4, node
// 300, perigee 270 deg), G2 (63.4, 60, 90), G3 (55, 180, 0); e 0.05, 0.07, 0.085, 0.1, 0.2, 0.3, 0.5, 0.72, 0.74.
// Acceptance: ON below OFF at every e up to 0.085 in all three orientations, and the first turn before 0.1 (G2 at 0.1:
// ON above OFF), the measured basis of the bound; the release equals OFF on the e 0.72 half-day and e 0.74 Molniya
// fixtures of SPEC 16.6 at day 7, within 0.5 m of 0.4.9's 91.4 and 700.4 m; NUM23 within 0.1 m of ON at day 7 on the
// half-day fixture and on an Etalon-like orbit; the Etalon-1/2 paired and LAGEOS-1/2 median day-3 errors of the AP6
// windows within 0.5 m of 0.4.9 (git 61347ca8c); default-FORCES digest bit-exact. Every number printed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {Worker, isMainThread, parentPort, workerData} from 'node:worker_threads';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

if (!isMainThread) {
  const {kind, c} = workerData;
  if (kind === 'synthetic') {
    const {runSyntheticTruth} = await import('./lib/synthetic-truth.mjs');
    const r = await runSyntheticTruth(c);
    parentPort.postMessage(Object.fromEntries([1, 3, 7].map((d) => [d, Math.hypot(r.days[d].n, r.days[d].t, r.days[d].r)])));
  } else {
    const {runModelTruth} = await import('./lib/heo-model-truth.mjs');
    const r = await runModelTruth(c);
    parentPort.postMessage(Object.fromEntries([1, 3, 7].map((d) => [d, r.days[d].e])));
  }
} else {
  const {archive} = await import('./lib/regime-windows.mjs');
  const {wasmPath} = await import('./lib/module.mjs');
  const BASE = '61347ca8c', scratch = '/Users/tj/software/terrain-work/body-look/codex-apfix-d9/tidal-degree4';
  const modules = fileURLToPath(new URL('../../../', import.meta.url)), packageRoot = path.join(modules, 'propagator/sdn-ap');
  fs.mkdirSync(scratch, {recursive: true});
  const testBuild = (name, edits) => {
    const tree = path.join(scratch, name), copy = path.join(tree, 'propagator/sdn-ap');
    fs.rmSync(tree, {recursive: true, force: true});
    fs.cpSync(packageRoot, copy, {recursive: true, filter: (p) => !/\/(node_modules|test|dist)(\/|$)/.test(p.slice(packageRoot.length))});
    const source = path.join(copy, 'src/xp_theory.inc');
    let text = fs.readFileSync(source, 'utf8');
    for (const [a, b] of edits) {
      assert.equal(text.split(a).length, 2, `${name}: one ${a.slice(0, 60)}`);
      text = text.replace(a, b);
    }
    fs.writeFileSync(source, text);
    fs.symlinkSync(path.join(packageRoot, 'node_modules'), path.join(copy, 'node_modules'));
    fs.symlinkSync(path.join(modules, 'foundation'), path.join(tree, 'foundation'));
    try {
      execFileSync(process.execPath, ['build.mjs'], {cwd: copy, stdio: 'ignore', env: {...process.env, SPACE_DATA_NETWORK_MODULES_ROOT: modules, SDNAP_DIST_DIR: path.join(tree, 'dist')}});
    } finally {
      fs.unlinkSync(path.join(copy, 'node_modules'));
      fs.unlinkSync(path.join(tree, 'foundation'));
    }
    return path.join(tree, 'dist/isomorphic/module.wasm');
  };
  const bound = (v) => ['constexpr double kThirdBodyTailMaxE = 0.1;', `constexpr double kThirdBodyTailMaxE = ${v};`];
  const ON = testBuild('on', [bound('1.0')]);
  const OFF = testBuild('off', [bound('0.0')]);
  const NUM23 = testBuild('num23', [bound('1.0'), ['    if (L >= 4) {', '    if (L >= 2) {'],
    ['    for (int j = 0; j < 2; ++j) {\n      double A, B, C;\n      direction_cosines(pf, us[j], A, B, C);',
      '    for (int j = 0; j < (ctx.ap_third_body ? 0 : 2); ++j) {\n      double A, B, C;\n      direction_cosines(pf, us[j], A, B, C);']]);

  const pool = async (jobs, limit) => {
    const out = new Array(jobs.length);
    let next = 0;
    await Promise.all(Array.from({length: limit}, async () => {
      while (next < jobs.length) {
        const k = next++;
        out[k] = await new Promise((resolve, reject) => {
          const w = new Worker(new URL(import.meta.url), {workerData: jobs[k]});
          w.once('message', (m) => { w.terminate(); resolve(m); });
          w.once('error', reject);
        });
      }
    }));
    return out;
  };
  const GEOMETRIES = {G1: {i: 63.4, raan: 300, argp: 270}, G2: {i: 63.4, raan: 60, argp: 90}, G3: {i: 55, raan: 180, argp: 0}};
  const ES = [0.05, 0.07, 0.085, 0.1, 0.2, 0.3, 0.5, 0.72, 0.74];
  const jobs = [], keys = [];
  for (const [g, o] of Object.entries(GEOMETRIES))
    for (const e of ES)
      for (const [arm, modulePath] of [['on', ON], ['off', OFF]]) {
        keys.push(['sweep', g, e, arm]);
        jobs.push({kind: 'synthetic', c: {name: `${g} e ${e} ${arm}`, n: 2.0059, e, ...o, ma: 10, drag: false, thirdBody: true, tesseral: 31, zonal: 20, modulePath}});
      }
  const HALF_DAY = {name: 'half-day-critical', n: 2.0059, e: 0.72, i: 63.4, raan: 300, argp: 270, ma: 10, drag: false};
  const MOLNIYA = {name: 'Molniya', n: 2, e: 0.74, i: 63.4, raan: 300, argp: 270, ma: 10, drag: true};
  for (const [f, c] of [['half-day', HALF_DAY], ['Molniya', MOLNIYA]])
    for (const [arm, modulePath] of [['release', wasmPath], ['off', OFF], ['on', ON]]) {
      keys.push(['fixture', f, arm]);
      jobs.push({kind: 'fixture', c: {...c, modulePath}});
    }
  const ETALON_LIKE = {name: 'etalon-like', n: 2.13, e: 0.0007, i: 64.9, raan: 90, argp: 0, ma: 0, drag: false, thirdBody: true, tesseral: 31, zonal: 20};
  for (const [cName, c] of [['half-day', {...HALF_DAY, thirdBody: true, tesseral: 31, zonal: 20}], ['etalon-like', ETALON_LIKE]])
    for (const [arm, modulePath] of [['on', ON], ['num23', NUM23]]) {
      keys.push(['closed-form', cName, arm]);
      jobs.push({kind: 'synthetic', c: {...c, modulePath}});
    }
  const results = await pool(jobs, Math.min(16, os.availableParallelism()));
  const at = (...k) => results[keys.findIndex((x) => x.join('|') === k.join('|'))];
  const sweep = {};
  for (const g of Object.keys(GEOMETRIES)) {
    sweep[g] = ES.map((e) => ({e, onDay7: at('sweep', g, e, 'on')[7], offDay7: at('sweep', g, e, 'off')[7]}));
    for (const r of sweep[g]) console.log(JSON.stringify({sweep: g, ...r, differenceMeters: r.onDay7 - r.offDay7}));
  }
  const fixtures = Object.fromEntries(['half-day', 'Molniya'].map((f) => [f, {release: at('fixture', f, 'release')[7], off: at('fixture', f, 'off')[7], on: at('fixture', f, 'on')[7]}]));
  console.log(JSON.stringify({fixturesDay7Meters: fixtures}));
  const closedForm = Object.fromEntries(['half-day', 'etalon-like'].map((c) => [c, {on: at('closed-form', c, 'on')[7], num23: at('closed-form', c, 'num23')[7]}]));
  console.log(JSON.stringify({closedFormDay7Meters: closedForm}));

  // The AP6 Etalon and LAGEOS windows against 0.4.9.
  const baseline = path.join(scratch, `release-${BASE}.wasm`);
  fs.writeFileSync(baseline, execFileSync('git', ['-C', modules, 'show', `${BASE}:propagator/sdn-ap/dist/isomorphic/module.wasm`], {maxBuffer: 1 << 26}));
  const read = (dir) => {
    const out = new Map();
    for (const f of fs.readdirSync(dir).filter((f) => /^rows-\d+\.jsonl$/.test(f)))
      for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) if (line) { const r = JSON.parse(line); out.set(r.key, r); }
    return out;
  };
  const ffm = read(path.join(archive, 'resume-ffm'));
  const median = (a) => { const v = a.toSorted((x, y) => x - y), i = v.length >> 1; return v.length % 2 ? v[i] : (v[i - 1] + v[i]) / 2; };
  const rows = (await Promise.all(Array.from({length: 5}, (_, index) => new Promise((resolve, reject) => {
    const out = [];
    const worker = new Worker(new URL('./lib/regime-windows.mjs', import.meta.url), {workerData: {regimeWindows: true, group: 'GD', index, modulePaths: [baseline, wasmPath]}});
    worker.on('message', (msg) => {
      if (msg.row) out.push(msg.row);
      else if (msg.error) { worker.terminate(); reject(new Error(msg.error)); }
      else if (msg.done) worker.terminate().then(() => resolve(out));
    });
    worker.on('error', reject);
  })))).flat();
  const d3 = (a) => (a?.ok && a.days['3'] ? 1000 * a.days['3'].e : null);
  const f3 = (key) => d3(ffm.get(key)?.arms.F72);
  const windows = {};
  for (const name of ['ETALON 1', 'ETALON 2', 'LAGEOS 1', 'LAGEOS 2']) {
    const v = rows.filter((r) => r.key.split('|')[1] === name && !r.error && d3(r.arms[0]) !== null && d3(r.arms[1]) !== null && f3(r.key) !== null);
    const paired = name.startsWith('ETALON');
    const value = (arm) => median(v.map((r) => d3(r.arms[arm]) - (paired ? f3(r.key) : 0)));
    windows[name] = {n: v.length, metric: paired ? 'paired day-3 AP minus FFM' : 'median day-3', before: value(0), after: value(1)};
  }
  console.log(JSON.stringify({ap6Windows: windows}));
  if (process.env.SDN_AP_TIDAL_REPORT) fs.writeFileSync(process.env.SDN_AP_TIDAL_REPORT, JSON.stringify({sweep, fixtures, closedForm, windows}, null, 2) + '\n');

  if (!process.argv.includes('--measure')) {
    for (const g of Object.keys(GEOMETRIES))
      for (const r of sweep[g].filter((r) => r.e <= 0.085)) assert.ok(r.onDay7 < r.offDay7, `${g} e ${r.e}: the terms help below the bound`);
    const g2 = sweep.G2.find((r) => r.e === 0.1);
    assert.ok(g2.onDay7 > g2.offDay7, 'G2 e 0.1: the first turn lies before the bound');
    for (const [f, want] of [['half-day', 91.4], ['Molniya', 700.4]]) {
      assert.equal(fixtures[f].release, fixtures[f].off, `${f}: the release is the off arm (bound in force)`);
      assert.ok(Math.abs(fixtures[f].release - want) <= 0.5, `${f}: day 7 within 0.5 m of 0.4.9's ${want} m`);
    }
    for (const [c, v] of Object.entries(closedForm)) assert.ok(Math.abs(v.num23 - v.on) <= 0.1, `${c}: degree-2/3 quadrature within 0.1 m of SPEC 5's closed form`);
    for (const [name, v] of Object.entries(windows)) assert.ok(Math.abs(v.after - v.before) <= 0.5, `${name}: within 0.5 m of 0.4.9`);
    execFileSync(process.execPath, [new URL('./conformance.e2e.mjs', import.meta.url).pathname, '--reproduce', new URL('./results/conformance.json', import.meta.url).pathname],
      {stdio: 'inherit', env: {...process.env, SDN_AP_ORACLE_ROOT: process.env.SDN_AP_ORACLE_ROOT ?? '/Users/tj/software/spacedatanetwork-stack/repos/main-packages/space-data-network-closed-modules/packages/sgp4-xp-oracle'}});
    console.log('tidal degree 4 eccentric E2E: PASS');
  }
}

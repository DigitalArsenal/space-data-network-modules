#!/usr/bin/env node
// Registration (2026-11-03, committed before this replay runs): exploratory replay of the AP5 GN windows the gap
// diagnosis read (experiments ap-gap: resume-gn 24 h arcs, resume-frame-gn 72 h arcs; Space Force U24 from that
// archive). Acceptance: median paired day-3 difference XP24 (this module's default FIT) minus U24 within 10 m of zero
// (diagnosis: +56.107 m, n 748); XP24 not worse than the tested constants stated in $PCF FIT (XP_PRIOR24) by more than
// 1 m; XP72 median paired change from the archived XP72 at most +2 m at days 1, 3 and 7; every archived window fits;
// XP_PRIOR24 reproduces its archived errors within 1 mm (harness fidelity); default-FORCES digest bit-exact.
// Unread-window confirmation is a separate experiments task.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Worker} from 'node:worker_threads';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {archive} from './lib/gn-short-arc-windows.mjs';
import {wasmPath} from './lib/module.mjs';

const SHARDS = 2;
const read = (dir) => {
  const out = new Map();
  for (const f of fs.readdirSync(dir).filter((f) => /^rows-\d+\.jsonl$/.test(f)))
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) if (line) { const r = JSON.parse(line); out.set(r.key, r); }
  return out;
};
const median = (a) => { const v = a.toSorted((x, y) => x - y), i = v.length >> 1; return v.length % 2 ? v[i] : (v[i - 1] + v[i]) / 2; };
const short = read(path.join(archive, 'resume-gn')), long = read(path.join(archive, 'resume-frame-gn'));
const windows = new Map();
for (const [key, r] of short) if (r.arms.U24?.ok && r.arms.XP24?.ok && r.arms.XP_PRIOR24?.ok) windows.set(key, {norad: r.norad, arms: ['XP24', 'XP_PRIOR24']});
for (const [key, r] of long) if (r.arms.XP72?.ok) { const w = windows.get(key) ?? {norad: r.norad, arms: []}; w.arms.push('XP72'); windows.set(key, w); }
const norads = [...new Set([...windows.values()].map((w) => w.norad))].sort((a, b) => a - b);
const rows = [];
await Promise.all(norads.flatMap((norad) => Array.from({length: SHARDS}, (_, shard) => new Promise((resolve, reject) => {
  const keys = [...windows].filter(([, w]) => w.norad === norad).map(([key, w]) => ({key, arms: w.arms}));
  const worker = new Worker(new URL('./lib/gn-short-arc-windows.mjs', import.meta.url), {workerData: {gnShortArc: true, modulePath: wasmPath, norad, shard, shards: SHARDS, keys}});
  worker.on('message', (msg) => {
    if (msg.row) rows.push(msg.row);
    else if (msg.error) { worker.terminate(); reject(new Error(msg.error)); }
    else if (msg.done) worker.terminate().then(resolve);
  });
  worker.on('error', reject);
}))));
const m = (arm, k) => 1000 * arm.days[k].e;
const has3 = (...arms) => arms.every((a) => a?.ok && a.days['3']);
const failed = rows.flatMap((r) => Object.entries(r.arms).filter(([, a]) => !a.ok).map(([name, a]) => `${r.key} ${name}: ${a.error}`));
const p24 = rows.map((r) => ({r, u: short.get(r.key)?.arms.U24, before: short.get(r.key)?.arms.XP24, archived: short.get(r.key)?.arms.XP_PRIOR24, after: r.arms.XP24, tested: r.arms.XP_PRIOR24}))
  .filter((p) => has3(p.u, p.before, p.after, p.tested));
const p72 = rows.map((r) => ({r, before: long.get(r.key)?.arms.XP72, after: r.arms.XP72})).filter((p) => has3(p.before, p.after));
const summary = (list) => ({
  n: list.length,
  beforeMinusUMeters: median(list.map((p) => m(p.before, 3) - m(p.u, 3))),
  afterMinusUMeters: median(list.map((p) => m(p.after, 3) - m(p.u, 3))),
  testedMinusUMeters: median(list.map((p) => m(p.tested, 3) - m(p.u, 3))),
  afterMinusTestedMeters: median(list.map((p) => m(p.after, 3) - m(p.tested, 3))),
  medianDay3Meters: {XP24before: median(list.map((p) => m(p.before, 3))), XP24after: median(list.map((p) => m(p.after, 3))), XP_PRIOR24: median(list.map((p) => m(p.tested, 3))), U24: median(list.map((p) => m(p.u, 3)))},
});
const perObject = norads.map((norad) => ({norad, ...summary(p24.filter((p) => p.r.norad === norad))}));
for (const o of perObject) console.log(JSON.stringify({gn24: o}));
const total = summary(p24);
const fidelityMeters = Math.max(...p24.flatMap((p) => Object.keys(p.archived.days).map((k) => Math.abs(m(p.tested, k) - m(p.archived, k)))));
const long72 = Object.fromEntries([1, 3, 7].map((k) => [k, median(p72.filter((p) => p.before.days[k] && p.after.days[k]).map((p) => m(p.after, k) - m(p.before, k)))]));
const result = {
  exploratory: true, units: 'meters; forward daily-bin 3D RMS, leads from the fit end', moduleSha256: createHash('sha256').update(fs.readFileSync(wasmPath)).digest('hex'),
  windows: {replayed: rows.length, paired24: p24.length, paired72: p72.length, failures: failed},
  gn24: total, gn24PerObject: perObject, fidelityMaxMeters: fidelityMeters,
  gn72: {n: p72.length, medianPairedChangeMeters: long72, medianDay3Meters: {before: median(p72.map((p) => m(p.before, 3))), after: median(p72.map((p) => m(p.after, 3)))}},
};
console.log(JSON.stringify({gn24: total, fidelityMaxMeters: fidelityMeters, gn72: result.gn72, failures: failed.length}));
if (process.env.SDN_AP_SHORT_ARC_REPORT) fs.writeFileSync(process.env.SDN_AP_SHORT_ARC_REPORT, JSON.stringify(result, null, 2) + '\n');
if (!process.argv.includes('--measure')) {
  assert.equal(failed.length, 0, 'every archived window fits');
  assert.ok(fidelityMeters < 0.001, 'XP_PRIOR24 reproduces the archive within 1 mm');
  assert.ok(Math.abs(total.afterMinusUMeters) <= 10, 'paired day-3 XP24 minus Space Force within 10 m of zero');
  assert.ok(total.afterMinusTestedMeters <= 1, 'XP24 not worse than the tested constants by more than 1 m');
  for (const k of [1, 3, 7]) assert.ok(long72[k] <= 2, `72 h day-${k} median paired change at most 2 m`);
  execFileSync(process.execPath, [new URL('./conformance.e2e.mjs', import.meta.url).pathname, '--reproduce', new URL('./results/conformance.json', import.meta.url).pathname],
    {stdio: 'inherit', env: {...process.env, SDN_AP_ORACLE_ROOT: process.env.SDN_AP_ORACLE_ROOT ?? '/Users/tj/software/spacedatanetwork-stack/repos/main-packages/space-data-network-closed-modules/packages/sgp4-xp-oracle'}});
  console.log('fit short-arc priors E2E: PASS');
}

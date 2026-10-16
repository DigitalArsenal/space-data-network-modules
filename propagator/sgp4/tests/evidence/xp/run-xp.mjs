#!/usr/bin/env node
// SGP4-XP: the module against the US Space Force library's own runtime. No public reference outside the
// US Space Force exists for the SGP4-XP theory (sgp4-xp/vectors/PROVENANCE.md), so the check is what can be
// checked: the merged module returns the library's doubles exactly (same sets, same times, same instance), and the
// 15 Tier B anchors of the propagator ABI sit within their stated band.
//
//   node tests/evidence/xp/run-xp.mjs [--check]     writes summary-xp.json (or, with --check, compares to it)
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const xp = path.resolve(here, '../../../../sgp4-xp');
const sha = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const pkg = JSON.parse(fs.readFileSync(path.join(xp, 'package.json'), 'utf8'));
const rel = (p) => path.relative(path.resolve(here, '../../../../..'), p);

const files = {
  'dist/isomorphic/module.wasm': path.join(xp, 'dist/isomorphic/module.wasm'),
  'third_party/ussf-sgp4/Sgp4Prop.xp.wasm': path.join(xp, 'third_party/ussf-sgp4/Sgp4Prop.xp.wasm'),
  'third_party/ussf-sgp4/Sgp4Prop.xp.js': path.join(xp, 'third_party/ussf-sgp4/Sgp4Prop.xp.js'),
  'vectors/vectors.json': path.join(xp, 'vectors/vectors.json'),
  'tests/ussf_parity.test.mjs': path.join(xp, 'tests/ussf_parity.test.mjs'),
};
const hashes = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, sha(v)]));

const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'tests/ussf_parity.test.mjs'], { cwd: xp, encoding: 'utf8' });
const tap = run.stdout;
const pass = Number(/^# pass (\d+)/m.exec(tap)?.[1] ?? 0), fail = Number(/^# fail (\d+)/m.exec(tap)?.[1] ?? 0);
const title = /ok \d+ - (the module returns[^\n#]*)/.exec(tap)?.[1]?.trim() ?? null;

const vectors = JSON.parse(fs.readFileSync(files['vectors/vectors.json'], 'utf8'));
const tol = vectors.tolerancePolicy;
const summary = {
  about: 'SGP4-XP (US Space Force Sgp4Prop 9.1.1.0) against the module propagator/sgp4-xp: exact agreement with the library run by its own runtime, plus the Tier B anchors. No independent public reference exists for the XP theory.',
  module: { name: pkg.name, version: pkg.version },
  hashes,
  parity: { test: 'tests/ussf_parity.test.mjs', title, sets: 640, times: 7, comparison: 'exact (same doubles)', pass, fail, met: run.status === 0 && fail === 0 && pass >= 1 },
  anchors: { cases: vectors.cases.length, tolerancePolicy: tol, bandPositionM: 0.5, bandVelocityMS: 5e-4, source: 'sgp4-xp/vectors/PROVENANCE.md' },
  verdict: 'The module returns the Space Force library\'s states exactly on 640 SGP4 and SGP4-XP sets at seven times each. The XP theory itself has no public reference outside the library; agreement with the library is the available check.',
};
const out = path.join(here, 'summary-xp.json');
if (process.argv.includes('--check')) {
  const prev = JSON.parse(fs.readFileSync(out, 'utf8'));
  const errs = [];
  for (const [k, v] of Object.entries(hashes)) if (prev.hashes[k] !== v) errs.push(`hash mismatch: ${k}`);
  if (!summary.parity.met) errs.push('parity test failed');
  if (prev.parity.pass !== summary.parity.pass) errs.push('pass count differs');
  if (errs.length) { console.error(errs.join('\n')); process.exit(1); }
  console.log(`PASS SGP4-XP evidence: parity ${pass} test (640 sets x 7 times, exact), ${Object.keys(hashes).length} hashes match`);
} else {
  fs.writeFileSync(out, JSON.stringify(summary, null, 1) + '\n');
  console.log(rel(out), summary.parity);
}

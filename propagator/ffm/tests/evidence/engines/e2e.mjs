#!/usr/bin/env node
// The engine benchmark harness end to end on FFM alone: a plan on the
// committed Earth orientation rows (tests/fixtures/resident/eop-2026-08.json),
// one case of each force tier through this checkout's dist/isomorphic/
// module.wasm (run-ffm.mjs) and the tables (score.mjs). It fails unless every
// timed case reports a finite cost and evaluation count and all 73 hourly
// samples. The reference engines' drivers need their installed tools and run
// by hand (README.md).
//
//   node tests/evidence/engines/e2e.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ffm-engines-'));
const node = (script, ...args) => execFileSync(process.execPath, [path.join(here, script), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
try {
  node('plan.mjs', work, '--eop', path.join(here, '../../fixtures/resident/eop-2026-08.json'));
  for (const only of ['GPS COMMON fixed-30s', 'GPS FFM1 tol1e-12-max300s'])
    node('run-ffm.mjs', work, '--only', only, '--reps', '1', '--algorithms', 'RK78', '--out', path.join(work, `ffm-${only.split(' ')[1]}.json`));
  const rows = fs.readdirSync(work).filter((f) => /^ffm-.*\.json$/.test(f)).flatMap((f) => JSON.parse(fs.readFileSync(path.join(work, f), 'utf8')).results);
  const bad = rows.filter((r) => !(r.cpuSPerObjectDay > 0) || !(r.evaluations > 0) || r.samples.length !== 73);
  if (rows.length !== 2 || bad.length) throw new Error(`harness rows invalid: ${JSON.stringify(bad.map((r) => r.id))} of ${rows.length}`);
  fs.renameSync(path.join(work, 'ffm-COMMON.json'), path.join(work, 'ffm.json'));
  const table = node('score.mjs', work);
  if (!table.includes('| FFM RKDP87 |')) throw new Error('score.mjs printed no FFM row');
  console.log(rows.map((r) => `${r.id} ${r.algorithm}: ${r.cpuSPerObjectDay.toFixed(4)} CPU-s/object-day, ${r.evaluations} evaluations`).join('\n'));
} finally { fs.rmSync(work, { recursive: true, force: true }); }

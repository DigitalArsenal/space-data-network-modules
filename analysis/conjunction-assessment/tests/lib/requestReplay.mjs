// Captured-request replay: the module's suites that drive it through
// tests/lib/conjunctionCommandHarness.mjs run with CA_REPLAY_BASE_WASM naming
// another build, so every invoke runs on both builds and the replay report
// (CA_REPLAY_REPORT) compares each answer byte for byte, the instant a CDM is
// created aside (conjunctionCommandHarness.mjs, replayHarness).
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const REPLAY_SUITES = ['altitudePrefilterDecay.e2e.mjs', 'cdmCcsdsConformance.e2e.mjs', 'continuousScreening.test.mjs',
  'cqrAuthoritative.test.mjs', 'cqrStreaming.test.mjs', 'ephemerisUpload.test.mjs', 'gpuScreenParity.test.mjs',
  'lowVelocityCovariance.test.mjs', 'pairWindowTca.e2e.mjs', 'possibilityScreening.test.mjs', 'sampledCoverage.e2e.mjs',
  'sdnDataApiStream.test.mjs', 'sgp4OmmInput.e2e.mjs', 'spanScreening.e2e.mjs', 'windowedScreenParity.test.mjs'];
// Each method must be compared at least this often, so the replay keeps its reach.
export const REPLAY_FLOOR = { screen_catalog: 50, screen_window: 50, prepare_screening_index: 15, assess_conjunction: 40,
  emit_cdm: 25, emit_csm: 10, find_tca: 20, refine_candidates: 10, search_candidates: 40, possibility_of_collision: 5,
  parse_ephemeris: 40 };

// The module's artifact at a commit of this repository, written into dir.
export function artifactAt(packageRoot, commit, dir) {
  const file = path.join(dir, `module-${commit.slice(0, 9)}.wasm`);
  fs.writeFileSync(file, execFileSync('git', ['-C', packageRoot, 'show', `${commit}:analysis/conjunction-assessment/dist/isomorphic/module.wasm`],
    { maxBuffer: 1 << 26 }));
  return file;
}

// The suites run as their own test run (a nested runner would skip them), in
// the browser runtime, against base; resolves the report's rows.
export function replaySuites({ packageRoot, base, dir, suites = REPLAY_SUITES }) {
  const report = path.join(dir, `replay-${path.basename(base, '.wasm')}.jsonl`);
  const env = { ...process.env, CA_REPLAY_BASE_WASM: base, CA_REPLAY_REPORT: report, CQR_TEST_RUNTIME: 'browser' };
  delete env.NODE_TEST_CONTEXT;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...suites.map((s) => path.join('tests', s))],
      { cwd: packageRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let said = '';
    const keep = (chunk) => { said = (said + chunk).slice(-4000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.once('error', reject);
    child.once('exit', () => resolve({ said, rows: fs.existsSync(report)
      ? fs.readFileSync(report, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [] }));
  });
}

// Every request, with GP input or without, answered as base does, and every
// method compared at least its floor; returns a line that says so.
export function assertAllAlike({ rows, said }, baseName) {
  assert.ok(rows.length > 0, `no replay report; the suites said:\n${said}`);
  assert.deepEqual(rows.filter((r) => !r.identical), [], `every request answers as ${baseName} does`);
  const counts = {};
  for (const r of rows) counts[r.methodId] = (counts[r.methodId] ?? 0) + 1;
  for (const [methodId, floor] of Object.entries(REPLAY_FLOOR))
    assert.ok((counts[methodId] ?? 0) >= floor, `${methodId}: ${counts[methodId] ?? 0} requests compared, floor ${floor}`);
  return `${rows.length} requests replayed against ${baseName}, all alike (${rows.filter((r) => r.creationOnly).length} differ only ` +
    `in a CDM's creation instant; ${rows.filter((r) => r.gp).length} take GP input)`;
}

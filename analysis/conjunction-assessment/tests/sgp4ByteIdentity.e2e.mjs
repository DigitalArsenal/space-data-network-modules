// Byte identity of everything that takes no GP input: conjunction-assessment 0.11.0 against 0.10.0 (BASE below).
// 0.11.0 changes only the SGP4 input path: an OMM's values reach SGP4 as published, TLE text goes through the
// module's own field parser, and SGP4/SDP4 is foundation/sgp4-str3 in AFSPC mode. Nothing else may move.
// The module's own suites that drive it through tests/lib/conjunctionCommandHarness.mjs run with
// CA_REPLAY_BASE_WASM naming the 0.10.0 artifact (read from git at BASE), so every invoke runs on both builds; each
// request that takes no GP input (no $OMM record, no mean-element or TLE source, no resident index built from them,
// and not `version`) must answer byte for byte alike, the instant a CDM is created aside (its CREATION_DATE and the
// MESSAGE_ID that names it are the wall clock). GP requests are counted, not compared. A suite's own result does
// not decide this check; the replay report does, with a floor on what it covers.
// Run: node --test tests/sgp4ByteIdentity.e2e.mjs (needs dist/ built and the repository's git history).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..');
const BASE = 'd85ba6e7ade1eb3f387949bf30770c82341b71fc';  // conjunction-assessment 0.10.0, the parent of 0.11.0
const SUITES = ['cdmCcsdsConformance.e2e.mjs', 'pairWindowTca.e2e.mjs', 'cqrAuthoritative.test.mjs', 'cqrStreaming.test.mjs',
  'ephemerisUpload.test.mjs', 'possibilityScreening.test.mjs', 'windowedScreenParity.test.mjs', 'screeningWindowUnion.test.mjs',
  'lowVelocityCovariance.test.mjs', 'empiricalCovariance.test.mjs', 'pairCallsOneInstance.test.mjs', 'continuousScreening.test.mjs',
  'gpuScreenParity.test.mjs', 'sdnDataApiStream.test.mjs'].map((f) => path.join('tests', f));
// Each of these methods must be compared on requests that take no GP input at least this often.
const FLOOR = { assess_conjunction: 5, find_tca: 5, emit_cdm: 5, emit_csm: 5, screen_catalog: 5, compute_pc: 2,
  parse_cdm_kvn: 1, write_cdm_kvn: 1, parse_cdm_xml: 1, write_cdm_xml: 1, compute_pc_from_cdm: 1, parse_ephemeris: 1,
  possibility_of_collision: 1, prepare_screening_index: 1, screen_window: 1 };

test('every request without GP input answers byte for byte as 0.10.0 does', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-byte-identity-'));
  try {
    const base = path.join(work, 'module-0.10.0.wasm'), report = path.join(work, 'replay.jsonl');
    fs.writeFileSync(base, execFileSync('git', ['-C', packageRoot, 'show', `${BASE}:analysis/conjunction-assessment/dist/isomorphic/module.wasm`], { maxBuffer: 1 << 26 }));
    // The suites run as their own test run (a nested runner would skip them), in the browser runtime.
    const env = { ...process.env, CA_REPLAY_BASE_WASM: base, CA_REPLAY_REPORT: report, CQR_TEST_RUNTIME: 'browser' };
    delete env.NODE_TEST_CONTEXT;
    const run = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...SUITES], { cwd: packageRoot, encoding: 'utf8', env, maxBuffer: 1 << 28 });
    assert.ok(fs.existsSync(report), `no replay report; the suites said:\n${(run.stdout + run.stderr).slice(-4000)}`);
    const rows = fs.readFileSync(report, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const differing = rows.filter((r) => !r.gp && !r.identical);
    assert.deepEqual(differing, [], 'requests without GP input answer as 0.10.0 does');
    const counts = {};
    for (const r of rows) {
      const c = (counts[r.methodId] ??= { compared: 0, gp: 0, gpMoved: 0 });
      if (r.gp) { c.gp += 1; if (!r.identical) c.gpMoved += 1; } else c.compared += 1;
    }
    for (const [methodId, floor] of Object.entries(FLOOR))
      assert.ok((counts[methodId]?.compared ?? 0) >= floor, `${methodId}: ${counts[methodId]?.compared ?? 0} requests without GP input compared, floor ${floor}`);
    console.log(`${rows.length} requests replayed against 0.10.0 (${BASE.slice(0, 9)}): ` +
      `${rows.filter((r) => !r.gp).length} without GP input, all alike (${rows.filter((r) => !r.gp && r.creationOnly).length} differ only in a CDM's creation instant); ` +
      `${rows.filter((r) => r.gp).length} with GP input, ${rows.filter((r) => r.gp && !r.identical).length} of them moved`);
    for (const [methodId, c] of Object.entries(counts).sort())
      console.log(`  ${methodId}: ${c.compared} identical without GP input; ${c.gp} with GP input (${c.gpMoved} moved)`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

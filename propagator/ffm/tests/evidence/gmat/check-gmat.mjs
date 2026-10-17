#!/usr/bin/env node
// ONE E2E: both tables, available hashes and measured causes, then ONE shipped
// WASM LEO400 F0 propagation scored against both stored GMAT trajectories.
// Source/units/frame/epoch/limits and replay rounding rationale: summary.protocol.
// node tests/evidence/gmat/check-gmat.mjs [R2026a-summary] [R2022a-summary]
import fs from 'node:fs';
import path from 'node:path';
import { ALL, CASES, here, readJson, sha256, buildMetrics, causeFor, verdictFor, sourceFiles,
  externalSources, run, scoreResponse } from './evidence.mjs';

const errors = [], verified = new Set(), unavailable = new Set(), unlocated = new Set();
const check = (condition, message) => { if (!condition) errors.push(message); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const nonempty = (x) => typeof x === 'string' && x.trim().length > 0;
const digest = (x) => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);
const measuredCause = (x) => nonempty(x?.classification) && nonempty(x?.statement)
  && x.evidence && Object.keys(x.evidence).length > 0;
const hashes = new Map(), knownDigests = new Set();
function verify(file, checksum, label, required = false) {
  if (!nonempty(file) || !digest(checksum)) { check(false, `${label}: invalid file/hash pin`); return; }
  const resolved = path.resolve(here, file);
  if (!hashes.has(resolved)) hashes.set(resolved, fs.existsSync(resolved) ? sha256(resolved) : null);
  const actual = hashes.get(resolved);
  if (actual === null) {
    if (required) check(false, `${label}: required file unavailable`);
    else unavailable.add(resolved);
  } else {
    check(actual === checksum, `${label}: SHA-256 mismatch in ${file}`);
    if (actual === checksum) { verified.add(resolved); knownDigests.add(checksum); }
  }
}
function visitPins(value, label) {
  if (!value || typeof value !== 'object') return;
  if ('sha256' in value && ('path' in value || 'file' in value)) verify(value.path ?? value.file, value.sha256, label);
  for (const [key, child] of Object.entries(value)) {
    if (/sha256$/i.test(key) && typeof child === 'string') {
      check(digest(child), `${label}.${key}: invalid SHA-256`);
      if (!knownDigests.has(child)) unlocated.add(`${label}.${key}`);
    } else visitPins(child, `${label}.${key}`);
  }
}
function inspect(file, release, metrics, oxygen, derived) {
  const summary = readJson(file), record = readJson(summary.gmat.file);
  verify(summary.gmat.file, summary.gmat.sha256, `${release} trajectory`, true);
  verify('../../../dist/isomorphic/module.wasm', summary.module?.sha256, `${release} shipped WASM`, true);
  verify('../cases/ffm-reference-cases.json', record.caseExportSha256, `${release} exported cases`, true);
  check(summary.module?.version === readJson('../../../package.json').version, `${release}: module version mismatch`);
  check(same(summary.gmat.tool, record.tool) && same(summary.gmat.settings, record.settings), `${release}: source metadata mismatch`);
  check(same(summary.settings, ALL), `${release}: FFM settings mismatch`);
  check(same(summary.tolerancesM, CASES.protocol.tolerancesM.gmat), `${release}: protocol tolerances/note changed`);
  check(summary.protocol?.replayToleranceM === 0 && nonempty(summary.protocol?.replayToleranceRationale)
    && summary.protocol?.timeScale === 'UTC' && nonempty(summary.protocol?.toleranceRationale), `${release}: numerical protocol missing`);
  check(summary.fileHashes?.length > 0, `${release}: fileHashes missing`);
  for (const pin of summary.fileHashes ?? []) verify(pin.path, pin.sha256, `${release} fileHashes`, true);
  for (const file of [...sourceFiles, ...externalSources.map((x) => x.path)]) {
    const pin = summary.provenance?.sourceIdentity?.find((p) => p.path === file);
    check(pin, `${release}: missing source pin ${file}`);
    if (pin) verify(pin.path, pin.sha256, `${release} source ${file}`, !path.isAbsolute(file));
  }
  for (const pin of summary.provenance?.historicalArtifacts ?? []) verify(pin.path, pin.sha256, `${release} historical artifact`);
  check(same(summary.provenance?.inputFiles, record.inputFiles), `${release}: input-file pins differ from source record`);
  if (summary.gmat.stmFile) {
    const stored = summary.provenance?.historicalArtifacts?.find((pin) => pin.role === 'stored STM trajectory');
    check(stored?.sha256 === summary.gmat.stmSha256, `${release}: STM alias hash mismatch`);
    verify(summary.gmat.stmFile, summary.gmat.stmSha256, `${release} STM local alias`);
  }
  const rows = summary.cases ?? [], skipped = summary.skipped ?? [];
  const covered = [...rows, ...skipped].map((r) => r.id);
  const expected = new Set(CASES.cases.map((r) => r.id));
  check(expected.size === 72 && covered.length === 72 && new Set(covered).size === 72
    && covered.every((id) => expected.has(id)), `${release}: missing/duplicate case in scored/skipped table`);
  check(same(rows.map((r) => r.id), record.cases.map((r) => r.id)), `${release}: scored cases differ from trajectory`);
  check(same(skipped, record.skipped) && skipped.every((r) => nonempty(r.reason)), `${release}: skipped cases/reasons mismatch`);
  for (const row of rows) {
    const source = CASES.cases.find((r) => r.id === row.id);
    check(row.toleranceClass === source?.toleranceClass && row.toleranceM === CASES.protocol.tolerancesM.gmat[source?.toleranceClass], `${row.id}: invalid limit`);
    for (const key of ['suite', 'steps30', 'finest']) {
      const score = row[key];
      check(Number.isFinite(score?.worstM) && score.worstM >= 0 && Number.isInteger(score?.atHour)
        && score.atHour >= 1 && score.atHour <= 24 && Number.isInteger(score?.steps) && score.steps > 0, `${row.id} ${key}: invalid score`);
      check(typeof score?.met === 'boolean' && score.met === (score.worstM <= row.toleranceM), `${row.id} ${key}: inconsistent met flag`);
      if (score?.met === false) check(measuredCause(row.cause), `${row.id} ${key}: met:false without measured cause`);
    }
    check(typeof row.met === 'boolean' && row.met === row.suite?.met, `${row.id}: row verdict is not suite verdict`);
    if (row.met === false) {
      const measured = oxygen.rows.find((r) => r.id === row.id), calculation = derived.find((r) => r.id === row.id);
      check(release === 'R2026a' && measured && calculation, `${row.id}: unexpected undiagnosed miss`);
      if (measured && calculation) check(same(row.cause, causeFor(measured, calculation)), `${row.id}: density cause/correction differs from measured evidence`);
    }
    if (release === 'R2026a') check(Number.isFinite(row.stm?.worst) && row.stm.worst >= 0, `${row.id}: missing STM comparison`);
  }
  check(rows.length === (release === 'R2026a' ? 57 : 55), `${release}: wrong scored case count`);
  check(same(summary.verdict, verdictFor(summary, release, metrics)), `${release}: top-level verdict differs from rows`);
  visitPins(summary, release); visitPins(record, `${release} trajectory`);
  console.log(`${release}: ${rows.length} scored + ${skipped.length} skipped = ${covered.length}; ${rows.filter((r) => r.met).length} meet suite limits; ${rows.filter((r) => !r.met).length} misses, ${rows.filter((r) => !r.met && measuredCause(r.cause)).length} with causes; ${rows.filter((r) => r.stm).length} STM comparisons.`);
  return { summary, record, release };
}
async function main() {
  const work = fs.mkdtempSync(path.join(here, '.check-gmat-'));
  try {
    const metrics = buildMetrics(work), oxygen = readJson('anomalous-oxygen.json');
    const derived = metrics({ mode: 'density', rows: oxygen.rows });
    const tables = [inspect(process.argv[2] ?? 'summary-gmat-R2026a.json', 'R2026a', metrics, oxygen, derived),
      inspect(process.argv[3] ?? 'summary-gmat-R2022a.json', 'R2022a', metrics, oxygen, derived)];
    console.log(`Hashes: ${verified.size} available pinned files verified; ${unavailable.size} unavailable historical/alias paths; ${unlocated.size} unlocated historical hash declarations recorded.`);
    console.log(`Density: ${derived.filter((r) => r.correctedMet).length}/6 Cd-scaled diagnostics meet 1.5 m; ${derived.filter((r) => r.correctedDefaultMet).length}/6 meet 0.1 m (SSO700 residuals remain above 0.1 m).`);
    const id = 'LEO400 F0-point-mass', cheap = tables[0].record.cases.find((r) => r.id === id);
    const response = await run(cheap, ALL[0]);
    for (const { summary, record, release } of tables) {
      const source = record.cases.find((r) => r.id === id), expected = summary.cases.find((r) => r.id === id)?.suite;
      if (!source || !expected) throw new Error(`${release}: missing point-mass score`);
      const actual = scoreResponse(response, source, metrics);
      const replay = metrics({ mode: 'replay-match', actual, expected });
      check(replay.met, `${release}: re-score mismatch for ${id}`);
      console.log(`Re-score ${release}: ${id}, worstM=${actual.worstM}, atHour=${actual.atHour}, steps=${actual.steps}; ${replay.met ? 'exact match' : 'MISMATCH'}.`);
    }
    console.log('Propagation: one LEO400 point-mass run through shipped FFM WASM; numerical reductions in C++.');
  } catch (error) { errors.push(error.message); }
  finally { fs.rmSync(work, { recursive: true, force: true }); }
  for (const error of errors) console.log(`FAIL: ${error}`);
  console.log(`${errors.length ? 'FAIL' : 'PASS'} GMAT evidence E2E: ${errors.length} failure(s).`);
  process.exitCode = errors.length ? 1 : 0;
}
await main();

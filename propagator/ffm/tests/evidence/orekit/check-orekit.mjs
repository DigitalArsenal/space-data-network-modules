#!/usr/bin/env node
// Authenticates the stored Orekit trajectory and replays ONE cheap case.
// Source: Orekit 13.1 fixture, GCRF, hourly UTC samples on 2026-08-02.
// Metric: maximum 3D position difference in SI meters; physical tolerance
// is the shared export's pointMass limit. Replay tolerance is zero because
// the WASM, request, fixture and C++ reduction are identical to the refresh.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';
import { REFERENCE, requestInputs } from '../../lib/orekitCases.mjs';
import { buildMetrics, scoreResponse } from './scoring.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const errors = [];
const check = (condition, message) => { if (!condition) errors.push(message); };
async function main() {
  const summary = JSON.parse(fs.readFileSync(process.argv[2] ?? path.join(here, 'summary.json'), 'utf8'));
  const work = fs.mkdtempSync(path.join(here, '.check-orekit-'));
  process.on('exit', () => fs.rmSync(work, { recursive: true, force: true }));
  const metrics = buildMetrics(work);
  const exported = JSON.parse(fs.readFileSync(path.join(here, '../cases/ffm-reference-cases.json'), 'utf8'));
  const wasmPath = path.resolve(here, '../../../dist/isomorphic/module.wasm');
  check(summary.module?.sha256 === hash(wasmPath), 'shipped FFM WASM hash differs');
  check(summary.module?.version === JSON.parse(fs.readFileSync(path.resolve(here, '../../../package.json'), 'utf8')).version, 'FFM package version differs');
  check(summary.orekit?.version === '13.1' && REFERENCE.source.includes('Orekit 13.1 '), 'Orekit version pin differs');
  check(summary.orekit?.sourcePin?.kind === 'reference-generator-source', 'missing source pin kind');
  check(hash(path.resolve(here, summary.orekit.sourcePin.path)) === summary.orekit.sourcePin.sha256, 'Orekit generator source hash differs');
  check(summary.orekit?.engineBinary?.status === 'unavailable' && summary.orekit.engineBinary.reason?.length > 0, 'missing engine-binary availability record');
  check(summary.fileHashes?.some((f) => f.path === '../../fixtures/orekit/orekit-reference.json'), 'reference trajectory hash missing');
  for (const file of summary.fileHashes ?? []) check(/^[0-9a-f]{64}$/.test(file.sha256) && hash(path.resolve(here, file.path)) === file.sha256, `hash differs: ${file.path}`);
  const ids = new Set(exported.cases.map((c) => c.id));
  const covered = [...summary.cases, ...summary.skipped].map((c) => c.id);
  check(ids.size === 72 && covered.length === 72 && new Set(covered).size === 72 && covered.every((id) => ids.has(id)), 'scored/skipped coverage differs from 72-case export');
  for (const setting of summary.settings) {
    const numeric = metrics({ mode: 'verdict', values: summary.cases.map((row) => row[setting.id].worstM), limits: summary.cases.map((row) => exported.protocol.tolerancesM.default[exported.cases.find((c) => c.id === row.id).toleranceClass]) });
    for (const [index, row] of summary.cases.entries()) {
      const score = row[setting.id], passed = numeric.flags[index];
      check(score.met === passed, `${row.id}: inconsistent ${setting.id} met flag`);
      if (!passed) check(Boolean(row.cause?.statement && row.cause?.evidence), `${row.id}: miss lacks a cause`);
    }
    const verdict = summary.verdict?.[setting.id];
    check(verdict?.total === numeric.total && verdict.met === numeric.met && verdict.missed === numeric.missed, `${setting.id}: verdict counts differ`);
  }
  console.log(`Hashes: FFM WASM and ${summary.fileHashes.length} input/source files verified; Orekit engine archive unavailable (reason recorded).`);
  console.log(`Coverage: ${summary.cases.length} scored + ${summary.skipped.length} skipped = ${covered.length}; suite ${summary.verdict.suite.met} met, ${summary.verdict.suite.missed} missed.`);
  const cheap = REFERENCE.cases.find((c) => `${c.orbit} ${c.forces}` === 'LEO400 F0-point-mass');
  const expected = summary.cases.find((c) => c.id === 'LEO400 F0-point-mass').suite;
  let harness;
  try {
    harness = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(wasmPath), manifest: JSON.parse(fs.readFileSync(path.resolve(here, '../../../plugin-manifest.json'), 'utf8')), surface: 'direct' });
    const response = await harness.invoke({ methodId: 'invoke', inputs: requestInputs(cheap, { maxStep: 300 }) });
    if (response.statusCode !== 0) throw new Error(response.errorMessage);
    const actual = scoreResponse(cheap, response, metrics);
    for (const key of ['worstM', 'atHour', 'steps']) check(actual[key] === expected[key], `LEO400 F0 ${key} differs: ${actual[key]} vs ${expected[key]}`);
    console.log(`Re-score: LEO400 F0-point-mass, suite: worstM=${actual.worstM}, atHour=${actual.atHour}, steps=${actual.steps}; ${['worstM', 'atHour', 'steps'].every((k) => actual[k] === expected[k]) ? 'exact match' : 'MISMATCH'}.`);
  } finally { harness?.destroy(); fs.rmSync(work, { recursive: true, force: true }); }
  for (const error of errors) console.error(`FAIL: ${error}`);
  console.log(`${errors.length ? 'FAIL' : 'PASS'} Orekit evidence E2E: ${errors.length} failure(s).`);
  process.exitCode = errors.length ? 1 : 0;
}
await main().catch((error) => { console.error(`FAIL Orekit evidence E2E: ${error.message}`); process.exitCode = 1; });

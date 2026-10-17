#!/usr/bin/env node
// The ONE E2E for this evidence change. It authenticates both input sets,
// verifies all 72 scored/skipped IDs, recomputes every stored position/STM
// reduction in C++, then runs just LEO400 point mass once in shipped FFM
// WASM and reproduces both suite scores from that one response.
// Source: independent Tudat trajectories; SI meters, each case's GCRF or
// EME2000 axes, 2026-08-02 UTC for 24 h. Physical limits are the unchanged
// shared export protocol. Replay tolerance is exactly zero: identical bytes,
// FFM settings, and C++ reduction. Native half-step limit is 0.3 mm.
// node tests/evidence/tudat/check-tudat.mjs [native-summary] [wasm-summary]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL, CASES, WASM, here, exportPath, sha256, readJson, normalizedRecord,
  buildMetrics, run, scoreResponse, scoreStored, scoreOrekit, scoreConvergence,
  scoreStm, parametersOfExtended, stmLimitation, protocolFor, causePresent, verdictFor } from './scoring.mjs';

const errors = [];
const check = (value, message) => { if (!value) errors.push(message); };
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const digest = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const verified = new Set();
const missing = new Set();
const checked = new Map();

function verifyFile(file, checksum, label, required = false) {
  if (!nonempty(file) || !digest(checksum)) { check(false, `${label}: missing path or invalid SHA-256`); return; }
  const resolved = path.resolve(here, file);
  if (!checked.has(resolved)) checked.set(resolved, fs.existsSync(resolved) ? sha256(resolved) : null);
  const actual = checked.get(resolved);
  if (actual === null) {
    if (required) check(false, `${label}: required file is unavailable: ${file}`);
    else missing.add(resolved);
  } else {
    check(actual === checksum, `${label}: SHA-256 mismatch: ${file}`);
    if (actual === checksum) verified.add(resolved);
  }
}

function visitPins(value, label) {
  if (!value || typeof value !== 'object') return;
  if ('sha256' in value && ('path' in value || 'file' in value)) verifyFile(value.path ?? value.file, value.sha256, label);
  for (const [key, item] of Object.entries(value)) {
    if (/sha256$/i.test(key) && typeof item === 'string') check(digest(item), `${label}.${key}: invalid SHA-256`);
    else visitPins(item, `${label}.${key}`);
  }
}

function exactFields(actual, expected, keys, label) {
  for (const key of keys) check(same(actual?.[key], expected?.[key]), `${label}: re-score mismatch in ${key}: expected ${JSON.stringify(expected?.[key])}, got ${JSON.stringify(actual?.[key])}`);
}

function scoreValid(score, limit, cause, label) {
  check(Number.isFinite(score?.worstM) && score.worstM >= 0 && score.sampleCount === 24
    && Number.isInteger(score.atHour) && score.atHour >= 1 && score.atHour <= 24
    && Number.isInteger(score.steps) && score.steps > 0, `${label}: invalid score`);
  check(typeof score?.met === 'boolean' && score.met === (score.worstM <= limit), `${label}: incorrect met flag`);
  if (score?.met === false) check(causePresent(cause), `${label}: met:false lacks a measured model-setting mismatch / Tudat defect / FFM defect cause`);
}

function inspectSummary(summaryPath, wasm, metrics) {
  const label = wasm ? 'Tudat WASM' : 'tudatpy 1.0.0';
  const summary = readJson(summaryPath);
  const recordPath = path.resolve(here, summary.tudat?.file ?? 'MISSING');
  const record = normalizedRecord(recordPath, wasm);
  verifyFile(recordPath, summary.tudat?.sha256, `${label} trajectory`, true);
  verifyFile(exportPath, summary.tudat?.caseExportSha256, `${label} shared case export`, true);
  verifyFile(fileURLToPath(WASM), summary.module?.sha256, `${label} shipped FFM WASM`, true);
  check(summary.module?.version === readJson(path.resolve(here, '../../../package.json')).version, `${label}: FFM package version mismatch`);
  check(same(summary.settings, ALL), `${label}: FFM settings mismatch`);
  check(same(summary.tolerancesM, CASES.protocol.tolerancesM.default), `${label}: shared tolerances were changed`);
  check(same(summary.tudat?.tool, record.tool), `${label}: tool metadata differs from stored trajectory`);
  check(same(summary.tudat?.settings, record.settings), `${label}: settings differ from stored trajectory`);
  check(same(summary.tudat?.inputFiles, record.inputFiles), `${label}: input-file provenance differs from stored trajectory`);
  for (const entry of summary.fileHashes ?? []) verifyFile(entry.path, entry.sha256, `${label} fileHashes`);
  for (const entry of record.inputFiles ?? []) {
    check((summary.fileHashes ?? []).some((pin) => path.resolve(here, pin.path) === path.resolve(here, entry.path)
      && pin.sha256 === entry.sha256), `${label}: runner input pin is absent from fileHashes: ${entry.path}`);
  }
  check(summary.fileHashes?.length > 0 && summary.provenance?.sourceIdentity?.length >= 5, `${label}: source-hash provenance is missing`);
  const sourceIdentity = Array.isArray(summary.provenance?.sourceIdentity) ? summary.provenance.sourceIdentity : [];
  const requiredSources = ['scoring.mjs', 'score-tudat.mjs', 'check-tudat.mjs', '../nyx/scoring.mjs', '../nyx/score-metrics.cpp',
    ...(wasm ? ['../../fixtures/tudat/tudat_wasm_driver.cpp', '../../fixtures/tudat/tudat-wasm-reference.mjs']
      : ['run-tudat.py', 'tudat-support.cpp', 'tudat-settings.cpp'])];
  for (const source of requiredSources) {
    const resolved = path.resolve(here, source);
    const entry = sourceIdentity.find((item) => nonempty(item.path) && path.resolve(here, item.path) === resolved);
    check(entry, `${label}: required repository source pin is missing: ${source}`);
    if (entry) verifyFile(entry.path, entry.sha256, `${label} required source ${source}`, true);
  }
  const repositoryRoot = path.resolve(here, '../../../../..');
  for (const entry of sourceIdentity) {
    if (!nonempty(entry.path)) { check(false, `${label}: sourceIdentity entry has no path`); continue; }
    const relative = path.relative(repositoryRoot, path.resolve(here, entry.path));
    const repositorySource = relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      && !relative.split(path.sep).includes('.work');
    verifyFile(entry.path, entry.sha256, `${label} sourceIdentity`, repositorySource);
  }
  visitPins(summary, label);
  visitPins(record, `${label} source`);
  const cachePin = summary.provenance?.ffmTrajectories;
  verifyFile(cachePin?.path, cachePin?.sha256, `${label} FFM trajectory cache`, true);
  const cache = readJson(path.resolve(here, cachePin.path));
  check(same(cache.identity, summary.provenance?.propagationInputs), `${label}: cached propagation identity mismatch`);
  for (const item of cache.identity ?? []) verifyFile(item.path, item.sha256, `${label} FFM input`, true);
  let fine = null, stm = null;
  if (!wasm) {
    const finePath = path.resolve(here, summary.tudat?.fineFile ?? 'MISSING');
    verifyFile(finePath, summary.tudat?.fineSha256, 'Tudat half-step trajectory', true);
    fine = normalizedRecord(finePath);
    check(same(record.cases.map((c) => c.id), fine.cases.map((c) => c.id)), 'Tudat base/fine case IDs differ');
    check(fine.caseExportSha256 === record.caseExportSha256, 'Tudat base/fine export pins differ');
    const metadata = JSON.stringify(record.tool);
    check((record.tool?.version ?? record.tool?.tudatpy) === '1.0.0' && metadata.includes('py311h2196d89_3') && metadata.includes('2.4'),
      'Tudat version/build/resources pins are missing or incorrect');
    const kernelPin = record.inputFiles?.find((entry) => path.basename(entry.path) === 'kernel.so');
    check(kernelPin && kernelPin.sha256 === record.tool?.kernelSha256
      && kernelPin.sha256 === '18196bbc8fc5aaf77e2b990012bae60325ca15ad6062048c0bed23e874faf672',
    'Tudat relocated installed kernel hash differs from the pinned conda build or tool metadata');
  } else {
    check(record.cases.length === 27, 'Tudat WASM committed fixture contains 27 cases (the task context says 28)');
    check(summary.provenance?.fixtureCoverage?.requestedCount === 28 && summary.provenance?.fixtureCoverage?.actualCount === 27
      && same(summary.provenance.fixtureCoverage, record.settings.coverage), 'Tudat WASM 28-requested/27-stored coverage discrepancy must be recorded');
    check(summary.provenance?.packageCommit === '1d4718f' && summary.provenance?.emscripten === '3.1.51'
      && nonempty(summary.provenance?.apiLimitation), 'Tudat WASM pins or Embind limitation are missing');
  }
  if (summary.tudat?.stmFile) {
    const file = path.resolve(here, summary.tudat.stmFile);
    verifyFile(file, summary.tudat.stmSha256, 'Tudat STM trajectory', true);
    stm = readJson(file);
    check(stm.caseExportSha256 === record.caseExportSha256, 'Tudat state/STM export pins differ');
  }
  const expected = new Set(CASES.cases.map((c) => c.id));
  const rows = summary.cases ?? [];
  const skipped = summary.skipped ?? [];
  check(same(summary.protocol, protocolFor(rows, wasm)), `${label}: source/units/frame/epoch/tolerance protocol metadata differs from the shared export`);
  const covered = [...rows, ...skipped].map((c) => c.id);
  check(expected.size === 72 && covered.length === expected.size && new Set(covered).size === expected.size
    && covered.every((id) => expected.has(id)), `${label}: table must cover every one of the 72 cases exactly once`);
  check(same(rows.map((r) => r.id), record.cases.map((c) => c.id)), `${label}: table/source trajectory case IDs differ`);
  check(same(skipped, record.skipped) && skipped.every((row) => nonempty(row.reason)), `${label}: skipped IDs/reasons differ from source`);
  check(same(cache.cases.map((c) => c.id).sort(), rows.map((c) => c.id).sort()), `${label}: cache case IDs differ from summary`);
  if (!wasm) {
    // Derive the supported set from force requirements, independently of the
    // runner's scored/skipped declarations. A diagnostic --no-stm run or an
    // arbitrary unsupported claim cannot silently shrink the final evidence.
    const supported = CASES.cases.filter(({ forces }) => !forces.solidTides && !forces.oceanTides
      && !forces.earthRadiation && (!forces.drag || forces.drag.atmosphere === 'NRLMSISE00'));
    const expectedNativeIds = supported.map((entry) => entry.id).sort();
    const expectedStmIds = supported.filter(({ forces }) => forces.relativity !== 'iers2010').map((entry) => entry.id).sort();
    check(expectedNativeIds.length === 59 && same(rows.map((row) => row.id).sort(), expectedNativeIds),
      'Native Tudat evidence must score the exact 59 cases its configured force models support');
    check(expectedStmIds.length === 57 && same((stm?.cases ?? []).map((entry) => entry.id).sort(), expectedStmIds)
      && same(rows.filter((row) => row.stm).map((row) => row.id).sort(), expectedStmIds),
    'Native Tudat evidence must contain exactly the 57 supported STM records and comparisons');
  }
  for (const row of rows) {
    const source = record.cases.find((c) => c.id === row.id);
    const exported = CASES.cases.find((c) => c.id === row.id);
    const stored = cache.cases.find((c) => c.id === row.id);
    if (!source || !exported || !stored) { check(false, `${label} ${row.id}: missing source/cache/export case`); continue; }
    check(row.orbit === exported.orbit && row.forceSet === exported.forceSet && row.row === exported.row
      && row.toleranceClass === exported.toleranceClass, `${label} ${row.id}: exported case metadata mismatch`);
    check(row.toleranceM === CASES.protocol.tolerancesM.default[exported.toleranceClass], `${label} ${row.id}: tolerance changed`);
    for (const setting of ALL) {
      scoreValid(row[setting.id], row.toleranceM, row.cause, `${label} ${row.id} ${setting.id}`);
      exactFields(scoreStored(stored[setting.id], source, metrics), row[setting.id], ['worstM', 'atHour', 'sampleCount', 'steps'], `${label} ${row.id} ${setting.id}`);
    }
    check(row.met === row.suite.met, `${label} ${row.id}: row verdict must equal suite verdict`);
    exactFields(scoreOrekit(source, metrics), row.orekitMinusTudat, ['worstM', 'atHour', 'sampleCount'], `${label} ${row.id} Orekit-minus-Tudat`);
    if (fine) {
      const measured = scoreConvergence(source, fine.cases.find((c) => c.id === row.id), metrics);
      exactFields(measured, row.convergence, ['worstM', 'atHour', 'sampleCount'], `${label} ${row.id} convergence`);
      check(row.convergence?.limitM === 0.0003 && row.convergence?.met === true && measured.worstM < 0.0003,
        `${label} ${row.id}: half-step convergence exceeds 0.3 mm`);
    }
    const referenceStm = stm?.cases.find((c) => c.id === row.id);
    check(Boolean(row.stm) === Boolean(referenceStm), `${label} ${row.id}: source/summary STM coverage differs`);
    check(row.stmSkipped === source.stmSkipped, `${label} ${row.id}: missing or altered STM omission reason`);
    check(Boolean(referenceStm) || nonempty(row.stmSkipped), `${label} ${row.id}: missing STM comparison without a recorded reason`);
    if (!wasm) {
      if (exported.forces.relativity === 'iers2010') {
        check(!referenceStm && !row.stm && nonempty(row.stmSkipped)
          && /Schwarzschild|Lense[- ]Thirring|de Sitter/i.test(row.stmSkipped)
          && /only|unavailable|unsupported|not implemented|throws/i.test(row.stmSkipped),
        `${label} ${row.id}: R2 STM omission must state the unavailable native non-Schwarzschild partials`);
      } else {
        check(referenceStm && row.stm && row.stmSkipped === undefined && source.stmSkipped === undefined,
          `${label} ${row.id}: a supported native STM cannot be omitted or marked stmSkipped`);
      }
    }
    if (referenceStm) {
      const mapped = parametersOfExtended(source);
      const names = new Set(mapped.map(([parameter]) => parameter));
      check((exported.sensitivities?.parameters ?? []).every((parameter) => names.has(parameter)),
        `${label} ${row.id}: exported sensitivity is missing from the FFM mapping`);
      check(same(row.stm.parameterColumns, mapped) && same(stored.suiteStm?.parameterColumns, mapped),
        `${label} ${row.id}: summary/cache STM parameter mapping differs from the export`);
      for (const [parameter, key] of mapped) {
        check(referenceStm.stm?.length === 25 && referenceStm.stm.every((sample) => Array.isArray(sample[key])
          && sample[key].length === 6 && sample[key].every(Number.isFinite)),
        `${label} ${row.id}: native ${parameter} sensitivity column ${key} is missing or invalid`);
      }
      exactFields(scoreStm(stored.suiteStm, source, referenceStm, metrics), row.stm,
        ['worst', 'atHour', 'sampleCount', 'parameters'], `${label} ${row.id} STM`);
      check(same(row.stm.limitation, stmLimitation(source, row.stm, record.inputFiles)),
        `${label} ${row.id}: native SRP-partial limitation or its measured evidence is missing/altered`);
      check(!('met' in row.stm) && nonempty(row.stm.agreement), `${label} ${row.id}: STM needs an agreement statement without an invented tolerance`);
      if (row.stm.agreement === 'disagrees') check(nonempty(row.stm.cause), `${label} ${row.id}: STM disagreement requires its cause`);
    }
  }
  check(same(summary.verdict, verdictFor(rows, skipped, record.tool)), `${label}: top-level verdict differs from measured rows`);
  const misses = rows.filter((row) => row.met === false);
  console.log(`${label}: ${rows.length} scored + ${skipped.length} skipped = ${covered.length}; ${misses.length} suite misses, ${misses.filter((row) => causePresent(row.cause)).length} diagnosed; ${rows.filter((row) => row.stm).length} STM comparisons; all stored scores rechecked.`);
  return { summary, record, label };
}

async function main() {
  const work = fs.mkdtempSync(path.join(here, '.check-tudat-'));
  try {
    const metrics = buildMetrics(work);
    const nativePath = path.resolve(process.argv[2] ?? path.join(here, 'summary-tudatpy-1.0.0.json'));
    const wasmPath = path.resolve(process.argv[3] ?? path.join(here, 'summary-tudat-wasm.json'));
    const inspected = [inspectSummary(nativePath, false, metrics), inspectSummary(wasmPath, true, metrics)];
    console.log(`Hashes: ${verified.size} available pinned files verified; ${missing.size} unavailable historical/package files recorded.`);
    const id = 'LEO400 F0-point-mass';
    const cheap = inspected[0].record.cases.find((c) => c.id === id);
    if (!cheap) throw new Error('LEO400 point-mass trajectory is missing');
    const response = await run(cheap, ALL[0]);
    for (const { summary, record, label } of inspected) {
      const source = record.cases.find((c) => c.id === id);
      const expected = summary.cases.find((c) => c.id === id)?.suite;
      if (!source || !expected) throw new Error(`${label}: point-mass suite score missing`);
      const actual = scoreResponse(response, source, metrics);
      exactFields(actual, expected, ['worstM', 'atHour', 'sampleCount', 'steps'], `${label} one-run WASM replay`);
      console.log(`Re-score ${label}: ${id}, suite worstM=${actual.worstM}, atHour=${actual.atHour}, steps=${actual.steps}; ${['worstM', 'atHour', 'sampleCount', 'steps'].every((key) => actual[key] === expected[key]) ? 'exact match' : 'MISMATCH'}.`);
    }
    console.log('Propagation: one LEO400 point-mass run through the shipped FFM WASM.');
  } catch (error) { errors.push(error.message); }
  finally { fs.rmSync(work, { recursive: true, force: true }); }
  for (const error of errors) console.log(`FAIL: ${error}`);
  console.log(`${errors.length ? 'FAIL' : 'PASS'} Tudat evidence E2E: ${errors.length} failure(s).`);
  process.exitCode = errors.length ? 1 : 0;
}

await main();

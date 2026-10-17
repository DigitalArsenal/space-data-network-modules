#!/usr/bin/env node
// One E2E for the Nyx evidence table: authenticate its inputs and provenance,
// require a cause for every missed limit, then propagate LEO400 point mass
// once with the shipped WASM and reproduce its suite score exactly. All
// numerical scoring is performed by the shared C++ metrics executable.
// Source: the stock Nyx 2.6.0 independent trajectory in nyx-2.6.0.json,
// using ffm-reference-cases.json's LEO400 F0 initial state and constants.
// Metric: maximum 3D position difference in meters, GCRF, hourly samples
// during 2026-08-02 UTC. The physical limit is protocol.tolerancesM.default
// .pointMass; replay tolerance is zero because the WASM, input bytes,
// integration settings and C++ reduction are identical to the summary run.
//
//   node tests/evidence/nyx/check-nyx.mjs [summary.json]
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ALL, CASES, buildMetrics, run, scoreResponse } from './scoring.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const summaryPath = path.resolve(process.argv[2] ?? path.join(here, 'summary-nyx-2.6.0.json'));
const recordPath = path.join(here, 'nyx-2.6.0.json');
const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const digest = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const errors = [];
const check = (condition, message) => { if (!condition) errors.push(message); };
const causePresent = (cause) => cause && nonempty(cause.classification) && nonempty(cause.statement)
  && cause.evidence && typeof cause.evidence === 'object' && Object.keys(cause.evidence).length > 0;
function checkScore(score, limit, label, cause) {
  check(score && Number.isFinite(score.worstM) && score.worstM >= 0
    && Number.isFinite(score.atHour) && score.atHour > 0 && score.atHour <= 24
    && Number.isInteger(score.steps) && score.steps > 0, `${label}: invalid score`);
  check(typeof score?.met === 'boolean' && score.met === (score.worstM <= limit), `${label}: inconsistent met flag`);
  if (score?.met === false) check(causePresent(cause), `${label}: missed limit lacks a measured cause`);
}

async function main() {
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  const nyx = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  const verified = new Set();
  const verifiedFiles = new Set();
  const checkedFiles = new Map();
  const gaps = new Set();
  function verifyFile(file, checksum, label) {
    if (!nonempty(file) || !nonempty(checksum)) { gaps.add(label); return; }
    check(digest(checksum), `invalid SHA-256: ${label}`);
    if (!digest(checksum)) return;
    const resolved = path.resolve(here, file);
    let actual = checkedFiles.get(resolved);
    if (actual === undefined) {
      try { actual = hash(resolved); }
      catch (error) {
        if (error.code === 'ENOENT') actual = null;
        else { errors.push(`cannot read ${label}: ${error.message}`); return; }
      }
      checkedFiles.set(resolved, actual);
    }
    // Some evidence names (for example a BPC basename) alias a file already
    // verified at its full path in fileHashes. That is not a missing artifact.
    if (actual === null) { if (!verified.has(checksum)) gaps.add(label); return; }
    check(actual === checksum, `SHA-256 mismatch: ${label}; expected ${checksum}, got ${actual}`);
    if (actual === checksum) { verified.add(actual); verifiedFiles.add(resolved); }
  }
  function recordedHash(checksum, label) {
    if (!nonempty(checksum)) { gaps.add(label); return; }
    check(digest(checksum), `invalid SHA-256: ${label}`);
    if (digest(checksum) && !verified.has(checksum)) gaps.add(label);
  }
  if (!summary.fileHashes?.length) gaps.add('fileHashes');
  for (const entry of summary.fileHashes ?? []) {
    verifyFile(entry.path, entry.sha256, entry.path ?? 'unnamed fileHashes entry');
  }
  const wasmPath = fileURLToPath(new URL('../../../dist/isomorphic/module.wasm', import.meta.url));
  const packagePath = fileURLToPath(new URL('../../../package.json', import.meta.url));
  verifyFile(wasmPath, summary.module?.sha256, 'shipped FFM WASM');
  check(summary.module?.version === JSON.parse(fs.readFileSync(packagePath, 'utf8')).version, 'module version differs from package.json');
  verifyFile(recordPath, summary.nyx?.sha256, 'nyx-2.6.0.json');
  const toolMetadata = (tool) => Object.fromEntries(Object.entries(tool ?? {}).filter(([key]) => !/sha256$/i.test(key)));
  check(JSON.stringify(toolMetadata(summary.nyx?.tool)) === JSON.stringify(toolMetadata(nyx.tool)), 'Nyx tool metadata differs from the source record');
  check(JSON.stringify(summary.nyx?.settings) === JSON.stringify(nyx.settings), 'Nyx settings differ from the source record');
  for (const name of Object.keys(nyx.inputFiles)) {
    const entry = (summary.fileHashes ?? []).find((file) => nonempty(file.path) && path.basename(file.path) === name);
    if (entry) verifyFile(entry.path, summary.nyx?.inputFiles?.[name], `Nyx input ${name}`);
    else recordedHash(summary.nyx?.inputFiles?.[name], `Nyx input ${name}`);
  }
  verifyFile(summary.nyx?.stmFile, summary.nyx?.stmSha256, 'STM trajectory record');

  const identity = summary.provenance?.sourceIdentity;
  verifyFile(identity?.stock?.cargoLock?.file, summary.nyx?.tool?.cargoLockSha256, 'recorded stock Cargo.lock');
  verifyFile(identity?.stock?.nyxCrate?.file, summary.nyx?.tool?.nyxCrateSha256, 'recorded stock Nyx crate');
  for (const [name, source, tool, inputs, lock] of [
    ['stock', identity?.stock, nyx.tool, nyx.inputFiles, nyx.tool.cargoLockSha256],
    ['msisPublished', identity?.msisPublished, summary.diagnostics?.['msis-published']?.tool,
      summary.diagnostics?.['msis-published']?.inputFiles, summary.provenance?.diagnosticLock?.sha256],
  ]) {
    if (!source) { gaps.add(`sourceIdentity.${name}`); continue; }
    for (const key of ['cargoLock', 'nyxCrate', 'runnerSource', ...(name === 'msisPublished' ? ['patch'] : [])]) {
      verifyFile(source[key]?.file, source[key]?.sha256, `sourceIdentity.${name}.${key}`);
    }
    for (const [key, expected] of [['cargoLock', lock], ['nyxCrate', tool?.nyxCrateSha256]]) {
      if (nonempty(source[key]?.sha256) && nonempty(expected)) {
        check(source[key].sha256 === expected, `${name}: pinned ${key} differs from its recorded source identity`);
      }
    }
    check(nonempty(source.rustc) && source.rustc === tool?.rustc, `${name}: rustc version differs from the source record`);
    if (nonempty(source.caseExportSha256)) check(source.caseExportSha256 === summary.nyx?.caseExportSha256,
      `${name}: case export checksum differs from the stock run`);
    else gaps.add(`sourceIdentity.${name}.caseExportSha256`);
    for (const [input, checksum] of Object.entries(inputs ?? {})) {
      if (nonempty(source.inputFiles?.[input])) check(source.inputFiles[input] === checksum,
        `${name}: pinned input checksum differs from the source record: ${input}`);
      else gaps.add(`sourceIdentity.${name}.inputFiles.${input}`);
    }
    for (const [input, checksum] of Object.entries(source.inputFiles ?? {})) {
      const files = (summary.fileHashes ?? []).filter((entry) => nonempty(entry.path) && path.basename(entry.path) === input);
      if (files.length) for (const entry of files) verifyFile(entry.path, checksum, `${name} input ${input}`);
      else recordedHash(checksum, `${name} input ${input}`);
    }
  }
  // Cargo output bytes change when rebuilt. These hashes describe the
  // recorded builds; the source set above is the pinned tool identity.
  const buildOutputs = summary.provenance?.buildOutputs ?? [];
  check(Array.isArray(buildOutputs), 'provenance.buildOutputs must be an array');
  for (const entry of buildOutputs) {
    check(nonempty(entry.label) && entry.role === 'informational', 'build output needs a label and informational role');
    if (!nonempty(entry.sha256)) gaps.add(`build output ${entry.label}`);
  }
  // A gap is useful provenance information, not evidence of changed bytes.
  // Existing pinned files are still compared against every declared digest.
  function visitHashes(value, location = 'summary') {
    if (!value || typeof value !== 'object') return;
    if ('file' in value && 'sha256' in value) verifyFile(value.file, value.sha256, location);
    for (const [key, child] of Object.entries(value)) {
      const label = `${location}.${key}`;
      if (key === 'buildOutputs' || key === 'binarySha256') continue;
      if (typeof child === 'string' && /sha256$/i.test(key)) {
        recordedHash(child, label);
      } else visitHashes(child, label);
    }
  }

  const expectedIds = new Set(CASES.cases.map((c) => c.id));
  const sourceIds = new Set(nyx.cases.map((c) => c.id));
  const rows = summary.cases ?? [];
  const skipped = summary.skipped ?? [];
  const covered = [...rows, ...skipped].map((c) => c.id);
  check(expectedIds.size === 72, 'shared export must contain 72 distinct cases');
  check(new Set(covered).size === covered.length, 'duplicate case IDs in scored/skipped coverage');
  check(covered.length === expectedIds.size && covered.every((id) => expectedIds.has(id)), 'summary does not cover all 72 exported cases');
  check(rows.length === nyx.cases.length && rows.every((row) => sourceIds.has(row.id)), 'scored case IDs differ from the Nyx source record');
  check(skipped.length === nyx.skipped.length && skipped.every((row) => nonempty(row.reason)
    && nyx.skipped.some((source) => source.id === row.id && source.reason === row.reason)), 'skipped IDs/reasons differ from the Nyx source record');
  let missed = 0, diagnosed = 0, dragCount = 0, stmCount = 0;
  for (const row of rows) {
    const source = CASES.cases.find((c) => c.id === row.id);
    check(row.toleranceClass === source?.toleranceClass, `${row.id}: tolerance class differs from the shared export`);
    check(row.toleranceM === CASES.protocol.tolerancesM.default[row.toleranceClass], `${row.id}: tolerance differs from the shared protocol`);
    for (const setting of ['suite', 'steps30', 'finest']) {
      checkScore(row[setting], row.toleranceM, `${row.id} ${setting}`, row.cause);
    }
    check(typeof row.met === 'boolean' && row.met === row.suite?.met, `${row.id}: met must be the suite verdict`);
    check(row.orekitMinusNyx && Number.isFinite(row.orekitMinusNyx.worstM) && row.orekitMinusNyx.worstM >= 0,
      `${row.id}: missing Orekit-minus-Nyx measurement`);
    if (!row.met) { missed++; if (causePresent(row.cause)) diagnosed++; }
    const stm = row.stm;
    check(stm && Number.isFinite(stm.worst) && stm.worst >= 0 && stm.sampleCount === 24
      && Number.isInteger(stm.atHour) && stm.atHour > 0 && stm.atHour <= 24,
    `${row.id}: missing or invalid 24-sample STM comparison`);
    check(stm?.agreement === 'disagrees' && nonempty(stm.cause), `${row.id}: STM disagreement lacks its recorded cause`);
    check(!stm || !('met' in stm), `${row.id}: STM must not invent a protocol pass threshold`);
    for (const [parameter, value] of Object.entries(stm?.parameters ?? {})) check(Number.isFinite(value) && value >= 0, `${row.id}: invalid STM ${parameter} comparison`);
    if (stm) stmCount++;
    if (source?.forces.drag) {
      dragCount++;
      check(causePresent(row.diagnosis), `${row.id}: drag case lacks a measured diagnosis`);
    }
  }
  const diagnostic = summary.diagnostics?.['msis-published'];
  const dragIds = new Set(rows.filter((row) => CASES.cases.find((c) => c.id === row.id)?.forces.drag).map((row) => row.id));
  const hasAllDragCases = (cases) => Array.isArray(cases) && cases.length === dragIds.size
    && new Set(cases.map((row) => row.id)).size === dragIds.size && cases.every((row) => dragIds.has(row.id));
  check(diagnostic, 'published-MSIS diagnostic is missing');
  check(hasAllDragCases(diagnostic?.cases), 'published-MSIS diagnostic must cover every supported drag case');
  for (const [name, variant] of Object.entries(summary.diagnostics ?? {})) {
    for (const row of variant.cases ?? []) {
      const source = CASES.cases.find((c) => c.id === row.id);
      const limit = CASES.protocol.tolerancesM.default[source?.toleranceClass];
      check(source, `${name}: unknown case ${row.id}`);
      for (const setting of ['suite', 'steps30', 'finest']) {
        if (name === 'dragSettings' && setting !== 'finest') continue;
        checkScore(row[setting], limit, `${name} ${row.id} ${setting}`, row.cause);
      }
    }
    if ('file' in variant || 'sha256' in variant) verifyFile(variant.file, variant.sha256, `${name} diagnostic`);
  }
  const geometry = summary.diagnostics?.dragSettings;
  check(geometry, 'corrected Earth-shape diagnostic is missing');
  check(dragIds.size === 8 && hasAllDragCases(geometry?.cases), 'corrected Earth-shape diagnostic must cover all eight supported drag cases');
  for (const row of geometry?.cases ?? []) check(row.finest?.met === true
    && row.finest.worstM <= CASES.protocol.tolerancesM.default.drag,
  `${row.id}: corrected Earth-shape diagnostic exceeds the shared drag limit`);
  check(stmCount === 59 && stmCount === rows.length, 'all 59 scored cases require STM comparisons');
  check(summary.diagnostics?.stm?.agreement === 'disagrees' && causePresent(summary.diagnostics.stm)
    && nonempty(summary.diagnostics.stm.evidence.source), 'STM disagreement requires the recorded variational-equation source cause');

  const verdict = summary.verdict;
  check(verdict?.stockNyx?.version === '2.6.0' && verdict.stockNyx.total === rows.length
    && verdict.stockNyx.met === rows.filter((row) => row.met === true).length
    && verdict.stockNyx.missed === missed && nonempty(verdict.stockNyx.statement),
  'stock Nyx verdict must state the version and measured met/missed counts');
  const corrected = verdict?.drag?.correctedCases;
  const missedIds = new Set(rows.filter((row) => row.met === false).map((row) => row.id));
  check(nonempty(verdict?.drag?.statement) && Array.isArray(corrected)
    && corrected.length === missedIds.size && new Set(corrected.map((row) => row.id)).size === missedIds.size
    && corrected.every((row) => missedIds.has(row.id)), 'drag verdict must cover every stock tolerance miss');
  for (const row of corrected ?? []) {
    const measured = geometry?.cases?.find((candidate) => candidate.id === row.id)?.finest;
    const tolerance = rows.find((candidate) => candidate.id === row.id)?.toleranceM;
    check(measured && row.worstM === measured.worstM && row.toleranceM === tolerance
      && row.met === true && row.met === measured.met && row.worstM <= row.toleranceM,
    `${row.id}: corrected drag verdict differs from the measured diagnostic`);
  }
  check(verdict?.stm?.usableAsFfmCheck === false && nonempty(verdict.stm.statement)
    && Array.isArray(verdict.stm.sources) && verdict.stm.sources.length > 0,
  'STM verdict must state that it is unusable as an FFM check and cite the source');
  for (const [name, checksum] of Object.entries(nyx.inputFiles)) recordedHash(checksum, `Nyx input ${name}`);
  visitHashes(summary);
  console.log(`Hashes: ${verifiedFiles.size} available pinned files verified; ${gaps.size} informational hash gaps; ${buildOutputs.length} Cargo build-output hashes informational.`);
  console.log(`Coverage: ${rows.length} scored + ${skipped.length} skipped = ${covered.length} cases; ${missed} suite misses, ${diagnosed} with causes; ${dragCount} drag diagnoses.`);
  const correctedMetCount = (geometry?.cases ?? []).filter((row) => row.finest?.met === true
    && row.finest.worstM <= CASES.protocol.tolerancesM.default.drag).length;
  const stmCauseRecorded = summary.diagnostics?.stm?.agreement === 'disagrees' && causePresent(summary.diagnostics.stm)
    && nonempty(summary.diagnostics.stm.evidence.source);
  console.log(`Diagnostics: ${correctedMetCount} corrected drag cases meet the shared limit; ${stmCount} STM comparisons, disagreement source cause ${stmCauseRecorded ? 'recorded' : 'MISSING'}.`);

  // This is the only propagation in this E2E. The native metrics helper is
  // built inside the worktree, then removed even if a comparison fails.
  const cheap = nyx.cases.find((c) => c.id === 'LEO400 F0-point-mass');
  const expected = rows.find((c) => c.id === cheap?.id)?.suite;
  const work = fs.mkdtempSync(path.join(here, '.check-nyx-'));
  try {
    if (!cheap || !expected) throw new Error('LEO400 F0-point-mass suite score is missing');
    const metrics = await buildMetrics(work);
    const actual = scoreResponse(await run(cheap, ALL[0]), cheap, metrics);
    for (const key of ['worstM', 'atHour', 'steps']) check(actual[key] === expected[key], `${cheap.id}: re-scored ${key} ${actual[key]} differs from summary ${expected[key]}`);
    console.log(`Re-score: ${cheap.id}, suite: worstM=${actual.worstM}, atHour=${actual.atHour}, steps=${actual.steps}; ${['worstM', 'atHour', 'steps'].every((key) => actual[key] === expected[key]) ? 'exact match' : 'MISMATCH'}.`);
  } catch (error) { errors.push(`point-mass re-score failed: ${error.message}`); }
  finally { fs.rmSync(work, { recursive: true, force: true }); }

  for (const error of errors) console.error(`FAIL: ${error}`);
  console.log(`${errors.length ? 'FAIL' : 'PASS'} Nyx evidence E2E: ${errors.length} failure(s).`);
  process.exitCode = errors.length ? 1 : 0;
}

await main().catch((error) => {
  console.error(`FAIL Nyx evidence E2E: ${error.message}`);
  process.exitCode = 1;
});

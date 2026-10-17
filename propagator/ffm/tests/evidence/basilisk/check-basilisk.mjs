#!/usr/bin/env node
// The ONE E2E for this evidence change. Authenticate the pinned input/source
// set, cover all 72 exported cases, recompute every stored score in C++, and
// replay exactly one cheap LEO400 F0 case in the shipped FFM WASM.
// Source: Basilisk 2.12.0 independent trajectories. Units: SI meters and m/s;
// axes: geocentric GCRF; epoch/time scale: exported UTC epoch, TT dynamics,
// TDB ephemerides. Arc: 24 h, hourly. Limits: unchanged export default
// tolerances. Native convergence must be <0.3 mm; exact replay tolerance is
// zero because the input bytes, WASM, request and C++ reducer are identical.
// node tests/evidence/basilisk/check-basilisk.mjs [summary.json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL, CASES, WASM, here, exportPath, sha256, readJson, normalizedRecord,
  buildMetrics, run, scoreResponse, scoreStored, scoreOrekit, scoreDifference, scoreConvergence,
  protocolFor, causePresent, verdictFor, propagationIdentity, stmSkipped } from './scoring.mjs';

const errors = [];
const check = (value, message) => { if (!value) errors.push(message); };
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const digest = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const verified = new Set();
const missing = new Set();
const historical = new Set();
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

function verifyPin(pin, label, required = false) {
  if (pin?.role === 'historical-source' && pin.availability === 'unavailable') {
    check(!required, `${label}: required file cannot be an unavailable historical source`);
    check(nonempty(pin.path) && digest(pin.sha256) && nonempty(pin.reason), `${label}: invalid historical source declaration`);
    historical.add(`${pin.path}#${pin.sha256}`);
    return;
  }
  verifyFile(pin?.path ?? pin?.file, pin?.sha256, label, required);
}

function visitPins(value, label) {
  if (!value || typeof value !== 'object') return;
  if ('sha256' in value && ('path' in value || 'file' in value)) verifyPin(value, label);
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
  if (score?.met === false) check(causePresent(cause), `${label}: met:false lacks a measured model-setting mismatch / Basilisk defect / FFM defect cause`);
}

function trajectoryValid(samples, exported, label) {
  check(Array.isArray(samples) && samples.length === CASES.protocol.samples
    && samples.every((sample, index) => Array.isArray(sample) && sample.length === 7
      && sample.every(Number.isFinite) && sample[0] === exported.sampleOffsetsS[index]), `${label}: expected 25 finite, hourly SI state samples`);
  check(same(samples?.[0], [0, ...exported.initialState.positionM, ...exported.initialState.velocityMS]), `${label}: initial state differs from the export`);
}

function convergenceValid(source, row, exported, metrics, label) {
  trajectoryValid(source.samples, exported, `${label} native`);
  trajectoryValid(source.fineSamples, exported, `${label} half-step`);
  check(Number.isFinite(source.maxStepS) && source.maxStepS > 0 && source.maxStepS <= 10
    && source.fineStepS === source.maxStepS / 2, `${label}: native maximum steps must be <=10 s and exactly halved`);
  const measured = scoreConvergence(source, metrics);
  exactFields(measured, row.convergence, ['worstM', 'atHour', 'sampleCount'], `${label} convergence`);
  check(row.convergence?.maxStepS === source.maxStepS && row.convergence?.fineStepS === source.fineStepS
    && row.convergence?.limitM === 0.0003 && row.convergence?.met === true && measured.worstM < 0.0003,
  `${label}: half-step convergence must be below 0.3 mm`);
  check(same(row.convergenceAttempts, source.convergenceAttempts), `${label}: refinement history differs from trajectory record`);
  const attempts = source.convergenceAttempts;
  check(Array.isArray(attempts) && attempts.length > 0, `${label}: native refinement history is missing`);
  for (const [index, attempt] of (attempts ?? []).entries()) {
    check(Number.isFinite(attempt.maxStepS) && attempt.maxStepS > 0 && attempt.maxStepS <= 10
      && attempt.fineStepS === attempt.maxStepS / 2 && Number.isFinite(attempt.worstM) && attempt.worstM >= 0
      && attempt.sampleCount === 24 && Number.isInteger(attempt.atHour) && attempt.atHour >= 1 && attempt.atHour <= 24,
    `${label}: invalid refinement attempt ${index}`);
    if (index) check(attempt.maxStepS === attempts[index - 1].fineStepS, `${label}: refinement history must halve steps consecutively`);
    if (index < attempts.length - 1) check(attempt.worstM >= 0.0003, `${label}: step refinement after a passing convergence result is unexplained`);
  }
  exactFields(attempts?.at(-1), row.convergence, ['maxStepS', 'fineStepS', 'worstM', 'atHour', 'sampleCount'], `${label} final refinement attempt`);
}

function nominallySupported({ frame, forces, sensitivities }) {
  return frame === 'GCRF' && !sensitivities && !forces.solidTides && !forces.oceanTides
    && !forces.earthRadiation && (!forces.relativity || forces.relativity === 'none')
    && !forces.inTrackAccelerationMS2
    && (!forces.drag || forces.drag.atmosphere === 'NRLMSISE00');
}

function inspectSummary(summaryPath, metrics) {
  const summary = readJson(summaryPath);
  const recordPath = path.resolve(here, summary.basilisk?.file ?? 'MISSING');
  const record = normalizedRecord(recordPath);
  verifyFile(recordPath, summary.basilisk?.sha256, 'Basilisk trajectory', true);
  verifyFile(exportPath, summary.basilisk?.caseExportSha256, 'Shared case export', true);
  check(record.caseExportSha256 === summary.basilisk?.caseExportSha256, 'Trajectory/summary export hashes differ');
  verifyFile(fileURLToPath(WASM), summary.module?.sha256, 'Shipped FFM WASM', true);
  check(summary.module?.version === readJson(path.resolve(here, '../../../package.json')).version, 'FFM package version mismatch');
  check(same(summary.settings, ALL), 'FFM settings mismatch');
  check(same(summary.tolerancesM, CASES.protocol.tolerancesM.default), 'Shared tolerances were changed');
  check(same(summary.basilisk?.tool, record.tool), 'Tool metadata differs from stored trajectory');
  check(same(summary.basilisk?.settings, record.settings), 'Settings differ from stored trajectory');
  check(same(summary.basilisk?.inputFiles, record.inputFiles), 'Input-file provenance differs from stored trajectory');
  check(record.tool?.version === '2.12.0', 'Expected Basilisk 2.12.0 version pin');
  check(/3\.14\./.test(JSON.stringify(record.tool)), 'Python 3.14 patch version pin is missing');
  check(Array.isArray(record.inputFiles) && record.inputFiles.length > 0, 'Basilisk input-file pins are missing');
  for (const entry of summary.fileHashes ?? []) verifyPin(entry, 'fileHashes');
  for (const entry of record.inputFiles ?? []) {
    check((summary.fileHashes ?? []).some((pinned) => path.resolve(here, pinned.path) === path.resolve(here, entry.path)
      && pinned.sha256 === entry.sha256), `Runner input pin is absent from fileHashes: ${entry.path}`);
  }
  const spacecraftPin = record.inputFiles?.find((entry) => /Basilisk\/simulation\/_spacecraft\.(?:so|dylib)$/.test(entry.path));
  check(spacecraftPin && digest(spacecraftPin.sha256), 'Installed Basilisk spacecraft shared-library SHA-256 pin is missing');
  const kernel = record.inputFiles?.find((entry) => path.basename(entry.path) === path.basename(CASES.models.ephemeris.path));
  check(kernel?.sha256 === CASES.models.ephemeris.sha256, 'DE440 kernel differs from the shared export');
  const identity = summary.provenance?.sourceIdentity ?? [];
  check(summary.fileHashes?.length > 0 && identity.length >= 6, 'Source-hash provenance is missing');
  for (const source of ['scoring.mjs', 'score-basilisk.mjs', 'check-basilisk.mjs', 'run-basilisk.py', 'basilisk-backend.py',
    'investigate-basilisk.py', 'model-probes.json', 'README.md', '../nyx/scoring.mjs', '../nyx/score-metrics.cpp',
    ...['.gitignore', 'diagnose-lst.py', 'lst-probes.json'].filter((file) => fs.existsSync(path.join(here, file)))]) {
    const entry = identity.find((item) => nonempty(item.path) && path.resolve(here, item.path) === path.resolve(here, source));
    check(entry, `Required repository source pin is missing: ${source}`);
    if (entry) verifyPin(entry, `Required source ${source}`, true);
  }
  for (const entry of identity) verifyPin(entry, 'Source identity', true);
  visitPins(summary, 'summary');
  visitPins(record, 'trajectory');
  const probesPin = summary.provenance?.modelProbes;
  verifyFile(probesPin?.path, probesPin?.sha256, 'Native model probes', true);
  check(nonempty(probesPin?.path) && path.resolve(here, probesPin.path) === path.join(here, 'model-probes.json'),
    'Native model probes must identify the committed model-probes.json');
  const probes = readJson(path.resolve(here, probesPin.path));
  check(probes.basiliskVersion === record.tool.version && probes.pythonVersion === record.tool.python,
    'Native model probes used a different Basilisk/Python version');
  visitPins(probes, 'native model probes');
  if (summary.provenance?.lstProbes || fs.existsSync(path.join(here, 'lst-probes.json'))) {
    const lstPin = summary.provenance?.lstProbes;
    verifyFile(lstPin?.path, lstPin?.sha256, 'Local solar time density probes', true);
    check(nonempty(lstPin?.path) && path.resolve(here, lstPin.path) === path.join(here, 'lst-probes.json'),
      'Local solar time probes must identify the committed lst-probes.json');
    const lst = readJson(path.resolve(here, lstPin.path));
    check(lst.tool?.version === record.tool.version && lst.tool?.python === record.tool.python
      && lst.caseExportSha256 === record.caseExportSha256, 'Local solar time probes used different Basilisk/Python/export inputs');
    check(Array.isArray(lst.inputFiles) && lst.inputFiles.length > 0, 'Local solar time probe input pins are missing');
    for (const entry of lst.inputFiles ?? []) {
      check((summary.fileHashes ?? []).some((pinned) => path.resolve(here, pinned.path) === path.resolve(here, entry.path)
        && pinned.sha256 === entry.sha256), `Local solar time input pin is absent from fileHashes: ${entry.path}`);
    }
    visitPins(lst, 'local solar time probes');
  }
  const cachePin = summary.provenance?.ffmTrajectories;
  verifyFile(cachePin?.path, cachePin?.sha256, 'FFM trajectory cache', true);
  const cache = readJson(path.resolve(here, cachePin.path));
  check(same(cache.identity, summary.provenance?.propagationInputs), 'Cached propagation identity differs from summary');
  check(same(cache.identity, propagationIdentity()), 'Cached propagation identity differs from current inputs');
  for (const item of cache.identity ?? []) verifyPin(item, 'FFM propagation input', true);

  const expected = new Set(CASES.cases.map((c) => c.id));
  const rows = summary.cases ?? [];
  const skipped = summary.skipped ?? [];
  check(same(summary.protocol, protocolFor(rows)), 'Source/units/frame/epoch/tolerance protocol differs from shared export');
  const covered = [...rows, ...skipped].map((c) => c.id);
  check(expected.size === 72 && covered.length === expected.size && new Set(covered).size === expected.size
    && covered.every((id) => expected.has(id)), 'Table must cover every one of the 72 cases exactly once');
  check(same(rows.map((r) => r.id), record.cases.map((c) => c.id)), 'Table/source trajectory case IDs differ');
  check(same(skipped, record.skipped) && skipped.every((row) => nonempty(row.reason)), 'Skipped IDs/reasons differ from source');
  check(same(cache.cases.map((c) => c.id).sort(), rows.map((c) => c.id).sort()), 'Cache case IDs differ from summary');
  // Independent force requirements prevent a missing supported trajectory
  // from being disguised as an arbitrary skip. A native numerical limitation
  // is allowed only with explicit measured step-halving failure evidence.
  for (const exported of CASES.cases) {
    const row = rows.find((candidate) => candidate.id === exported.id);
    const omission = skipped.find((candidate) => candidate.id === exported.id);
    if (nominallySupported(exported)) {
      check(row || (causePresent(omission?.cause) && Array.isArray(omission?.convergenceAttempts)
        && omission.convergenceAttempts.length > 0 && omission.convergenceAttempts.every((attempt) =>
          Number.isFinite(attempt.worstM) && attempt.worstM >= 0.0003 && attempt.maxStepS <= 10
          && attempt.fineStepS === attempt.maxStepS / 2)), `${exported.id}: supported case is absent without a measured native convergence limitation`);
    } else check(!row && omission, `${exported.id}: unsupported force/frame/variational requirement must be skipped`);
  }
  for (const row of rows) {
    const source = record.cases.find((c) => c.id === row.id);
    const exported = CASES.cases.find((c) => c.id === row.id);
    const stored = cache.cases.find((c) => c.id === row.id);
    if (!source || !exported || !stored) { check(false, `${row.id}: missing source/cache/export case`); continue; }
    check(row.orbit === exported.orbit && row.forceSet === exported.forceSet && row.row === exported.row
      && row.toleranceClass === exported.toleranceClass, `${row.id}: exported case metadata mismatch`);
    check(row.toleranceM === CASES.protocol.tolerancesM.default[exported.toleranceClass], `${row.id}: tolerance changed`);
    convergenceValid(source, row, exported, metrics, row.id);
    for (const setting of ALL) {
      scoreValid(row[setting.id], row.toleranceM, row.cause, `${row.id} ${setting.id}`);
      exactFields(scoreStored(stored[setting.id], source, metrics), row[setting.id],
        ['worstM', 'atHour', 'sampleCount', 'steps'], `${row.id} ${setting.id}`);
    }
    check(row.met === row.suite.met, `${row.id}: row verdict must equal suite verdict`);
    exactFields(scoreOrekit(source, metrics), row.orekitMinusBasilisk,
      ['worstM', 'atHour', 'sampleCount'], `${row.id} Orekit-minus-Basilisk`);
    check(row.stmSkipped === stmSkipped && !row.stm, `${row.id}: native variational-equation limitation must be recorded`);
    check(same(row.diagnostics, source.diagnostics), `${row.id}: diagnostic evidence differs from trajectory record`);
  }
  check(same(summary.verdict, verdictFor(rows, skipped, record.tool)), 'Top-level verdict differs from measured rows');
  const dragRows = rows.filter((row) => CASES.cases.find((candidate) => candidate.id === row.id)?.forces.drag);
  const dragMisses = dragRows.filter((row) => ALL.some((setting) => row[setting.id]?.met === false));
  check(summary.diagnostics?.wgs84 || dragMisses.length === 0, 'Drag misses require the measured WGS84 diagnostic');
  check(!summary.diagnostics?.['wgs84-gtd7d'] || summary.diagnostics?.wgs84,
    'The gtd7d diagnostic requires WGS84 trajectories for a direct anomalous-oxygen comparison');
  check(Object.keys(summary.diagnostics ?? {}).every((key) => ['wgs84', 'wgs84-gtd7d'].includes(key)), 'Unknown diagnostic variant is not checked');
  for (const [name, diagnostic] of Object.entries(summary.diagnostics ?? {})) {
    verifyFile(diagnostic.file, diagnostic.sha256, `${name} diagnostic trajectory`, true);
    const variant = normalizedRecord(path.resolve(here, diagnostic.file));
    const wgs84Variant = name === 'wgs84-gtd7d' && summary.diagnostics?.wgs84
      ? normalizedRecord(path.resolve(here, summary.diagnostics.wgs84.file)) : null;
    const diagnosticProvenance = summary.provenance?.diagnostics?.[name];
    const diagnosticPin = diagnosticProvenance?.trajectory;
    check(diagnosticPin && path.resolve(here, diagnosticPin.path) === path.resolve(here, diagnostic.file)
      && diagnosticPin.sha256 === diagnostic.sha256, `${name} diagnostic provenance pin differs from summary`);
    check((summary.fileHashes ?? []).some((entry) => path.resolve(here, entry.path) === path.resolve(here, diagnostic.file)
      && entry.sha256 === diagnostic.sha256), `${name} diagnostic trajectory is missing from fileHashes`);
    check(variant.caseExportSha256 === record.caseExportSha256 && diagnostic.caseExportSha256 === variant.caseExportSha256,
      `${name} diagnostic case export differs from nominal`);
    check(same(diagnostic.tool, variant.tool) && same(diagnostic.tool, record.tool), `${name} diagnostic tool differs from its source or nominal`);
    check(same(diagnostic.settings, variant.settings) && variant.settings?.variant === name, `${name} diagnostic settings differ from its source`);
    check(same(diagnostic.inputFiles, variant.inputFiles)
      && same(diagnosticProvenance?.inputFiles, variant.inputFiles), `${name} diagnostic input pins differ from its source`);
    check(same(diagnosticProvenance?.native, variant.provenance), `${name} native provenance differs from its source`);
    for (const entry of variant.inputFiles ?? []) {
      verifyPin(entry, `${name} diagnostic input`);
      check((summary.fileHashes ?? []).some((pinned) => path.resolve(here, pinned.path) === path.resolve(here, entry.path)
        && pinned.sha256 === entry.sha256), `${name} input pin is absent from fileHashes: ${entry.path}`);
    }
    visitPins(variant, `${name} native trajectory`);
    const expectedDragIds = dragRows.map((row) => row.id).sort();
    check(same((diagnostic.cases ?? []).map((row) => row.id).sort(), expectedDragIds)
      && same(variant.cases.map((row) => row.id).sort(), expectedDragIds), `${name} diagnostic must cover every scored drag case exactly once`);
    for (const row of diagnostic.cases ?? []) {
      const source = variant.cases.find((candidate) => candidate.id === row.id);
      const nominal = record.cases.find((candidate) => candidate.id === row.id);
      const exported = CASES.cases.find((candidate) => candidate.id === row.id);
      const stored = cache.cases.find((candidate) => candidate.id === row.id);
      if (!source || !nominal || !exported || !stored) { check(false, `${name} ${row.id}: missing source/cache/export case`); continue; }
      check(row.orbit === exported.orbit && row.forceSet === exported.forceSet && row.row === exported.row
        && row.toleranceClass === exported.toleranceClass && row.toleranceM === CASES.protocol.tolerancesM.default[exported.toleranceClass],
      `${name} ${row.id}: case metadata or tolerance differs from the export`);
      for (const setting of ALL) {
        scoreValid(row[setting.id], row.toleranceM, row.cause, `${name} ${row.id} ${setting.id}`);
        exactFields(scoreStored(stored[setting.id], source, metrics), row[setting.id],
          ['worstM', 'atHour', 'sampleCount', 'steps'], `${name} ${row.id} ${setting.id}`);
      }
      check(row.met === row.suite.met, `${name} ${row.id}: row verdict must equal suite verdict`);
      exactFields(scoreDifference(nominal, source, metrics), row.nominalMinusVariant,
        ['worstM', 'atHour', 'sampleCount'], `${name} ${row.id} nominal-minus-variant`);
      if (name === 'wgs84-gtd7d') {
        const wgs84 = wgs84Variant?.cases.find((candidate) => candidate.id === row.id);
        check(wgs84, `${name} ${row.id}: WGS84 trajectory for direct anomalous-oxygen comparison is missing`);
        if (wgs84) exactFields(scoreDifference(wgs84, source, metrics), row.wgs84MinusVariant,
          ['worstM', 'atHour', 'sampleCount'], `${name} ${row.id} WGS84-minus-variant`);
      }
      exactFields(scoreOrekit(source, metrics), row.orekitMinusBasilisk,
        ['worstM', 'atHour', 'sampleCount'], `${name} ${row.id} Orekit-minus-Basilisk`);
      convergenceValid(source, row, exported, metrics, `${name} ${row.id}`);
      check(same(row.diagnostics, source.diagnostics), `${name} ${row.id}: diagnostic evidence differs from source`);
    }
    console.log(`${name} diagnostic: ${diagnostic.cases.length} drag cases; all stored FFM, Orekit, nominal-minus-variant${name === 'wgs84-gtd7d' ? ', WGS84-minus-variant' : ''} and half-step scores rechecked.`);
  }
  const misses = rows.filter((row) => row.met === false);
  console.log(`Basilisk 2.12.0: ${rows.length} scored + ${skipped.length} skipped = ${covered.length}; ${misses.length} suite misses, ${misses.filter((row) => causePresent(row.cause)).length} diagnosed; all stored scores rechecked.`);
  console.log(`Convergence: ${rows.filter((row) => row.convergence?.met).length}/${rows.length} native half-step comparisons below 0.3 mm; STM/sensitivities unavailable and recorded.`);
  return { summary, record };
}

async function main() {
  const work = fs.mkdtempSync(path.join(here, '.check-basilisk-'));
  try {
    const metrics = buildMetrics(work);
    const summaryPath = path.resolve(process.argv[2] ?? path.join(here, 'summary-basilisk-2.12.0.json'));
    const { summary, record } = inspectSummary(summaryPath, metrics);
    console.log(`Hashes: ${verified.size} available pinned files verified; ${missing.size} unavailable package/scratch files recorded; ${historical.size} unavailable historical source versions recorded (informational).`);
    const id = 'LEO400 F0-point-mass';
    const source = record.cases.find((c) => c.id === id);
    const expected = summary.cases.find((c) => c.id === id)?.suite;
    if (!source || !expected) throw new Error('LEO400 point-mass trajectory or suite score is missing');
    const actual = scoreResponse(await run(source, ALL[0]), source, metrics);
    exactFields(actual, expected, ['worstM', 'atHour', 'sampleCount', 'steps'], 'One-run WASM replay');
    console.log(`Re-score: ${id}, suite worstM=${actual.worstM}, atHour=${actual.atHour}, steps=${actual.steps}; ${['worstM', 'atHour', 'sampleCount', 'steps'].every((key) => actual[key] === expected[key]) ? 'exact match' : 'MISMATCH'}.`);
    console.log('Propagation: one LEO400 point-mass run through the shipped FFM WASM.');
  } catch (error) { errors.push(error.message); }
  finally { fs.rmSync(work, { recursive: true, force: true }); }
  for (const error of errors) console.log(`FAIL: ${error}`);
  console.log(`${errors.length ? 'FAIL' : 'PASS'} Basilisk evidence E2E: ${errors.length} failure(s).`);
  process.exitCode = errors.length ? 1 : 0;
}

await main();

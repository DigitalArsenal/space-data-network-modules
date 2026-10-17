#!/usr/bin/env node
// One serial job. All propagation is in shipped FFM WASM; all numerical
// reductions use ../nyx/score-metrics.cpp. Existing cache rows avoid reruns.
// node tests/evidence/tudat/score-tudat.mjs [native.json] [--fine fine.json]
//   [--stm stm.json] [--causes causes.json] [--cache cache.json] [--out summary.json]
// --wasm scores the 27 committed cases (called 28 in the task context)
// without building/running Tudat or inventing the absent trajectory.
// --cached-only refuses to propagate and is useful when adding diagnoses.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { assertRecordedNumbers } from '../recorded-numbers.mjs';
import { ALL, CASES, WASM, here, exportPath, wasmFixturePath, readJson, writeJson, pin,
  normalizedRecord, readCache, buildMetrics, run, storedResponse, scoreStored, scoreOrekit,
  scoreConvergence, scoreStm, parametersOfExtended, stmLimitation, protocolFor, verdictFor } from './scoring.mjs';

const { values: options, positionals } = parseArgs({ allowPositionals: true, options: {
  wasm: { type: 'boolean', default: false }, fine: { type: 'string' }, stm: { type: 'string' },
  causes: { type: 'string' }, cache: { type: 'string' }, out: { type: 'string' }, 'cached-only': { type: 'boolean', default: false },
  'verify-recorded': { type: 'string' },
} });

async function main() {
  const input = path.resolve(positionals[0] ?? (options.wasm ? wasmFixturePath : path.join(here, 'tudatpy-1.0.0.json')));
  const stem = options.wasm ? 'tudat-wasm' : 'tudatpy-1.0.0';
  const out = path.resolve(options.out ?? path.join(here, `summary-${stem}.json`));
  const cacheOut = path.join(path.dirname(out), `ffm-${stem}.json`);
  const cacheFile = path.resolve(options.cache ?? cacheOut);
  const record = normalizedRecord(input, options.wasm);
  const recorded = options['verify-recorded'] ? readJson(options['verify-recorded']) : null;
  const finePath = options.fine ? path.resolve(options.fine) : !options.wasm ? path.join(here, 'tudatpy-1.0.0-fine.json') : null;
  const fine = finePath ? normalizedRecord(finePath) : null;
  const stmPath = options.stm ? path.resolve(options.stm) : null;
  const stm = stmPath ? readJson(stmPath) : null;
  const causes = options.causes ? readJson(options.causes) : {};
  const cache = readCache(cacheFile);
  const work = fs.mkdtempSync(path.join(here, '.score-tudat-'));
  const rows = [];
  try {
    const metrics = buildMetrics(work);
    for (const source of record.cases) {
      let cached = cache.cases.find((c) => c.id === source.id);
      if (!cached) { cached = { id: source.id }; cache.cases.push(cached); }
      const row = { id: source.id, orbit: source.orbit, forceSet: source.forceSet, row: source.row,
        toleranceClass: source.toleranceClass, toleranceM: CASES.protocol.tolerancesM.default[source.toleranceClass],
        orekitMinusTudat: scoreOrekit(source, metrics) };
      if (source.stmSkipped) row.stmSkipped = source.stmSkipped;
      for (const setting of ALL) {
        if (!cached[setting.id]) {
          if (options['cached-only']) throw new Error(`Missing FFM cache: ${source.id} ${setting.id}`);
          cached[setting.id] = storedResponse(await run(source, setting));
          writeJson(cacheFile, cache);
        }
        row[setting.id] = scoreStored(cached[setting.id], source, metrics);
        row[setting.id].met = row[setting.id].worstM <= row.toleranceM;
      }
      row.met = row.suite.met;
      if (fine) {
        const finer = fine.cases.find((c) => c.id === source.id);
        if (!finer) throw new Error(`Missing half-step Tudat trajectory: ${source.id}`);
        row.convergence = { ...source.convergence, ...scoreConvergence(source, finer, metrics), limitM: 0.0003 };
        row.convergence.met = row.convergence.worstM < row.convergence.limitM;
      }
      const referenceStm = stm?.cases.find((c) => c.id === source.id);
      if (referenceStm) {
        if (!cached.suiteStm) {
          if (options['cached-only']) throw new Error(`Missing FFM STM cache: ${source.id}`);
          cached.suiteStm = storedResponse(await run(source, ALL[0], true), true);
          cached.suiteStm.parameterColumns = parametersOfExtended(source);
          writeJson(cacheFile, cache);
        }
        if (JSON.stringify(cached.suiteStm.parameterColumns) !== JSON.stringify(parametersOfExtended(source)))
          throw new Error(`${source.id}: FFM STM cache parameter mapping differs from the exported sensitivities`);
        row.stm = { ...scoreStm(cached.suiteStm, source, referenceStm, metrics),
          parameterColumns: parametersOfExtended(source),
          agreement: 'relative-column-difference', note: 'Quantitative agreement; the shared protocol defines no STM tolerance.' };
        const limitation = stmLimitation(source, row.stm, record.inputFiles);
        if (limitation) row.stm.limitation = limitation;
      }
      const diagnosis = causes.cases?.find?.((c) => c.id === source.id) ?? causes[source.id];
      if (diagnosis?.cause) row.cause = diagnosis.cause;
      else if (diagnosis?.classification) row.cause = diagnosis;
      if (diagnosis?.stm && row.stm) Object.assign(row.stm, diagnosis.stm);
      if (diagnosis?.diagnosis) row.diagnosis = diagnosis.diagnosis;
      if (recorded) {
        const previous = recorded.cases.find((candidate) => candidate.id === row.id);
        if (!previous) throw new Error(`Recorded case is missing: ${row.id}`);
        assertRecordedNumbers(row, previous, row.id);
      }
      rows.push(row);
      console.log(`${source.id}: suite=${row.suite.worstM} m; steps30=${row.steps30.worstM} m; finest=${row.finest.worstM} m; Orekit-Tudat=${row.orekitMinusTudat.worstM} m${row.convergence ? `; half-step=${row.convergence.worstM} m` : ''}${row.stm ? `; STM=${row.stm.worst}` : ''}`);
    }
    const sourceIds = new Set(record.cases.map((c) => c.id));
    const snapshot = { ...cache, cases: cache.cases.filter((c) => sourceIds.has(c.id)) };
    writeJson(cacheOut, snapshot);
    const sourceFiles = ['scoring.mjs', 'score-tudat.mjs', 'check-tudat.mjs', '../recorded-numbers.mjs', '../nyx/scoring.mjs', '../nyx/score-metrics.cpp'].map((file) => path.resolve(here, file));
    if (options.wasm) sourceFiles.push(path.resolve(here, '../../fixtures/tudat/tudat_wasm_driver.cpp'), path.resolve(here, '../../fixtures/tudat/tudat-wasm-reference.mjs'));
    else sourceFiles.push(path.join(here, 'run-tudat.py'), path.join(here, 'tudat-support.cpp'), path.join(here, 'tudat-settings.cpp'),
      path.resolve(here, '../../fixtures/tudat/tudat_reference.py'));
    if (options.causes) sourceFiles.push(path.resolve(options.causes));
    if (fs.existsSync(path.join(here, 'README.md'))) sourceFiles.push(path.join(here, 'README.md'));
    const summary = {
      note: 'FFM shipped WASM against Tudat: largest 3D position difference over 24 h at hourly samples in each exported case frame; suite/steps30/finest FFM settings and Orekit-minus-Tudat; 6x6 STM and Cd/Cr, Cd*A/m-rate, and in-track-acceleration sensitivity comparisons where available. Numerical reductions are C++.',
      module: { version: readJson(path.resolve(here, '../../../package.json')).version, sha256: pin(fileURLToPath(WASM)).sha256 },
      tudat: { file: path.relative(here, input), sha256: pin(input).sha256, caseExportSha256: record.caseExportSha256 ?? pin(exportPath).sha256,
        tool: record.tool, settings: record.settings, inputFiles: record.inputFiles,
        ...(finePath ? { fineFile: path.relative(here, finePath), fineSha256: pin(finePath).sha256 } : {}),
        ...(stmPath ? { stmFile: path.relative(here, stmPath), stmSha256: pin(stmPath).sha256 } : {}) },
      node: process.version, host: os.cpus()[0].model, settings: ALL, tolerancesM: CASES.protocol.tolerancesM.default,
      protocol: protocolFor(rows, options.wasm),
      cases: rows, skipped: record.skipped ?? [],
      verdict: verdictFor(rows, record.skipped ?? [], record.tool),
      provenance: { sourceIdentity: sourceFiles.map(pin), propagationInputs: snapshot.identity,
        ffmTrajectories: pin(cacheOut), ...(options.wasm ? { historicalFixture: pin(input),
          packageCommit: '1d4718f', emscripten: '3.1.51', apiLimitation: record.tool.execution,
          fixtureCoverage: record.settings.coverage } : {}),
        ...(record.provenance ? { tudat: record.provenance } : {}) },
      fileHashes: [pin(input), pin(exportPath), pin(cacheOut), ...sourceFiles.map(pin), ...snapshot.identity,
        ...(record.inputFiles ?? []),
        ...(finePath ? [pin(finePath)] : []), ...(stmPath ? [pin(stmPath)] : [])],
    };
    writeJson(out, summary);
    console.log(`Wrote ${path.relative(process.cwd(), out)}: ${rows.length} scored; ${summary.skipped.length} skipped; ${summary.verdict.tool.missed} suite misses, ${summary.verdict.tool.diagnosed} diagnosed.`);
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}

await main().catch((error) => { console.log(`FAIL Tudat score: ${error.message}`); process.exitCode = 1; });

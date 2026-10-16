#!/usr/bin/env node
// Serial scoring job. Reuses authenticated shipped-WASM trajectories when
// present; --cached-only prohibits propagation. No JavaScript physics.
// node tests/evidence/basilisk/score-basilisk.mjs [trajectory.json]
//   [--cache ../tudat/hpop-tudatpy-1.0.0.json] [--causes causes.json]
//   [--diagnostics wgs84.json] [--diagnostics wgs84-gtd7d.json]
//   [--out summary.json] [--cached-only]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ALL, CASES, WASM, here, exportPath, readJson, writeJson, pin, normalizedRecord,
  readCache, buildMetrics, run, storedResponse, scoreStored, scoreOrekit,
  scoreDifference, scoreConvergence, protocolFor, verdictFor, stmSkipped } from './scoring.mjs';

const { values: options, positionals } = parseArgs({ allowPositionals: true, options: {
  causes: { type: 'string' }, cache: { type: 'string' }, out: { type: 'string' },
  diagnostics: { type: 'string', multiple: true },
  'cached-only': { type: 'boolean', default: false },
} });

function positionRow(source, cached, metrics) {
  const row = { id: source.id, orbit: source.orbit, forceSet: source.forceSet, row: source.row,
    toleranceClass: source.toleranceClass, toleranceM: CASES.protocol.tolerancesM.default[source.toleranceClass],
    orekitMinusBasilisk: scoreOrekit(source, metrics) };
  for (const setting of ALL) {
    row[setting.id] = scoreStored(cached[setting.id], source, metrics);
    row[setting.id].met = row[setting.id].worstM <= row.toleranceM;
  }
  row.met = row.suite.met;
  row.convergence = { maxStepS: source.maxStepS, fineStepS: source.fineStepS,
    ...scoreConvergence(source, metrics), limitM: 0.0003 };
  row.convergence.met = row.convergence.worstM < row.convergence.limitM;
  row.convergenceAttempts = source.convergenceAttempts;
  if (source.diagnostics) row.diagnostics = source.diagnostics;
  return row;
}

async function main() {
  const input = path.resolve(positionals[0] ?? path.join(here, 'basilisk-2.12.0.json'));
  const out = path.resolve(options.out ?? path.join(here, 'summary-basilisk-2.12.0.json'));
  const cacheOut = path.join(path.dirname(out), 'hpop-basilisk-2.12.0.json');
  const cacheFile = path.resolve(options.cache ?? (fs.existsSync(cacheOut) ? cacheOut : path.join(here, '../tudat/hpop-tudatpy-1.0.0.json')));
  const record = normalizedRecord(input);
  const lstProbePath = path.join(here, 'lst-probes.json');
  const lstProbes = fs.existsSync(lstProbePath) ? readJson(lstProbePath) : null;
  const diagnosticInputs = (options.diagnostics ?? []).map((file) => ({ file: path.resolve(file), record: normalizedRecord(path.resolve(file)) }));
  const diagnosticNames = diagnosticInputs.map(({ record: variant }) => variant.settings?.variant);
  if (diagnosticNames.some((name) => !['wgs84', 'wgs84-gtd7d'].includes(name)))
    throw new Error('--diagnostics accepts only wgs84 and wgs84-gtd7d native variants');
  if (new Set(diagnosticNames).size !== diagnosticNames.length) throw new Error('Duplicate --diagnostics variant');
  if (diagnosticNames.includes('wgs84-gtd7d') && !diagnosticNames.includes('wgs84'))
    throw new Error('The wgs84-gtd7d diagnostic requires the wgs84 diagnostic for a direct anomalous-oxygen comparison');
  const causes = options.causes ? readJson(options.causes) : {};
  const cache = readCache(cacheFile);
  const work = fs.mkdtempSync(path.join(here, '.score-basilisk-'));
  const rows = [];
  try {
    const metrics = buildMetrics(work);
    for (const source of record.cases) {
      let cached = cache.cases.find((c) => c.id === source.id);
      if (!cached) { cached = { id: source.id }; cache.cases.push(cached); }
      for (const setting of ALL) {
        if (!cached[setting.id]) {
          if (options['cached-only']) throw new Error(`Missing HPOP cache: ${source.id} ${setting.id}`);
          cached[setting.id] = storedResponse(await run(source, setting));
        }
      }
      const row = { ...positionRow(source, cached, metrics), stmSkipped };
      const diagnosis = causes.cases?.find?.((c) => c.id === source.id) ?? causes[source.id] ?? source;
      if (diagnosis.cause) row.cause = diagnosis.cause;
      else if (diagnosis.classification) row.cause = diagnosis;
      if (diagnosis.diagnosis) row.diagnosis = diagnosis.diagnosis;
      rows.push(row);
      console.log(`${source.id}: suite=${row.suite.worstM} m; steps30=${row.steps30.worstM} m; finest=${row.finest.worstM} m; Orekit-Basilisk=${row.orekitMinusBasilisk.worstM} m; half-step=${row.convergence.worstM} m`);
    }
    const diagnostics = {};
    for (const { file: diagnosticPath, record: diagnostic } of diagnosticInputs) {
      const name = diagnostic.settings.variant;
      const diagnosticRows = diagnostic.cases.map((source) => {
        const nominal = record.cases.find((candidate) => candidate.id === source.id);
        if (!nominal) throw new Error(`Diagnostic case is absent from nominal trajectory: ${source.id}`);
        const cached = cache.cases.find((candidate) => candidate.id === source.id);
        const row = { ...positionRow(source, cached, metrics), nominalMinusVariant: scoreDifference(nominal, source, metrics) };
        if (name === 'wgs84-gtd7d') {
          const wgs84 = diagnosticInputs.find(({ record: candidate }) => candidate.settings.variant === 'wgs84')
            .record.cases.find((candidate) => candidate.id === source.id);
          if (!wgs84) throw new Error(`Missing WGS84 diagnostic for direct anomalous-oxygen comparison: ${source.id}`);
          row.wgs84MinusVariant = scoreDifference(wgs84, source, metrics);
        }
        const diagnosis = causes.cases?.find?.((c) => c.id === source.id) ?? causes[source.id] ?? {};
        const cause = diagnosis.diagnostics?.[name]?.cause ?? source.cause ?? rows.find((candidate) => candidate.id === source.id)?.cause;
        if (cause && ALL.some((setting) => !row[setting.id].met)) row.cause = cause;
        console.log(`${name} ${source.id}: nominal-minus-variant=${row.nominalMinusVariant.worstM} m${row.wgs84MinusVariant ? `; wgs84-minus-variant=${row.wgs84MinusVariant.worstM} m` : ''}; suite=${row.suite.worstM} m; steps30=${row.steps30.worstM} m; finest=${row.finest.worstM} m; half-step=${row.convergence.worstM} m`);
        return row;
      });
      diagnostics[name] = { file: path.relative(here, diagnosticPath), sha256: pin(diagnosticPath).sha256,
        tool: diagnostic.tool, settings: diagnostic.settings, caseExportSha256: diagnostic.caseExportSha256,
        inputFiles: diagnostic.inputFiles, cases: diagnosticRows };
    }
    const snapshot = { note: cache.note, identity: cache.identity,
      cases: record.cases.map(({ id }) => {
        const source = cache.cases.find((entry) => entry.id === id);
        return { id, ...Object.fromEntries(ALL.map(({ id: setting }) => [setting, source[setting]])) };
      }) };
    writeJson(cacheOut, snapshot);
    const sourceFiles = ['scoring.mjs', 'score-basilisk.mjs', 'check-basilisk.mjs', 'run-basilisk.py', 'basilisk-backend.py',
      'investigate-basilisk.py', 'model-probes.json',
      '../nyx/scoring.mjs', '../nyx/score-metrics.cpp'].map((file) => path.resolve(here, file));
    for (const name of ['README.md', '.gitignore', 'diagnose-lst.py', 'lst-probes.json'])
      if (fs.existsSync(path.join(here, name))) sourceFiles.push(path.join(here, name));
    if (options.causes) sourceFiles.push(path.resolve(options.causes));
    const summary = {
      note: 'HPOP shipped WASM against Basilisk: maximum 3D position difference over 24 h at hourly samples, suite/steps30/finest HPOP settings and Orekit-minus-Basilisk. Every numerical reduction uses the shared Nyx C++ helper. Native half-step trajectories are stored inline.',
      module: { version: readJson(path.resolve(here, '../../../package.json')).version, sha256: pin(fileURLToPath(WASM)).sha256 },
      basilisk: { file: path.relative(here, input), sha256: pin(input).sha256, caseExportSha256: record.caseExportSha256,
        tool: record.tool, settings: record.settings, inputFiles: record.inputFiles },
      node: process.version, host: os.cpus()[0].model, settings: ALL, tolerancesM: CASES.protocol.tolerancesM.default,
      protocol: protocolFor(rows), cases: rows, skipped: record.skipped ?? [],
      ...(diagnosticInputs.length ? { diagnostics } : {}),
      verdict: verdictFor(rows, record.skipped ?? [], record.tool),
      provenance: { sourceIdentity: sourceFiles.map(pin), propagationInputs: snapshot.identity,
        hpopTrajectories: pin(cacheOut), modelProbes: pin(path.join(here, 'model-probes.json')),
        ...(lstProbes ? { lstProbes: pin(lstProbePath) } : {}),
        ...(diagnosticInputs.length ? { diagnostics: Object.fromEntries(diagnosticInputs.map(({ file, record: variant }) =>
          [variant.settings.variant, { trajectory: pin(file), inputFiles: variant.inputFiles,
            ...(variant.provenance ? { native: variant.provenance } : {}) }])) } : {}),
        ...(cacheFile !== cacheOut ? { reusedHpopCache: pin(cacheFile), reuseRule: 'All propagation input paths and SHA-256s equal the current shipped-WASM request identity; only the three state settings of supported cases are retained.' } : {}),
        ...(record.provenance ? { basilisk: record.provenance } : {}) },
      fileHashes: [pin(input), pin(exportPath), pin(cacheOut), ...sourceFiles.map(pin), ...snapshot.identity,
        ...(record.inputFiles ?? []), ...(cacheFile !== cacheOut ? [pin(cacheFile)] : []),
        ...(lstProbes?.inputFiles ?? []),
        ...diagnosticInputs.flatMap(({ file, record: variant }) => [pin(file), ...(variant.inputFiles ?? [])])],
    };
    writeJson(out, summary);
    console.log(`Wrote ${path.relative(process.cwd(), out)}: ${rows.length} scored; ${summary.skipped.length} skipped; ${summary.verdict.tool.missed} suite misses, ${summary.verdict.tool.diagnosed} diagnosed.`);
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}

await main().catch((error) => { console.log(`FAIL Basilisk score: ${error.message}`); process.exitCode = 1; });

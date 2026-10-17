#!/usr/bin/env node
// The ONE E2E for this change. Authenticate all inputs, require a cause for
// every met:false, then recompute Moon (50 raw UTC epochs) with shipped
// HPOP WASM. C++ re-scores matched Jupiter 5/5 from stored CSPICE states and
// the stored JWST runs against freshly parsed raw inputs. No trajectory
// propagation, Python, or native SPICE rerun is needed.
// Oracle: stored JPL Horizons API 1.2, Moon 301/Earth 399, DE441, geometric
// ICRF, km and km/s, 2026-06-10/11 and 2026-08-02/03 UTC.
// Physical limit: prior cross-release envelope 10m/.1mm/s (see summary).
// Replay tolerance: exact equality because artifact, inputs and reductions
// are pinned. A changed tree must regenerate and review the evidence.
// UV_THREADPOOL_SIZE=1 node --v8-pool-size=1 propagator/hpop/tests/evidence/horizons/check-horizons.mjs
import fs from 'node:fs';
import path from 'node:path';
import { here, hpop, names, targets, cases, wasmPath, read, sha256, authenticateRaw, buildMetrics,
  parseRaw, harness, bodyStates, compare, brief } from './horizons-common.mjs';

const errors = [];
const check = (ok, message) => { if (!ok) errors.push(message); };
const nonempty = (v) => typeof v === 'string' && v.trim().length > 0;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function exactScore(actual, expected, label) {
  for (const [key, value] of Object.entries(actual)) {
    if (key === 'subMeter') {
      check(expected?.subMeter?.toleranceM === value.toleranceM && expected.subMeter.met === value.met,
        `${label}: sub-metre replay differs`);
    } else check(same(expected?.[key], value), `${label}: ${key} differs: actual=${JSON.stringify(value)}, summary=${JSON.stringify(expected?.[key])}`);
  }
}
async function main() {
  const summary = read(path.resolve(process.argv[2] ?? path.join(here, 'summary-horizons.json')));
  const authenticated = authenticateRaw();
  check(summary.module?.sha256 === sha256(wasmPath), 'shipped WASM hash differs');
  check(summary.module?.version === read(path.join(hpop, 'package.json')).version, 'module version differs');
  check(summary.horizons?.version === '1.2' && summary.horizons.sampleCountPerBody === 50, 'Horizons metadata differs');
  check(summary.horizons?.fetched === authenticated.index.fetched, 'Horizons fetch identity differs from current raw index');
  for (const name of names) {
    const expected = summary.horizons?.rawFiles?.[name], actual = authenticated.files[name];
    for (const key of ['file', 'sha256', 'responseSha256', 'target', 'targetSource', 'centerSource']) {
      check(expected?.[key] === actual[key], `${name}: ${key} differs from raw/index`);
    }
    check(String(authenticated.index.bodies[name]?.command) === String(targets[name]), `${name}: raw target differs from the required target`);
  }
  const pinned = new Set();
  function verify(entry) {
    check(nonempty(entry?.file) && /^[0-9a-f]{64}$/.test(entry?.sha256), 'invalid pinned file entry');
    if (!entry?.file) return;
    const file = path.resolve(here, entry.file);
    check(sha256(file) === entry.sha256, `pinned file changed: ${entry.file}`);
    pinned.add(file);
  }
  check(Array.isArray(summary.fileHashes) && summary.fileHashes.length > 0, 'missing source hashes');
  for (const entry of summary.fileHashes ?? []) verify(entry);
  for (const entry of [summary.provenance?.caseExport, summary.provenance?.ephemeris,
    summary.provenance?.spice?.lsk, summary.provenance?.jwstPublishedExample]) verify(entry);
  for (const file of ['run-horizons.mjs', 'horizons-common.mjs', 'horizons-metrics.cpp', 'spice-reference.py',
    'check-horizons.mjs', 'raw/index.json', 'horizons-comparisons.json']) {
    check(pinned.has(path.join(here, file)), `missing required provenance: ${file}`);
  }
  let misses = 0;
  function visit(value, label = 'summary') {
    if (!value || typeof value !== 'object') return;
    if (value.met === false) {
      misses++;
      check(nonempty(value.cause?.classification) && nonempty(value.cause?.statement)
        && value.cause.evidence && Object.keys(value.cause.evidence).length > 0, `${label}: met:false has no documented cause`);
    }
    for (const [key, child] of Object.entries(value)) visit(child, `${label}.${key}`);
  }
  visit(summary);
  check(summary.bodies?.length === 4 && new Set(summary.bodies.map((r) => r.body)).size === 4
    && summary.bodies.every((r) => ['sun', 'moon', 'venus', 'jupiter'].includes(r.body)), 'body coverage differs');
  for (const row of summary.bodies ?? []) {
    check(row.sampleCount === 50 && row.positionToleranceM === 10 && row.velocityToleranceMmS === 0.1, `${row.body}: sample count or fixed tolerance changed`);
    check(row.met === (row.maxPositionM < 10 && row.maxVelocityMmS < 0.1), `${row.body}: met differs from fixed bounds`);
    check(row.subMeter?.toleranceM === 1 && row.subMeter.met === (row.maxPositionM < 1), `${row.body}: sub-metre flag differs`);
    check(row.target === targets[row.body] && String(row.horizonsTarget) === String(targets[row.body]) && row.center === 399,
      `${row.body}: summary must compare identical targets about Earth 399`);
    check(row.horizonsSource === authenticated.files[row.body]?.targetSource, `${row.body}: target-source attribution differs from current raw`);
  }
  check(summary.jwst?.rows?.length === 2 && summary.jwst.sampleCount === 25
    && summary.jwst.epochUtc === '2026-06-10T00:00:00.000' && summary.jwst.finalEpochUtc === '2026-06-11T00:00:00.000', 'JWST coverage differs');
  for (const row of summary.jwst?.rows ?? []) {
    check(row.positionToleranceM === 10000 && row.toleranceKm === 10 && row.sampleCount === 25
      && row.met === (row.maxPositionM < 10000), `${row.id}: JWST bound differs`);
  }
  check(!summary.skipped?.some((r) => r.id === 'jupiter-exact-center-599'), 'obsolete Jupiter 599 mismatch skip must be removed');
  const jupiter = summary.bodies?.find((r) => r.body === 'jupiter');
  check(targets.jupiter === 5 && jupiter?.target === 5 && String(jupiter.horizonsTarget) === '5'
    && jupiter.releaseAttribution?.applicable === true, 'Jupiter must be a real 5-versus-5 comparison with applicable release attribution');
  check(authenticated.files.jupiter.targetSource === 'DE441' && authenticated.files.jupiter.centerSource === 'DE441',
    'Jupiter barycenter/Earth reference must use the current DE441 raw response');
  check(summary.verdict?.bodiesMet === summary.bodies?.filter((r) => r.met).length
    && summary.verdict.bodiesTotal === 4 && summary.verdict.jwstMet === summary.jwst?.rows?.filter((r) => r.met).length
    && nonempty(summary.verdict.statement), 'verdict counts/statement differ');
  if (errors.length) throw new Error('provenance/summary validation failed: ' + errors.join('; '));
  console.log(`Hashes: 5 raw response hashes match index.json; 5 on-disk raw hashes, shipped WASM and ${pinned.size} pinned files verified.`);
  console.log(`Coverage: 4 bodies x 50 epochs; JWST 2 runs x 25 samples; ${misses} met:false entries have documented causes.`);

  const work = fs.mkdtempSync(path.join(here, '.check-horizons-'));
  try {
    const metrics = await buildMetrics(work);
    const stored = read(path.join(here, 'horizons-comparisons.json'));
    const parsed = Object.fromEntries(names.map((name) => [name, parseRaw(metrics, authenticated, name)]));
    for (const name of names) check(same(stored.parsed?.[name], parsed[name]), `${name}: stored parsed inputs differ from current raw response`);
    for (const name of names.filter((name) => name !== 'jwst')) {
      const body = stored.spice?.bodies?.[name];
      check(body?.target === targets[name] && body?.epochs?.length === 50, `${name}: stored SPICE target/coverage differs`);
      for (const [index, row] of (body?.epochs ?? []).entries()) {
        const input = parsed[name].rows[index];
        for (const key of ['utc', 'rawUtcIso', 'rawJdUtcText']) {
          check(row[key] === input?.[key], `${name}: stored SPICE ${key} at sample ${index} differs from its own raw epoch`);
        }
      }
    }
    check(same(stored.spice?.kernelTargetIds, summary.provenance?.spice?.kernelTargetIds)
      && stored.spice.kernelTargetIds.includes(5), 'stored SPICE target inventory differs or lacks Jupiter barycenter 5');

    const jupiterStates = stored.spice.bodies.jupiter.epochs;
    const jupiterReference = parsed.jupiter.rows.map((row) => row.state);
    const epochs = authenticated.index.epochsUtc;
    const jupiterActual = brief(compare(metrics, jupiterStates.map((row) => row.rawUtc), jupiterReference, epochs, 10, 0.1));
    exactScore(jupiterActual, jupiter, 'Jupiter matched-target re-score');
    exactScore(jupiterActual, jupiter.diagnostics?.spiceAtRawUtcMinusHorizons, 'Jupiter raw-UTC release diagnostic');
    for (const [key, actual, reference] of [
      ['nominalExportEpochMinusHorizons', jupiterStates.map((row) => row.nominalUtc), jupiterReference],
      ['tlistEpochOnly', jupiterStates.map((row) => row.nominalUtc), jupiterStates.map((row) => row.rawUtc)],
      ['spiceJdParserMinusHorizons', jupiterStates.map((row) => row.jdParserUtc), jupiterReference],
      ['spiceJdParserMinusSplitDecimalUtc', jupiterStates.map((row) => row.jdParserUtc), jupiterStates.map((row) => row.rawUtc)],
    ]) exactScore(brief(compare(metrics, actual, reference, epochs, 10, 0.1)), jupiter.diagnostics?.[key], `Jupiter ${key}`);
    check(jupiter.releaseAttribution.consistentWithPriorModernCrossReleaseEnvelope === jupiterActual.met,
      'Jupiter release attribution differs from the fixed-bound SPICE re-score');
    check(same(jupiter.releaseAttribution.evidence, { target: 5, center: 399,
      maxPositionM: jupiterActual.maxPositionM, maxVelocityMmS: jupiterActual.maxVelocityMmS,
      tlistEpochOnlyMaxPositionM: jupiter.diagnostics.tlistEpochOnly.maxPositionM,
      spiceUtcRepresentationMaxPositionM: jupiter.diagnostics.spiceJdParserMinusSplitDecimalUtc.maxPositionM,
      spiceJdParserMinusHorizonsMaxPositionM: jupiter.diagnostics.spiceJdParserMinusHorizons.maxPositionM }),
    'Jupiter residual explanation differs from the re-scored measurements');
    console.log(`Jupiter re-score: target 5 vs 5, ${jupiterActual.sampleCount} epochs; max position=${jupiterActual.maxPositionM} m; max velocity=${jupiterActual.maxVelocityMmS} mm/s; fixed limits 10 m/0.1 mm/s.`);

    const jwstRows = parsed.jwst.rows.slice(0, 25);
    const jwstReference = jwstRows.map((row) => row.state), jwstEpochs = jwstRows.map((row) => row.utc);
    check(same(summary.jwst.initialStateKmKmS, jwstReference[0]), 'JWST summary initial state differs from current raw input');
    check(same(summary.jwst.parameters, metrics({ mode: 'parameters', constants: cases.constants })), 'JWST stored physical inputs differ from the published parameter recipe');
    const jwstScores = {};
    for (const id of ['withSrp', 'noSrp']) {
      const run = stored.jwst?.[id];
      const expected = summary.jwst.rows.find((row) => row.id === id);
      check(run?.states?.length === 25 && same(run?.states?.[0], jwstReference[0]) && run?.ephemerisSource === 'JPL_SPK',
        `JWST ${id}: stored trajectory inputs or ephemeris source differ`);
      check(run?.acceptedSteps === expected?.acceptedSteps, `JWST ${id}: stored integration count differs`);
      jwstScores[id] = brief(compare(metrics, run.states, jwstReference, jwstEpochs, 10000, null, false));
      exactScore(jwstScores[id], expected, `JWST ${id} stored re-score`);
    }
    const toggle = brief(compare(metrics, stored.jwst.withSrp.states, stored.jwst.noSrp.states, jwstEpochs, 10000, null, false));
    exactScore(toggle, summary.jwst.srpMinusNoSrp, 'JWST SRP-toggle stored re-score');
    check(same(summary.jwst.sensitivityRatios, metrics({ mode: 'sensitivity', toggleKm: toggle.maxPositionKm,
      withSrpKm: jwstScores.withSrp.maxPositionKm, noSrpKm: jwstScores.noSrp.maxPositionKm })), 'JWST sensitivity ratios differ from stored inputs');
    console.log('JWST stored inputs: current raw initial state and published parameters verified; both 25-sample scores and SRP-toggle sensitivity re-scored in C++.');

    const h = await harness(); let states;
    try { states = await bodyStates(h, parsed.moon.rows, targets.moon); } finally { h.destroy(); }
    const actual = brief(compare(metrics, states, parsed.moon.rows.map((r) => r.state), authenticated.index.epochsUtc));
    const expected = summary.bodies.find((r) => r.body === 'moon');
    exactScore(actual, expected, 'Moon shipped-WASM replay');
    console.log(`Moon replay: ${actual.sampleCount} epochs; max position=${actual.maxPositionM} m; max velocity=${actual.maxVelocityMmS} mm/s; ${errors.length ? 'MISMATCH' : 'exact summary match'}.`);
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
  for (const error of errors) console.log(`FAIL: ${error}`);
  console.log(`${errors.length ? 'FAIL' : 'PASS'} Horizons evidence E2E: ${errors.length} failure(s).`);
  process.exitCode = errors.length ? 1 : 0;
}
await main().catch((error) => {
  console.log(`FAIL Horizons evidence E2E: ${error.message}`);
  if (error.stderr) console.log(String(error.stderr).trim());
  process.exitCode = 1;
});

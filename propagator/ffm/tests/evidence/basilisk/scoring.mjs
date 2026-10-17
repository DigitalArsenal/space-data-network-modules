// Evidence transport only. FFM propagation is the shipped WASM; all
// position reductions and conversions use the existing Nyx C++ reducer.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decodeResult } from '../../lib/prwCodec.mjs';
import { ALL, CASES, WASM, MANIFEST, sha256, reference, run, scoreResponse } from '../nyx/scoring.mjs';

export { ALL, CASES, WASM, MANIFEST, sha256, reference, run, scoreResponse };
export const here = path.dirname(fileURLToPath(import.meta.url));
export const exportPath = path.resolve(here, '../cases/ffm-reference-cases.json');
export const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
export const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 1)}\n`);
export const pin = (file) => ({ path: path.relative(here, path.resolve(file)), sha256: sha256(file) });
export const stmSkipped = 'Basilisk spacecraft has no variational equations for the 6x6 STM or exported parameter sensitivities; state-only cases are scored and cases explicitly requesting sensitivities are skipped.';

export function buildMetrics(workDir) {
  fs.mkdirSync(workDir, { recursive: true });
  const directory = path.resolve(workDir);
  const binary = path.join(directory, 'score-metrics');
  try { if (os.getPriority(0) < 10) os.setPriority(0, 10); } catch (error) {
    if (!['EACCES', 'EPERM'].includes(error.info?.code ?? error.code)) throw error;
  }
  const options = { cwd: directory, env: { ...process.env, TMPDIR: directory,
    OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1', MKL_NUM_THREADS: '1' }, stdio: ['pipe', 'pipe', 'pipe'] };
  execFileSync('c++', ['-std=c++17', '-O2', '-I', path.resolve(here, '../../../src/cpp/include'),
    path.resolve(here, '../nyx/score-metrics.cpp'), '-o', binary], options);
  return (input) => JSON.parse(execFileSync(binary, [], {
    ...options, input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 32 << 20,
  }));
}

export function normalizedRecord(file) {
  const document = readJson(file);
  const cases = document.cases.map((source) => {
    const exported = CASES.cases.find((candidate) => candidate.id === source.id);
    if (!exported) throw new Error(`Basilisk source contains unknown case: ${source.id}`);
    for (const key of ['orbit', 'forceSet', 'row', 'toleranceClass']) {
      if (source[key] !== undefined && source[key] !== exported[key])
        throw new Error(`${source.id}: source ${key} differs from the shared export`);
    }
    return { ...source, orbit: exported.orbit, forceSet: exported.forceSet,
      row: exported.row, toleranceClass: exported.toleranceClass };
  });
  if (new Set(cases.map((c) => c.id)).size !== cases.length) throw new Error('Duplicate Basilisk source case');
  return { ...document, cases };
}

export function propagationIdentity() {
  return [fileURLToPath(WASM), fileURLToPath(MANIFEST), exportPath,
    path.resolve(here, '../../lib/orekitCases.mjs'), path.resolve(here, '../../lib/prwCodec.mjs'),
    path.resolve(here, '../nyx/scoring.mjs'), path.resolve(here, '../../fixtures/orekit/orekit-reference.json'),
    path.resolve(here, '../../fixtures/orekit/eop-2026-08.json'), path.resolve(here, '../../fixtures/orekit/eop-2026-06.json'),
    path.resolve(here, '../../fixtures/orekit/jb2008-2026-06.json'), path.resolve(here, '../../fixtures/orekit/spw-2026-08.json'),
    path.resolve(here, '../../../../../files/orbit-products/tests/fixtures/de440/de440-2026.bsp')].map(pin);
}

export function readCache(file) {
  const identity = propagationIdentity();
  if (!fs.existsSync(file)) return { note: 'Shipped FFM WASM positions in km; all numerical reductions use the shared Nyx C++ helper.', identity, cases: [] };
  const cache = readJson(file);
  // The sibling evidence directories have the same depth. Resolve each pin
  // against its actual cache directory so reuse is not tied to that layout.
  const expected = new Map(identity.map((entry) => [path.resolve(here, entry.path), entry.sha256]));
  if (!Array.isArray(cache.identity) || cache.identity.length !== expected.size)
    throw new Error(`FFM cache identity is incomplete: ${file}`);
  for (const entry of cache.identity) {
    const resolved = path.resolve(path.dirname(file), entry.path);
    if (expected.get(resolved) !== entry.sha256 || sha256(resolved) !== entry.sha256)
      throw new Error(`FFM cache input hash mismatch: ${resolved}`);
    expected.delete(resolved);
  }
  if (expected.size) throw new Error(`FFM cache identity is incomplete: ${file}`);
  return { ...cache, identity };
}

export function storedResponse(response) {
  const result = decodeResult(response);
  return { positions: result.samples.map((sample) => sample.position), steps: result.samples.at(-1).integrationSteps };
}

export function scoreStored(stored, source, metrics) {
  if (!stored) throw new Error(`${source.id}: FFM trajectory setting is missing`);
  return { ...metrics({ mode: 'positions', positions: stored.positions, scale: 1000, samples: source.samples }), steps: stored.steps };
}
export function scoreOrekit(source, metrics) {
  return metrics({ mode: 'positions', positions: reference(source).samples.slice(1).map((sample) => sample.slice(1, 4)), scale: 1, samples: source.samples });
}
export function scoreDifference(source, other, metrics) {
  return metrics({ mode: 'positions', positions: source.samples.slice(1).map((sample) => sample.slice(1, 4)), scale: 1, samples: other.samples });
}
export function scoreConvergence(source, metrics) {
  return scoreDifference(source, { samples: source.fineSamples }, metrics);
}

export function causePresent(cause) {
  return cause && ['model-setting mismatch', 'Basilisk defect', 'FFM defect'].includes(cause.classification)
    && typeof cause.statement === 'string' && cause.statement.trim().length > 0
    && cause.evidence && typeof cause.evidence === 'object' && Object.keys(cause.evidence).length > 0;
}

export function protocolFor(rows) {
  const cases = rows.map((row) => CASES.cases.find((candidate) => candidate.id === row.id));
  if (cases.some((entry) => !entry)) throw new Error('Protocol contains a case outside the shared export');
  return {
    source: { path: '../cases/ffm-reference-cases.json', section: 'protocol', sha256: sha256(exportPath) },
    units: { position: 'm', velocity: 'm/s' },
    frames: [...new Set(cases.map((entry) => entry.frame))],
    frameRule: 'Geocentric GCRF; the ERFA IAU 2006/2000A chain driven by exported EOP supplies GCRF-to-ITRF gravity orientation.',
    epochTimeScale: 'UTC', epochsUtc: [...new Set(cases.map((entry) => entry.epochUtc))],
    arcS: CASES.protocol.arcS, sampleStepS: CASES.protocol.sampleStepS, sampleCountIncludingInitial: CASES.protocol.samples,
    dynamicsClock: 'TT', ephemerisClock: 'TDB',
    metric: 'Maximum 3D position separation over the 24 propagated hourly samples; the common initial state is stored but excluded from reduction.',
    tolerancesM: CASES.protocol.tolerancesM.default,
    toleranceRationale: 'Unchanged shared protocol: 1 mm point mass, 5 cm gravity/rotation, 0.1 m SRP and drag. Each prescribed class is independent of the observed discrepancies; GMAT allowances do not apply.',
    nativeConvergenceLimitM: 0.0003,
    convergenceRationale: 'Halving the Basilisk maximum step must change each reported trajectory by less than 0.3 mm, below the strictest 1 mm comparison limit.',
    replayTolerance: 0,
    replayRationale: 'Identical stored state bytes and the shared C++ reducer must reproduce every score exactly; one fresh run uses identical shipped FFM WASM and suite request settings.',
    verdictSetting: 'suite', stmTolerance: null, stmToleranceRationale: stmSkipped,
  };
}

export function verdictFor(rows, skipped, tool) {
  const missed = rows.filter((row) => !row.met);
  return {
    tool: { version: tool.version, total: rows.length, met: rows.filter((row) => row.met).length,
      missed: missed.length, diagnosed: missed.filter((row) => causePresent(row.cause)).length,
      statement: 'Counts use the FFM suite request and unchanged shared tolerances. Every missed limit requires a measured cause; smaller FFM steps are reported separately.' },
    coverage: { exported: CASES.cases.length, scored: rows.length, skipped: skipped.length },
    integration: { limitM: 0.0003, checked: rows.filter((row) => row.convergence).length,
      met: rows.filter((row) => row.convergence?.met).length,
      statement: 'Every reported Basilisk state trajectory has an explicit half-step run with maximum hourly position change below 0.3 mm.' },
    stm: { compared: 0, omitted: rows.length, statement: stmSkipped },
  };
}

// File/ABI orchestration only. All numerical calculations: C++/shipped WASM/CSPICE.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';
import { composeErfaTranslationUnit } from '../../../../../foundation/frames/erfa-amalgamation.mjs';
import { requestFor, decodeResult, encodePrw, execution, nativeInput, TYPE, makeTable, sds } from '../../lib/prwCodec.mjs';

export const here = path.dirname(fileURLToPath(import.meta.url));
export const hpop = path.resolve(here, '../../..');
export const repo = path.resolve(hpop, '../..');
export const casesPath = path.join(here, '../cases/hpop-reference-cases.json');
export const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
export const cases = read(casesPath);
export const wasmPath = path.join(hpop, 'dist/isomorphic/module.wasm');
export const de440Path = path.join(repo, cases.models.ephemeris.path);
export const sha256 = (file) => hash(fs.readFileSync(file));
export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
// One target contract for raw authentication and both native/WASM readers.
// DE440 carries Jupiter's system barycentre (5), not its body centre (599).
export const targets = Object.freeze({ sun: 10, moon: 301, venus: 299, jupiter: 5, jwst: -170 });
export const names = Object.keys(targets);
export const env = { ...process.env, OMP_NUM_THREADS: '2', OPENBLAS_NUM_THREADS: '1', MKL_NUM_THREADS: '1', VECLIB_MAXIMUM_THREADS: '1', PYTHONDONTWRITEBYTECODE: '1' };
export const write = (file, value) => fs.writeFileSync(path.join(here, file), JSON.stringify(value, null, 1) + '\n');

export function authenticateRaw() {
  const index = read(path.join(here, 'raw/index.json'));
  const epochs = [...new Set(cases.cases.flatMap((c) => [c.epochUtc, ...c.sampleEpochsUtc]))].sort();
  if (epochs.length !== 50 || JSON.stringify(epochs) !== JSON.stringify(index.epochsUtc)) throw new Error('raw index does not cover the 50 exported epochs');
  const files = {};
  for (const name of names) {
    if (index.bodies[name]?.command !== String(targets[name])) throw new Error(`${name}: raw target differs from comparison target ${targets[name]}`);
    const file = path.join(here, 'raw', name + '.json'); const raw = read(file);
    // The fetcher recorded HTTP bytes, then pretty-printed on disk. The exact
    // original serialization is recoverable and MUST match; never rewrite index.
    const responseSha256 = hash(JSON.stringify(raw) + '\n');
    if (responseSha256 !== index.bodies[name]?.sha256) throw new Error(`${name}: raw response hash differs from index.json`);
    if (raw.signature?.version !== '1.2' || raw.signature?.version !== index.bodies[name].version || index.bodies[name].status !== 200) throw new Error(`${name}: unexpected Horizons version/status`);
    for (const pattern of [/Center body name:\s+Earth \(399\)/, /Reference frame\s+: ICRF/, /Output units\s+: KM-S/,
      /Output type\s+: GEOMETRIC cartesian states/, /JDUT/, /Start time[^\n]+ UT/]) {
      if (!pattern.test(raw.result)) throw new Error(`${name}: Horizons convention mismatch: ${pattern}`);
    }
    const target = raw.result.match(/Target body name:\s*(.+?)\s*\{source: ([^}]+)\}/);
    const center = raw.result.match(/Center body name:[^\n]+\{source: ([^}]+)\}/);
    if (!target || !center || !target[1].includes(`(${index.bodies[name].command})`)) throw new Error(`${name}: target mismatch`);
    files[name] = { file: `raw/${name}.json`, sha256: sha256(file), responseSha256,
      target: target[1], targetSource: target[2], centerSource: center[1], raw };
  }
  if (sha256(de440Path) !== cases.models.ephemeris.sha256) throw new Error('DE440 differs from shared case export');
  return { index, files };
}

export async function buildMetrics(work, flatbuffers) {
  const inc = flatbuffers ?? process.env.XVAL_FLATBUFFERS ?? '/Users/tj/software/spacedatanetwork-stack/repos/main-packages/flatbuffers/include';
  const binary = path.join(work, 'horizons-metrics');
  const erfa = await composeErfaTranslationUnit();
  const erfaUnit = path.join(work, 'erfa-amalgamation.cpp');
  fs.writeFileSync(erfaUnit, erfa.source);
  const includes = [inc, path.join(hpop, 'lib'), path.join(hpop, 'src/cpp/include'), path.join(hpop, 'src/cpp/generated'), path.join(hpop, 'src/cpp/generated/sds'), path.join(repo, 'higherpop/third_party/erfa')];
  execFileSync('c++', ['-std=c++17', '-O2', ...includes.flatMap((x) => ['-I', x]), path.join(here, 'horizons-metrics.cpp'),
    path.join(hpop, 'lib/time_convert.cpp'), erfaUnit, '-o', binary], { cwd: work, env: { ...env, TMPDIR: work, TMP: work, TEMP: work }, stdio: ['ignore', 'pipe', 'pipe'] });
  return (input) => JSON.parse(execFileSync(binary, [], { input: JSON.stringify(input), encoding: 'utf8', cwd: work, env: { ...env, TMPDIR: work, TMP: work, TEMP: work }, maxBuffer: 16 << 20 }));
}
export function parseRaw(metrics, authenticated, name) {
  return metrics({ mode: 'parse', result: authenticated.files[name].raw.result, epochs: authenticated.index.epochsUtc });
}
export function compare(metrics, actual, reference, epochs, positionToleranceM = 10, velocityToleranceMmS = 0.1, includeSubMeter = true) {
  return metrics({ mode: 'compare', actual, reference, epochs, positionToleranceM, velocityToleranceMmS, includeSubMeter });
}
export const brief = ({ samples, ...score }) => score;
export async function harness() {
  return createBrowserModuleHarness({ wasmSource: fs.readFileSync(wasmPath), manifest: read(path.join(hpop, 'plugin-manifest.json')), surface: 'command' });
}
export async function bodyStates(h, rows, target, epochKey = 'jdTdb') {
  const kernel = fs.readFileSync(de440Path); const states = [];
  for (const row of rows) {
    // Identical ephemeris ABI call to evidence/erfa-spice/run-erfa-spice.mjs.
    const r = await h.invoke(requestFor('ephemeris', { target, center: 399, epochTDBJD: row[epochKey] }, kernel));
    if (r.statusCode !== 0) throw new Error(`${target} at ${row.utc}: ${r.errorMessage}`);
    const d = decodeResult(r);
    if (d.ephemerisSource !== 'JPL_SPK') throw new Error('WASM did not use the supplied SPK kernel');
    states.push([...d.position, ...d.velocity]);
  }
  return states;
}
export async function jwstRun(h, rows, parameters, srp) {
  const first = rows[0];
  const params = { epochJD: first.rawJdUtc, epochTimeScale: 'UTC', position: first.state.slice(0, 3), velocity: first.state.slice(3),
    frame: 'GCRF', massKg: parameters.massKg, targetJD: rows.at(-1).jdTdb,
    forces: { centralBody: true, j2: false, j3: false, j4: false, higherZonals: false, gravityMode: 'POINT_MASS',
      mu: parameters.earthGmKm3S2, thirdBody: true, thirdBodySun: true, thirdBodyMoon: true, srp, drag: false,
      areaM2: parameters.areaM2, cr: parameters.cr, massKg: parameters.massKg },
    integrator: { method: 'RK78', tolerance: 1e-13, initialStep: 60, minStep: 0.001, maxStep: 300, maxSteps: 100000 } };
  const request = execution(params, true);
  // Use explicit UTC epochs so C++ does the conversion; initial ISO is exact.
  request.INITIAL.STATE.EPOCH = first.utc;
  const utc = (row) => makeTable('TIMInstant', { TIME_SYSTEM: sds.timingStandard.UTC,
    EPOCH_FORMAT: sds.timEpochRepresentation.ISO8601, ISO8601: row.rawUtcIso });
  request.TARGET_EPOCH = utc(rows.at(-1));
  request.SAMPLE_EPOCHS = rows.slice(1).map(utc);
  const r = await h.invoke({ methodId: 'invoke', inputs: [
    { portId: 'request', typeRef: TYPE, payload: encodePrw('EXECUTION_REQUEST', request) },
    { portId: 'kernel', typeRef: TYPE, payload: nativeInput(fs.readFileSync(de440Path)) },
  ] });
  if (r.statusCode !== 0) throw new Error(`JWST srp=${srp}: ${r.errorMessage}`);
  const d = decodeResult(r);
  if (d.samples.length !== 24 || d.ephemerisSource !== 'JPL_SPK') throw new Error('unexpected JWST response');
  return { states: [first.state, ...d.samples.map((s) => [...s.position, ...s.velocity])],
    acceptedSteps: d.integrationSteps, rejectedSteps: d.integrationRejections, ephemerisSource: d.ephemerisSource };
}

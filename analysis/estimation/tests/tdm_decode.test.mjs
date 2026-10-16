// The $TDM decoder, end to end and in its arithmetic.
//
// 1. tdm_decode_conformance.cpp (native): time systems, leap seconds, time
//    tags, PATH, integration, angles, weather and the troposphere they feed,
//    against values worked by hand and the estimator's own models.
// 2. A synthetic two-way laser campaign. tdm_truth.cpp (an independent
//    analytic orbit and exact light time, native) writes the normal points;
//    this file only formats them as CRD text. Then, through the real modules:
//    ilrs-crd-source (CRD -> $TDM) -> analysis/estimation fit_batch (with the
//    test-only C++ two-body provider answering its queries). Nothing in this
//    file computes dynamics.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing/browser';
import { Builder } from 'flatbuffers';
import { CRD, CRDT } from 'spacedatastandards.org/lib/js/CRD/CRD.js';
import { crdFile, pass } from '../../../data-source/ilrs-crd-source/tests/fixtures/crd-format.mjs';
import { encode, pack, typeRef, unpack } from './wire.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const compile = (sources, binary, extra = []) => execFileSync(process.env.CXX || 'c++', ['-std=c++17', '-O2', '-Wall', '-Wextra', '-Werror', '-I', path.join(root, 'src'),
  path.join(root, 'src', 'estimation.cpp'), ...sources.map((s) => path.join(root, 'tests', s)), ...extra, '-o', binary], { stdio: 'inherit' });

test('the decoder arithmetic: time systems, tags, PATH, integration, angles, weather and troposphere', () => {
  const binary = path.join(os.tmpdir(), `tdm-decode-conformance-${process.pid}`);
  compile(['tdm_decode_conformance.cpp'], binary);
  try {
    const report = JSON.parse(execFileSync(binary, { encoding: 'utf8' }));
    assert.equal(report.failures, 0);
    assert.ok(report.checks >= 50, JSON.stringify(report));
  } finally {
    fs.rmSync(binary, { force: true });
  }
});

// ---- the campaign ----------------------------------------------------------------------------------------------------
const ilrsRoot = path.resolve(here, '../../../data-source/ilrs-crd-source');
const ilrsRequire = createRequire(path.join(ilrsRoot, 'package.json'));
const ilrsImport = (specifier) => import(pathToFileURL(ilrsRequire.resolve(specifier)));
const { encodeHttpResponse } = await ilrsImport('space-data-module-sdk/runtime-contracts');
const flatbuffersModule = await ilrsImport('flatbuffers');
const ilrsFlatbuffers = flatbuffersModule.default ?? flatbuffersModule;
const { TDM } = await ilrsImport('spacedatastandards.org/lib/js/TDM/TDM.js');
const { TDMSegmentT } = await ilrsImport('spacedatastandards.org/lib/js/TDM/TDMSegment.js');
const { TDMObservationT } = await ilrsImport('spacedatastandards.org/lib/js/TDM/TDMObservation.js');

const unpackTdm = (bytes) => TDM.getRootAsTDM(new ilrsFlatbuffers.ByteBuffer(new Uint8Array(bytes))).unpack();
const packTdm = (record) => { const b = new ilrsFlatbuffers.Builder(1 << 16); TDM.finishTDMBuffer(b, record.pack(b)); return b.asUint8Array().slice(); };
const crdRecord = (x, y, z) => {
  const b = new Builder(256);
  CRD.finishCRDBuffer(b, Object.assign(new CRDT(), { X: x, Y: y, Z: z }).pack(b));
  return b.asUint8Array().slice();
};
const TDM_TYPE = { schemaName: 'TDM.fbs', fileIdentifier: '$TDM', rootTypeName: 'TDM', wireFormat: 'flatbuffer' };
const CRD_TYPE = { schemaName: 'CRD.fbs', fileIdentifier: '$CRD', rootTypeName: 'CRD', wireFormat: 'flatbuffer' };
const HRSP = { schemaName: 'HttpResponse.fbs', fileIdentifier: 'HRSP', rootTypeName: 'HttpResponse', wireFormat: 'flatbuffer' };

const harness = (dir) => createBrowserModuleHarness({
  wasmSource: fs.readFileSync(path.join(dir, 'dist/isomorphic/module.wasm')),
  manifest: JSON.parse(fs.readFileSync(path.join(dir, 'plugin-manifest.json'), 'utf8')), surface: 'direct' });

const truthBinary = path.join(os.tmpdir(), `tdm-truth-${process.pid}`);
compile(['tdm_truth.cpp'], truthBinary);
const scenarios = Object.fromEntries(['plain', 'weather'].map((name) => [name, JSON.parse(execFileSync(truthBinary, [name], { encoding: 'utf8', maxBuffer: 1 << 26 }))]));
fs.rmSync(truthBinary, { force: true });

// CRD text, one session per pass, normal points at the transmit instants (event 2) or labelled as receive (event 0).
function crdText(scenario, { event = 2, meteo = false } = {}) {
  const sessions = [...new Set(scenario.points.map((p) => p.pass))].map((k) => {
    const points = scenario.points.filter((p) => p.pass === k);
    const first = Number(points[0].sod);
    const start = [2026, 10, 11, Math.floor(first / 3600), Math.floor(first / 60) % 60, Math.floor(first) % 60];
    const w = scenario.weather[k];
    return pass({ start, points: points.map((p) => ({ sod: p.sod, tof: p.tof, event, window: '120.0', raw: 50, rms: '1.0' })),
      meteo: meteo ? [{ sod: points[0].sod, p: w.hpa, t: w.kelvin, h: w.percent }] : [] });
  });
  return crdFile(sessions);
}

// Right ascension and declination, degrees, at the receive instants: one segment of the campaign's $TDM. A single fixed station
// measuring ranges cannot see a rotation of the whole orbit about its own vertical (every range, and the central gravity, are
// unchanged by it), so the angles are what make the problem observable; the laser ranges set the accuracy.
function angleSegment(scenario) {
  const segment = new TDMSegmentT();
  Object.assign(segment, { TIME_SYSTEM: 'UTC', TIMETAG_REF: 'RECEIVE', ANGLE_TYPE: 'RADEC', PATH: '1,2', MODE: 'SINGLE_TRACK', DATA_TYPES: 'ANGLE_1,ANGLE_2' });
  for (const p of scenario.points) {
    segment.OBSERVATIONS.push(Object.assign(new TDMObservationT(), { KEYWORD: 'ANGLE_1', EPOCH: p.rx_utc, VALUE: Number(p.ra_deg) }),
      Object.assign(new TDMObservationT(), { KEYWORD: 'ANGLE_2', EPOCH: p.rx_utc, VALUE: Number(p.dec_deg) }));
  }
  return segment;
}

async function readCrd(ilrs, text, scenario = null) {
  const body = new TextEncoder().encode(text);
  const result = await ilrs.invoke({ methodId: 'read_crd', inputs: [{ portId: 'source', typeRef: HRSP,
    payload: encodeHttpResponse({ url: 'https://edc.dgfi.tum.de/pub/slr/data/npt_crd_v2/lageos1/2026/lageos1_20261011.np2', status: 200, error: '', headers: { 'content-type': 'text/plain' }, body, retrievedMs: Date.UTC(2026, 9, 14) }) }] });
  assert.equal(result.statusCode, 0, result.errorMessage);
  const records = result.outputs.filter((f) => f.portId === 'observations').map((f) => unpackTdm(f.payload));
  // One $TDM for the campaign: the passes' segments, in order (fit_batch takes one tracking_data record).
  const merged = records[0];
  for (const next of records.slice(1)) merged.SEGMENTS.push(...next.SEGMENTS);
  if (scenario) {
    merged.SEGMENTS.push(angleSegment(scenario));
    [merged.OBSERVER_X, merged.OBSERVER_Y, merged.OBSERVER_Z] = scenario.station;  // the angles are measured from the same station
  }
  return merged;
}

const OFFSET = [120, -90, 60, 0.12, -0.08, 0.05];  // the a priori state is wrong by 150 m and 0.16 m/s
const norm = (v) => Math.hypot(...v);

// fit_batch to completion on a $TDM and a $CRD, the two-body provider answering its propagation queries.
async function fit(estimator, provider, scenario, tdmRecord, { models, options = {} }) {
  const envelope = unpack(encode({ request: {
    config: { initial_epoch: scenario.reference, initial_state: [0, 0, 0, 0, 0, 0], initial_covariance: Array(36).fill(0), process_noise_spectral_density: [0, 0, 0, 0, 0, 0],
      state_convergence_tolerance: 0, rms_convergence_tolerance: 0, sigma_edit_threshold: 0, dynamic_model_correlation_time_seconds: 0, maximum_iterations: 0,
      reference_frame: 'ICRF', estimator: 'BATCH_WEIGHTED_LEAST_SQUARES', process_noise: 'NONE', flags: 0 },
    error_models: models.map((m) => ({ noise_sigma: 0.001, bias: 0, bias_sigma: 0, correlation_time_seconds: 0, minimum_value: 0, maximum_value: 0, sigma_edit_threshold: 0, random_seed: 1, troposphere: 'NONE', ionosphere: 'NONE', flags: 2, ...m })),
    propagator_port_id: 'test-provider', propagator_capability: 'plugin_propagate plugin_compute_stm', trace_id: 'tdm-decode',
    batch_options: { parameter_kinds: [], parameter_values: [], maximum_iterations: 25, correction_tolerance: 1e-3, sigma_edit_threshold: 0 },
  } }));
  envelope.request.config.initialState = scenario.truth.map((v, i) => v + OFFSET[i]);
  Object.assign(envelope.request.batchOptions, options);
  const tdm = packTdm(tdmRecord);
  const station = crdRecord(...scenario.station);
  for (let round = 0; round < 40; ++round) {
    const response = await estimator.invoke({ methodId: 'fit_batch', inputs: [
      { portId: 'request', typeRef, payload: pack(envelope) }, { portId: 'tracking_data', typeRef: TDM_TYPE, payload: tdm }, { portId: 'laser_tracking', typeRef: CRD_TYPE, payload: station }] });
    if (response.statusCode !== 0) return { error: `${response.errorCode}: ${response.errorMessage}` };
    const bytes = response.outputs.find((o) => o.portId === 'result').payload;
    const { result } = { result: unpack(bytes).result };
    if (result.status !== 1) {
      const estimate = result.batchFit.estimate.slice(0, 6);
      return { result, rounds: round, estimate, error_m: norm(estimate.slice(0, 3).map((v, i) => v - scenario.truth[i])) };
    }
    const answered = await provider.invoke({ methodId: 'test_propagate', inputs: [{ portId: 'request', typeRef, payload: bytes }] });
    assert.equal(answered.statusCode, 0, answered.errorMessage);
    envelope.propagationAnswers.push(...unpack(answered.outputs[0].payload).propagationAnswers);
  }
  assert.fail('no result in 40 rounds');
}

const providerPath = path.join(here, '.generated/provider/dist/isomorphic/module.wasm');
const withModules = async (body) => {
  assert.ok(fs.existsSync(providerPath), 'run `node tests/build-provider.mjs` first (npm test does)');
  const estimator = await harness(root);
  const ilrs = await harness(ilrsRoot);
  const provider = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(providerPath), surface: 'direct' });
  try { return await body({ estimator, ilrs, provider }); } finally { for (const h of [estimator, ilrs, provider]) { h.destroy?.(); } }
};
const laserModel = { measurement_kind: 'LASER_RANGE' };
// 0.004 arcsec: the angles pin the one direction the ranges cannot see (a rotation about the station's vertical); the ranges
// are weighted at 1 mm, and the light-time linearization of the measurement model leaves 0.1 mm in them.
const angleModel = { measurement_kind: 'RIGHT_ASCENSION_DECLINATION', noise_sigma: 2e-8 };
const MODELS = [laserModel, angleModel];
const campaign = async (ilrs, scenario, options = {}) => readCrd(ilrs, crdText(scenario, options), scenario);

test('CRD -> $TDM -> fit_batch recovers the truth of a two-way laser campaign with transmit tags to 1 mm; read as receive tags it is detected', () => withModules(async ({ estimator, ilrs, provider }) => {
  const scenario = scenarios.plain;
  assert.equal(scenario.points.length, 98);  // two passes, every 5 s for four minutes
  const tdm = await campaign(ilrs, scenario);
  const laser = tdm.SEGMENTS.filter((s) => s.DATA_TYPES === 'LASER_RANGE');
  assert.equal(laser.length, 2);
  assert.deepEqual([...new Set(laser.map((s) => s.TIMETAG_REF))], ['TRANSMIT']);
  assert.deepEqual([...new Set(laser.map((s) => s.TIME_SYSTEM))], ['UTC']);

  const good = await fit(estimator, provider, scenario, tdm, { models: MODELS });
  assert.ok(!good.error, good.error);
  const batch = good.result.batchFit;
  assert.equal(batch.measurementCount, 98 * 3);  // a range and two angles at each of 98 epochs
  assert.ok(batch.converged);
  console.log(`transmit tags: position error ${(good.error_m * 1000).toFixed(4)} mm, weighted RMS ${batch.weightedRms.toExponential(3)}, ${good.rounds} rounds`);
  assert.ok(good.error_m <= 1e-3, `position error ${good.error_m} m`);
  assert.ok(norm(good.estimate.slice(3).map((v, i) => v - scenario.truth[3 + i])) <= 1e-5, 'velocity to 0.01 mm/s');
  assert.ok(batch.weightedRms < 0.5, `weighted RMS ${batch.weightedRms}`);

  // The same normal points labelled as receive times: the decoder reads the transmit epochs as receive epochs, 2R/c (about 10 ms,
  // 70 m along the orbit) too early, which is the misread that turned a 4.4 cm laser fit into 23 m.
  const misread = await fit(estimator, provider, scenario, await campaign(ilrs, scenario, { event: 0 }), { models: MODELS });
  assert.ok(!misread.error, misread.error);
  console.log(`receive tags: position error ${misread.error_m.toFixed(3)} m, weighted RMS ${misread.result.batchFit.weightedRms.toFixed(1)}`);
  assert.ok(misread.error_m > 1.0, `the misread fit is ${misread.error_m} m from truth`);
  assert.ok(misread.result.batchFit.weightedRms > 100 * batch.weightedRms, 'and its residuals show it');
}));

// The same instants written in UTC, TAI, GPS and TT must give the same fit.
test('UTC, TAI, GPS and TT labels of the same instants give the same fit', () => withModules(async ({ estimator, ilrs, provider }) => {
  const scenario = scenarios.plain;
  const reference = await fit(estimator, provider, scenario, await campaign(ilrs, scenario), { models: MODELS });
  assert.ok(!reference.error, reference.error);
  for (const system of ['TAI', 'GPS', 'TT']) {
    const tdm = await campaign(ilrs, scenario);
    const laserRows = tdm.SEGMENTS.filter((s) => s.DATA_TYPES === 'LASER_RANGE').flatMap((s) => s.OBSERVATIONS);
    laserRows.forEach((row, i) => { row.EPOCH = scenario.points[i][`tx_${system.toLowerCase()}`]; });
    const angles = tdm.SEGMENTS.find((s) => s.DATA_TYPES === 'ANGLE_1,ANGLE_2');
    angles.OBSERVATIONS.forEach((row, i) => { row.EPOCH = scenario.points[Math.floor(i / 2)][`rx_${system.toLowerCase()}`]; });
    for (const segment of tdm.SEGMENTS) segment.TIME_SYSTEM = system;
    const relabelled = await fit(estimator, provider, scenario, tdm, { models: MODELS });
    assert.ok(!relabelled.error, `${system}: ${relabelled.error}`);
    const difference = norm(relabelled.estimate.map((v, i) => v - reference.estimate[i]));
    console.log(`${system}: ${difference.toExponential(2)} from the UTC fit`);
    assert.ok(difference < 1e-7, `${system} labels differ from UTC by ${difference}`);
  }
}));

test('tropospheric delay from the record\'s weather rows: with them the truth is recovered to 1 mm, without them it is not', () => withModules(async ({ estimator, ilrs, provider }) => {
  const scenario = scenarios.weather;
  const models = [{ ...laserModel, troposphere: 'MARINI' }, angleModel];
  const withRows = await fit(estimator, provider, scenario, await campaign(ilrs, scenario, { meteo: true }), { models });
  assert.ok(!withRows.error, withRows.error);
  console.log(`weather rows: position error ${(withRows.error_m * 1000).toFixed(4)} mm`);
  assert.ok(withRows.error_m <= 1e-3, `position error ${withRows.error_m} m`);

  const tdm = await campaign(ilrs, scenario, { meteo: true });
  const weather = new Set(['PRESSURE', 'TEMPERATURE', 'RHUMIDITY']);
  for (const segment of tdm.SEGMENTS) segment.OBSERVATIONS = segment.OBSERVATIONS.filter((row) => !weather.has(row.KEYWORD));
  const without = await fit(estimator, provider, scenario, tdm, { models });
  assert.ok(!without.error, without.error);
  console.log(`no weather rows: position error ${(without.error_m * 1000).toFixed(2)} mm`);
  assert.ok(without.error_m > 10 * withRows.error_m, `the standard atmosphere is ${without.error_m} m from truth`);
}));

test('a $TDM the decoder cannot read exactly is refused, with the reason', () => withModules(async ({ estimator, ilrs, provider }) => {
  const scenario = scenarios.plain;
  const refused = async (edit, pattern) => {
    const tdm = await campaign(ilrs, scenario);
    edit(tdm);
    const result = await fit(estimator, provider, scenario, tdm, { models: MODELS });
    assert.match(result.error ?? 'accepted', pattern);
  };
  const laserSegments = (tdm) => tdm.SEGMENTS.filter((s) => s.DATA_TYPES === 'LASER_RANGE');
  await refused((tdm) => { laserSegments(tdm)[0].TIME_SYSTEM = 'TDB'; }, /bad-tdm: TIME_SYSTEM 'TDB'/);
  await refused((tdm) => { laserSegments(tdm)[0].TIME_SYSTEM = ''; }, /bad-tdm: TIME_SYSTEM is required/);
  await refused((tdm) => { laserSegments(tdm)[0].TIMETAG_REF = ''; }, /bad-tdm: LASER_RANGE needs TIMETAG_REF/);
  await refused((tdm) => { laserSegments(tdm)[0].PATH = '1,2,3'; }, /bad-tdm: PATH '1,2,3'/);
  await refused((tdm) => { laserSegments(tdm)[0].OBSERVATIONS[0].EPOCH = '2027-07-01T00:00:00.000000000'; }, /bad-tdm: a UTC epoch on or after 2027-06-30/);
  await refused((tdm) => { tdm.SEGMENTS.find((s) => s.DATA_TYPES !== 'LASER_RANGE').OBSERVATIONS.splice(1, 1); }, /bad-tdm: ANGLE_1 at .* has no ANGLE_2/);
  // A Doppler count without the transmitter's frequency: no 8.4 GHz stands in for it.
  await refused((tdm) => {
    const doppler = Object.assign(new TDMSegmentT(), { TIME_SYSTEM: 'UTC', TIMETAG_REF: 'RECEIVE', PATH: '1,2,1', INTEGRATION_INTERVAL: 10, INTEGRATION_REF: 'MIDDLE' });
    doppler.OBSERVATIONS.push(Object.assign(new TDMObservationT(), { KEYWORD: 'DOPPLER_INSTANTANEOUS', EPOCH: '2026-10-11T00:14:10.000000000', VALUE: 1000 }));
    tdm.SEGMENTS.push(doppler);
  }, /bad-tdm: DOPPLER_INSTANTANEOUS needs TRANSMIT_FREQ_1: there is no default carrier/);
}));

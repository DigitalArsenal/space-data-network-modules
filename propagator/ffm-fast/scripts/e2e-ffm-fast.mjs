#!/usr/bin/env node
// The single FFM Fast E2E: resident WASM propagation, independent study truth,
// fixed-step implementation agreement, CPU measurements, and source integrity.
// JS only encodes/decodes, selects sample times, compares outputs, and times calls.
// All propagation is C++/WASM. PPE evaluation is the standard's test reader.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';
import { encodePluginInvokeRequest, decodePluginInvokeResponse } from 'space-data-module-sdk/invoke';
import { packageRoot, standardRoot, STANDARD } from '../standard.mjs';
import { inspectForkBases } from '../forks.mjs';
import { batchEvidence, boundaryEvidence, startupDomainEvidence } from './resident-batch-evidence.mjs';
import { FAST_CATALOG_INTEGRATOR, INTEGRATION_POLICY } from '../catalog.mjs';

const standardImport = (relative) => import(pathToFileURL(path.join(standardRoot, relative)));
const catalog = await standardImport('catalog.mjs');
const { environmentInputs, evaluatePpe, isoAfter, isoSeconds, secondsBetween } = await standardImport('tests/lib/fullForce.mjs');
const { makeTable, encodePrw, decodePrw, coordinateSystem, TYPE, sds } = await standardImport('tests/lib/prwCodec.mjs');
const fixtureRoot = path.join(packageRoot, 'tests/fixtures');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const standard = readJson(path.join(fixtureRoot, 'standard.json'));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const DAYS = 3, DAY = 86400, DURATION = DAYS * DAY;
// Include the 10 s grid and native 1 s perigee/weather refinement.
const TRUTH_SAMPLE_SECONDS = 10;
const FIXED = Object.freeze({ tolerance: 1, initialStep: 60, minStep: 60, maxStep: 60, maxSteps: 1000000 });
const opt = {};
for (let i = 2; i < process.argv.length; ++i) {
  const key = process.argv[i];
  if (!['--measure', '--output', '--seed'].includes(key) || !process.argv[i + 1])
    throw new Error('Usage: node scripts/e2e-ffm-fast.mjs [--measure C1|C4|C3a|C2|C3c|C7] [--output result.json] [--seed ISS]');
  opt[key.slice(2)] = process.argv[++i];
}
if (opt.measure && !['C1', 'C4', 'C3a', 'C2', 'C3c', 'C7'].includes(opt.measure)) throw new Error(`Unknown lever ${opt.measure}`);
const seeds = readJson(path.join(fixtureRoot, 'seeds.json')).filter((seed) => !opt.seed || seed.label === opt.seed);
if (!seeds.length) throw new Error(`Unknown seed ${opt.seed}`);
if (typeof process.threadCpuUsage !== 'function') throw new Error('This E2E requires Node with process.threadCpuUsage (Node 24.6 or newer).');

function integrity() {
  const wasm = fs.readFileSync(path.join(standardRoot, 'dist/isomorphic/module.wasm'));
  if (sha(wasm) !== standard.wasmSha256) throw new Error(`Standard artifact changed: expected ${standard.wasmSha256}, got ${sha(wasm)}.`);
  const forkBases = inspectForkBases();
  return { standardDirectory: STANDARD, standardWasmSha256: sha(wasm),
    forkBaseSha256: forkBases['lib/force_models.cpp'].sha256,
    residentForkBaseSha256: forkBases['src/cpp/src/resident_dynamics.cpp'].sha256, forkBases };
}

const port = (portId, arm, value) => ({ portId, typeRef: TYPE, payload: encodePrw(arm, value) });
const environment = environmentInputs();
// Re-epoch the copied study states exactly as map/gen-inputs.mjs does: preserve
// their GCRF vectors and coefficients; replace only the UTC epoch.
function requests(seed, integrator, moduleId = 'com.orbpro.ffm') {
  const instance = makeTable('PRWInstance', { MODULE_ID: moduleId, INSTANCE_ID: `ffm-fast-${seed.label}`, GENERATION: 1n });
  const state = [...seed.position, ...seed.velocity].map((value) => value * 1000);
  const resident = catalog.residentState({ instanceId: instance.INSTANCE_ID, generation: 1n,
    handle: seed.handle, catalogNumber: seed.norad, objectId: seed.label,
    epoch: standard.fixtureEpochUtc, state, cdAm: seed.cdAm, crAm: seed.crAm });
  resident.INSTANCE.MODULE_ID = moduleId;
  return [
    encodePluginInvokeRequest({ methodId: 'ingest_state', inputs: [port('state', 'RESIDENT_STATE', resident),
      port('configuration', 'EXECUTION_REQUEST', catalog.fullForceRequest({ epoch: standard.fixtureEpochUtc, state,
        cdAm: seed.cdAm, crAm: seed.crAm, integrator })), ...environment] }),
    encodePluginInvokeRequest({ methodId: 'prepare_trajectory_segments', inputs: [port('request', 'PREPARE_REQUEST',
      makeTable('PRWPrepareRequest', { INSTANCE: instance, SOURCE_HANDLES: [seed.handle],
        START_EPOCH: catalog.instant(standard.fixtureEpochTt, 'TT'), DURATION_SECONDS: DURATION, PROFILE: 'conjunction-screening' }))] }),
    encodePluginInvokeRequest({ methodId: 'describe_trajectory_segments', inputs: [port('request', 'DESCRIBE_REQUEST',
      makeTable('PRWDescribeRequest', { INSTANCE: instance, SEGMENT_SET_HANDLE: 1, SOURCE_HANDLES: [seed.handle] }))] }),
  ];
}
const cpuSeconds = (since) => { const c = process.threadCpuUsage(since); return (c.user + c.system) / 1e6; };
const compiled = new Map();
async function run(root, requestBytes) {
  if (!compiled.has(root)) compiled.set(root, await WebAssembly.compile(fs.readFileSync(path.join(root, 'dist/isomorphic/module.wasm'))));
  const h = await createBrowserModuleHarness({ wasmSource: compiled.get(root),
    manifest: readJson(path.join(root, 'plugin-manifest.json')), surface: 'direct' });
  try {
    let totalCpu = 0, ephemeris, describeSha256;
    const stageCpu = {};
    for (const [i, method] of ['ingest_state', 'prepare_trajectory_segments', 'describe_trajectory_segments'].entries()) {
      const before = process.threadCpuUsage();
      const bytes = await h.invokeRaw(requestBytes[i]);
      stageCpu[method] = cpuSeconds(before); totalCpu += stageCpu[method];
      const response = decodePluginInvokeResponse(bytes);
      if (response.statusCode !== 0) throw new Error(`${path.basename(root)} ${method}: ${response.errorCode}: ${response.errorMessage}`);
      if (response.yielded) throw new Error(`${method}: unexpectedly yielded instead of returning the complete single-source result`);
      if (i === 1) {
        const result = decodePrw(response.outputs[0].payload).PREPARE_RESULT;
        if (result.SEGMENT_SET_HANDLE !== 1) throw new Error(`Unexpected fresh-instance segment handle ${result.SEGMENT_SET_HANDLE}`);
      }
      if (i === 2) {
        describeSha256 = sha(response.outputs[0].payload);
        const sources = decodePrw(response.outputs[0].payload).DESCRIBE_RESULT.SOURCES;
        if (sources.length !== 1) throw new Error(`Expected one resident source, got ${sources.length}`);
        ephemeris = sources[0].EPHEMERIS;
        // The shipped resident PPE is TT, even though the reader's comment
        // says TDB. Keep the native study's TT coordinate without a conversion.
        if (ephemeris.TIME_SYSTEM !== sds.timingStandard.TT) throw new Error('Resident PPE time scale changed; regenerate/review truth time handling. Expected TT.');
      }
    }
    return { ephemeris, describeSha256, cpuSecondsPerDay: totalCpu / DAYS, stageCpuSeconds: stageCpu };
  } finally { await h.destroy(); }
}

// Exercise the resident dense-state API independently of the fitted PPE.
// Reference rows include native perigee refinement and exact weather stops.
async function denseEvidence(seed, truth, ingestBytes) {
  const h = await createBrowserModuleHarness({ wasmSource: compiled.get(packageRoot),
    manifest: readJson(path.join(packageRoot, 'plugin-manifest.json')), surface: 'direct' });
  const result = { samples: truth.length / 56,
    oneDay: { positionM: 0, velocityMps: 0 }, threeDays: { positionM: 0, velocityMps: 0 } };
  const instance = makeTable('PRWInstance', { MODULE_ID: 'com.orbpro.ffm-fast', INSTANCE_ID: `ffm-fast-${seed.label}`, GENERATION: 1n });
  try {
    const ingest = decodePluginInvokeResponse(await h.invokeRaw(ingestBytes));
    if (ingest.statusCode !== 0) throw new Error(`Dense ingest: ${ingest.errorMessage}`);
    for (let at = 0; at < truth.length; at += 56) {
      const elapsed = truth.readDoubleLE(at);
      const response = await h.invoke({ methodId: 'propagate_state', inputs: [port('request', 'RESIDENT_REQUEST',
        makeTable('PRWResidentRequest', { INSTANCE: instance,
          TARGET_EPOCH: catalog.instant(isoAfter(standard.fixtureEpochTt, elapsed), 'TT'),
          ENTITY_HANDLES: [seed.handle], TARGET_COORDINATE_SYSTEM: coordinateSystem() }))] });
      if (response.statusCode !== 0 || response.yielded || response.outputs.length !== 1)
        throw new Error(`${seed.label} dense at ${elapsed}: ${response.errorCode}: ${response.errorMessage}`);
      const state = decodePrw(response.outputs[0].payload).RESIDENT_STATE.STATE;
      const positionM = Math.hypot(...['X', 'Y', 'Z'].map((axis, i) => state.POSITION[axis] - truth.readDoubleLE(at + (i + 1) * 8) * 1000));
      const velocityMps = Math.hypot(...['X', 'Y', 'Z'].map((axis, i) => state.VELOCITY[axis] - truth.readDoubleLE(at + (i + 4) * 8) * 1000));
      if (!Number.isFinite(positionM) || !Number.isFinite(velocityMps)) throw new Error('Nonfinite dense-state error');
      for (const key of elapsed <= DAY ? ['oneDay', 'threeDays'] : ['threeDays']) {
        result[key].positionM = Math.max(result[key].positionM, positionM);
        result[key].velocityMps = Math.max(result[key].velocityMps, velocityMps);
      }
    }
  } finally { await h.destroy(); }
  return result;
}

// Select the containing record once per ordered sample; the authoritative
// standard reader still evaluates every coefficient and velocity component.
function sampler(ephemeris) {
  const records = ephemeris.POSITION_RECORDS;
  const mids = records.map((record) => isoSeconds(record.EPOCH_MID));
  const views = records.map((record) => ({ POSITION_RECORDS: [record] }));
  let index = 0;
  return (iso) => {
    const at = isoSeconds(iso);
    while (index + 1 < records.length && secondsBetween(mids[index], at) > records[index].EPOCH_HALF_SPAN + 1e-9) ++index;
    return evaluatePpe(views[index], iso);
  };
}
const normDifference = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * 1000;
function compare(a, b, interval, truth) {
  const sampleA = sampler(a), sampleB = b && sampler(b);
  const result = { oneDay: { positionM: 0, velocityMps: 0 }, threeDays: { positionM: 0, velocityMps: 0 } };
  const count = truth ? truth.length / (7 * 8) : DURATION / interval + 1;
  let previous = -Infinity;
  for (let row = 0; row < count; ++row) {
    const elapsed = truth ? truth.readDoubleLE(row * 7 * 8) : row * interval;
    if (!(elapsed > previous && elapsed >= 0 && elapsed <= DURATION)) throw new Error(`Invalid truth time at row ${row}`);
    previous = elapsed;
    const iso = isoAfter(standard.fixtureEpochTt, elapsed), left = sampleA(iso);
    let right;
    if (truth) {
      const at = row * 7 * 8;
      if (truth.readDoubleLE(at) !== elapsed) throw new Error(`Truth fixture sampling differs at row ${row}`);
      right = { position: [1, 2, 3].map((col) => truth.readDoubleLE(at + col * 8)),
        velocity: [4, 5, 6].map((col) => truth.readDoubleLE(at + col * 8)) };
    } else right = sampleB(iso);
    const positionM = normDifference(left.position, right.position), velocityMps = normDifference(left.velocity, right.velocity);
    if (!Number.isFinite(positionM) || !Number.isFinite(velocityMps)) throw new Error(`Nonfinite state difference at ${elapsed} s`);
    for (const key of elapsed <= DAY ? ['oneDay', 'threeDays'] : ['threeDays']) {
      result[key].positionM = Math.max(result[key].positionM, positionM);
      result[key].velocityMps = Math.max(result[key].velocityMps, velocityMps);
    }
  }
  return result;
}
const fmt = (number) => number.toExponential(3);
const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };

async function main() {
  const hashes = integrity(), loadStart = os.loadavg(), rows = [];
  const truthMetadata = readJson(path.join(fixtureRoot, 'truth/truth.json'));
  if (truthMetadata.epoch !== standard.fixtureEpochUtc || truthMetadata.epochTt !== standard.fixtureEpochTt
      || truthMetadata.frame !== 'GCRF' || truthMetadata.sampling.seconds !== TRUTH_SAMPLE_SECONDS
      || truthMetadata.sampling.durationSeconds !== DURATION
      || !truthMetadata.sampling.includeNativeStops)
    throw new Error('Truth fixture epoch, frame, or sampling differs from the E2E contract; review/regenerate the fixtures.');
  if (truthMetadata.generatorSha256 !== sha(fs.readFileSync(path.join(packageRoot, 'scripts/export-truth.cpp'))))
    throw new Error('Truth exporter source differs from recorded provenance; review/regenerate the fixtures.');
  for (const seed of seeds) {
    const provenance = truthMetadata.records.find((row) => row.seed === seed.label);
    const truthPath = path.join(fixtureRoot, `truth/${seed.label}.f64`);
    if (!provenance || provenance.rows < DURATION / TRUTH_SAMPLE_SECONDS + 1
        || sha(fs.readFileSync(truthPath)) !== provenance.outputSha256)
      throw new Error(`${seed.label} truth fixture differs from its recorded provenance; regenerate the fixtures.`);
  }
  console.log(`FFM Fast ${opt.measure ? `lever ${opt.measure} measurement` : 'phase 2 E2E'}; Node ${process.version}; ${seeds.length} seeds; 3 days; GCRF; UTC epoch ${standard.fixtureEpochUtc}`);
  console.log('Resident path: ingest_state -> prepare_trajectory_segments -> describe_trajectory_segments; PPE/truth coordinate: TT.');
  console.log(`Truth samples every ${TRUTH_SAMPLE_SECONDS} s plus all native perigee and weather stops, including resident segment interiors.`);
  console.log('Fixed RK78: initial = minimum = maximum 60 s, tolerance 1; CPU: defaults interleaved, min of 2, thread user + system.');
  console.log('seed      fixed dp1 m  fixed dv1 m/s fixed dp3 m  fixed dv3 m/s standard CPU/d fast CPU/d');
  for (const seed of seeds) {
    const fixedBytes = requests(seed, FIXED);
    const fixedStandard = await run(standardRoot, fixedBytes), fixedFast = await run(packageRoot, requests(seed, FIXED, 'com.orbpro.ffm-fast'));
    const fixed = compare(fixedFast.ephemeris, fixedStandard.ephemeris, 60);
    const standardBytes = requests(seed, catalog.CATALOG_INTEGRATOR);
    const fastBytes = requests(seed, opt.measure ? catalog.CATALOG_INTEGRATOR : FAST_CATALOG_INTEGRATOR, 'com.orbpro.ffm-fast');
    let standardRun, fastRun, standardCpu = Infinity, fastCpu = Infinity;
    const cpuRepetitions = [];
    for (let repetition = 0; repetition < 2; ++repetition) {
      standardRun = await run(standardRoot, standardBytes); fastRun = await run(packageRoot, fastBytes);
      standardCpu = Math.min(standardCpu, standardRun.cpuSecondsPerDay); fastCpu = Math.min(fastCpu, fastRun.cpuSecondsPerDay);
      cpuRepetitions.push({ standard: standardRun.cpuSecondsPerDay, fast: fastRun.cpuSecondsPerDay });
    }
    const row = { seed: seed.label, fixed, fixedDescribeSha256: { standard: fixedStandard.describeSha256, fast: fixedFast.describeSha256 },
      cpuSecondsPerDay: { standard: standardCpu, fast: fastCpu }, cpuRepetitions, loadAverage: os.loadavg() };
    const fixedLimit = opt.measure ? 1e-4 : 1e-3;
    check(fixed.threeDays.positionM <= fixedLimit, `${seed.label} fixed-step position ${fixed.threeDays.positionM} m exceeds ${fixedLimit} m`);
    check(fixed.threeDays.velocityMps <= 1e-6, `${seed.label} fixed-step velocity ${fixed.threeDays.velocityMps} m/s exceeds 1e-6 m/s`);
    if (!opt.measure || fs.existsSync(path.join(fixtureRoot, `truth/${seed.label}.f64`))) {
      const truth = fs.readFileSync(path.join(fixtureRoot, `truth/${seed.label}.f64`));
      if (truth.length !== truthMetadata.records.find((entry) => entry.seed === seed.label).rows * 7 * 8) throw new Error(`${seed.label} truth fixture has the wrong length`);
      row.standardVsTruth = compare(standardRun.ephemeris, null, TRUTH_SAMPLE_SECONDS, truth);
      if (!opt.measure) {
        const policy = { LOW250: 'GJ8 PEC at 10 s', ISS: 'GJ8 PEC at 15 s', STARLINK: 'GJ8 PEC at 12 s',
          SSO800: 'GJ8 PEC at 24 s', GPS: 'GJ8 PEC at 75 s', GEO: 'GJ8 PEC at 600 s',
          // The Molniya fixture has 638 km perigee and 39,773 km apogee;
          // its Cartesian state meets the 300-step band despite its label.
          MOLNIYA: 'RK78 Sundman alpha=1.5 at 300/orbit', GTO: 'RK78 Sundman alpha=1.5 at 300/orbit' }[seed.label];
        check(fastRun.ephemeris.COMMENT.includes(`Fast forward resident integrator: ${policy}.`),
          `${seed.label}: actual resident integrator differs from the automatic policy`);
        row.actualPolicy = fastRun.ephemeris.COMMENT;
        row.fastVsTruth = compare(fastRun.ephemeris, null, TRUTH_SAMPLE_SECONDS, truth);
        row.denseVsTruth = await denseEvidence(seed, truth, fastBytes[0]);
        check(row.denseVsTruth.oneDay.positionM <= 0.01, `${seed.label} dense state fails FIT: ${row.denseVsTruth.oneDay.positionM} m`);
        check(row.denseVsTruth.threeDays.positionM <= 1 && row.denseVsTruth.threeDays.velocityMps <= 1e-3,
          `${seed.label} dense state fails SCREEN: ${JSON.stringify(row.denseVsTruth.threeDays)}`);
        row.fit = row.fastVsTruth.oneDay.positionM <= 0.01;
        row.screen = row.fastVsTruth.threeDays.positionM <= 1 && row.fastVsTruth.threeDays.velocityMps <= 1e-3;
        check(row.fit, `${seed.label} fails FIT: ${row.fastVsTruth.oneDay.positionM} m exceeds 0.01 m`);
        check(row.screen, `${seed.label} fails SCREEN: ${row.fastVsTruth.threeDays.positionM} m, ${row.fastVsTruth.threeDays.velocityMps} m/s`);
        const floor = ['GPS', 'GEO'].includes(seed.label);
        const positionLimit = Math.max(row.standardVsTruth.threeDays.positionM, floor ? 1e-4 : 0);
        const velocityLimit = Math.max(row.standardVsTruth.threeDays.velocityMps, floor ? 1e-7 : 0);
        check(row.fastVsTruth.threeDays.positionM <= positionLimit, `${seed.label} fast position ${row.fastVsTruth.threeDays.positionM} m is worse than standard/floor ${positionLimit} m`);
        check(row.fastVsTruth.threeDays.velocityMps <= velocityLimit, `${seed.label} fast velocity ${row.fastVsTruth.threeDays.velocityMps} m/s is worse than standard/floor ${velocityLimit} m/s`);
      }
    }
    rows.push(row);
    console.log(`${seed.label.padEnd(9)} ${fmt(fixed.oneDay.positionM)}    ${fmt(fixed.oneDay.velocityMps)}    ${fmt(fixed.threeDays.positionM)}    ${fmt(fixed.threeDays.velocityMps)}     ${standardCpu.toFixed(6)}       ${fastCpu.toFixed(6)}`);
  }
  const issBaseline = rows.find((row) => row.seed === 'ISS')?.standardVsTruth?.threeDays;
  if (issBaseline) console.log(`Standard ISS vs T3 at 3 d: ${fmt(issBaseline.positionM)} m, ${fmt(issBaseline.velocityMps)} m/s (study WASM E0: 2.131651 m; native: about 2.4 m).`);
  if (!opt.measure) {
    console.log('Truth: position m / velocity m/s; FIT <= 0.01 m at 1 d; SCREEN <= 1 m and 0.001 m/s at 3 d.');
    console.log('seed      standard 1d          fast 1d              standard 3d          fast 3d              FIT SCREEN');
    for (const row of rows) {
      const pair = (x) => `${fmt(x.positionM)}/${fmt(x.velocityMps)}`;
      console.log(`${row.seed.padEnd(9)} ${pair(row.standardVsTruth.oneDay)}  ${pair(row.fastVsTruth.oneDay)}  ${pair(row.standardVsTruth.threeDays)}  ${pair(row.fastVsTruth.threeDays)}  ${row.fit ? 'PASS' : 'FAIL'} ${row.screen ? 'PASS' : 'FAIL'}`);
    }
  }
  // Preserve numerical rows even if an independent resident behavior check
  // throws. Each failed check still fails this single E2E's final verdict.
  async function evidence(name, run) {
    if (opt.measure || opt.seed) return null;
    try { return await run(); }
    catch (error) {
      check(false, `${name}: ${error.message}`);
      console.error(`${name}: ${error.stack ?? error}`);
      return { ok: false, error: error.message };
    }
  }
  const residentBatch = await evidence('resident batch', batchEvidence);
  const regimeBoundaries = await evidence('regime boundaries', boundaryEvidence);
  const startupDomain = await evidence('startup domain', startupDomainEvidence);
  integrity();
  const maxima = (window, key) => Math.max(...rows.map((row) => row.fixed[window][key]));
  const result = { ok: failures.length === 0, mode: opt.measure ? 'lever' : 'e2e', lever: opt.measure ?? null,
    ...hashes, fastWasmSha256: sha(fs.readFileSync(path.join(packageRoot, 'dist/isomorphic/module.wasm'))),
    epochUtc: standard.fixtureEpochUtc, epochTt: standard.fixtureEpochTt, frame: 'GCRF', days: DAYS,
    truthStandardModuleCppCommit: truthMetadata.standardModuleCppCommit, integrationPolicy: INTEGRATION_POLICY,
    fixedStepSeconds: 60, fixedTolerance: 1, truthSamplingSeconds: TRUTH_SAMPLE_SECONDS,
    standardIntegrator: catalog.CATALOG_INTEGRATOR, fastIntegrator: opt.measure ? catalog.CATALOG_INTEGRATOR : FAST_CATALOG_INTEGRATOR,
    maxAddedError: { oneDay: { positionM: maxima('oneDay', 'positionM'), velocityMps: maxima('oneDay', 'velocityMps') },
      threeDays: { positionM: maxima('threeDays', 'positionM'), velocityMps: maxima('threeDays', 'velocityMps') } },
    cpuMethod: 'process.threadCpuUsage user + system, ingest + prepare + describe, interleaved standard/fast, minimum of two repetitions divided by three days',
    loadAverageStart: loadStart, loadAverageEnd: os.loadavg(), residentBatch, regimeBoundaries, startupDomain, rows, failures };
  if (opt.output) fs.writeFileSync(opt.output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Standard untouched: PASS; fork base: PASS; load average ${result.loadAverageEnd.map((x) => x.toFixed(2)).join(', ')}.`);
  for (const failure of failures) console.log(`FAIL: ${failure}`);
  console.log(`${result.ok ? 'PASS' : 'FAIL'} FFM Fast ${opt.measure ? `lever ${opt.measure}` : 'phase 2 E2E'}`);
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
}
try { await main(); } catch (error) {
  console.error(`FAIL FFM Fast: ${error.stack ?? error}`);
  console.log(JSON.stringify({ ok: false, fatal: error.message }));
  process.exitCode = 1;
}

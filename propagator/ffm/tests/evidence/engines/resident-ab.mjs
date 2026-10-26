#!/usr/bin/env node
// The E2E of an FFM speed change: the candidate artifact (this checkout's
// dist/isomorphic/module.wasm) against a baseline artifact (the same file at a
// named commit) on the shipped resident path (ingest_state,
// prepare_trajectory_segments, describe_trajectory_segments: the catalog's and
// the CA farm's path) for the eight regime seeds of tests/fixtures/seeds.json,
// FFM-1 on the committed environment fixtures, 3 days from the fixture epoch.
//
//   node tests/evidence/engines/resident-ab.mjs --baseline <commit> [--bound-m 1e-3] [--reps 2]
//        [--wasmedge-hours 6] [--out result.json]
//
// It fails unless, for every seed:
//   - the candidate's fitted ephemeris stays within --bound-m (default 1 mm) of
//     the baseline's in position over the 3 days (PPE evaluated every 60 s);
//   - the candidate gives each object the same ephemeris run alone and
//     run in one instance with all eight (the farm's batching across workers);
//   - the candidate gives the same bytes in the browser harness and the SDK's
//     native WasmEdge runner (a --wasmedge-hours span; 0 skips, reported).
// CPU seconds per object-day of both artifacts are measured alternately
// (baseline, candidate, ...; smallest of --reps each), this thread's clock.
// Encoding, decoding and comparison only; the propagation is the modules'.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createBrowserModuleHarness, createModuleHarness } from 'space-data-module-sdk/testing';
import { encodePluginInvokeRequest, decodePluginInvokeResponse } from 'space-data-module-sdk/invoke';
import * as catalog from '../../../catalog.mjs';
import { environmentInputs, evaluatePpe, isoAfter, isoSeconds, secondsBetween } from '../../lib/fullForce.mjs';
import { makeTable, encodePrw, decodePrw, TYPE } from '../../lib/prwCodec.mjs';
import { nativeRunner } from '../../lib/residentRuntime.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ffm = path.resolve(here, '../../..');
const { values: o } = parseArgs({ options: {
  baseline: { type: 'string' }, 'bound-m': { type: 'string', default: '1e-3' }, reps: { type: 'string', default: '2' },
  'wasmedge-hours': { type: 'string', default: '6' }, out: { type: 'string' },
} });
if (!o.baseline) throw new Error('usage: resident-ab.mjs --baseline <commit> [--bound-m 1e-3] [--reps 2] [--wasmedge-hours 6] [--out result.json]');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const DAYS = 3, DURATION = DAYS * 86400, SAMPLE_S = 60;
const bound = Number(o['bound-m']), reps = Number(o.reps), wasmedgeHours = Number(o['wasmedge-hours']);
const standard = readJson(path.join(ffm, 'tests/fixtures/standard.json'));
const seeds = readJson(path.join(ffm, 'tests/fixtures/seeds.json'));
const manifest = readJson(path.join(ffm, 'plugin-manifest.json'));

const candidateWasm = fs.readFileSync(path.join(ffm, 'dist/isomorphic/module.wasm'));
const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: ffm, encoding: 'utf8' }).trim();
const baselineCommit = execFileSync('git', ['rev-parse', `${o.baseline}^{commit}`], { cwd: ffm, encoding: 'utf8' }).trim();
const baselineWasm = execFileSync('git', ['show', `${baselineCommit}:${path.relative(repoRoot, path.join(ffm, 'dist/isomorphic/module.wasm'))}`],
  { cwd: ffm, maxBuffer: 64 << 20 });
const artifacts = { baseline: await WebAssembly.compile(baselineWasm), candidate: await WebAssembly.compile(candidateWasm) };

const port = (portId, arm, value) => ({ portId, typeRef: TYPE, payload: encodePrw(arm, value) });
const environment = environmentInputs();
const instanceOf = (id) => makeTable('PRWInstance', { MODULE_ID: manifest.pluginId, INSTANCE_ID: id, GENERATION: 1n });
const stateOf = (seed) => [...seed.position, ...seed.velocity].map((value) => value * 1000);
// One instance holding `group` (seeds), prepared for `seconds` and described.
function requests(group, seconds) {
  const instance = instanceOf(`ab-${group.map((s) => s.label).join('-')}`);
  const residents = group.map((seed) => port('state', 'RESIDENT_STATE', catalog.residentState({ instanceId: instance.INSTANCE_ID, generation: 1n,
    handle: seed.handle, catalogNumber: seed.norad, objectId: seed.label, epoch: standard.fixtureEpochUtc, state: stateOf(seed),
    cdAm: seed.cdAm, crAm: seed.crAm })));
  const first = group[0];
  return [
    encodePluginInvokeRequest({ methodId: 'ingest_state', inputs: [...residents, port('configuration', 'EXECUTION_REQUEST',
      catalog.fullForceRequest({ epoch: standard.fixtureEpochUtc, state: stateOf(first), cdAm: first.cdAm, crAm: first.crAm })), ...environment] }),
    encodePluginInvokeRequest({ methodId: 'prepare_trajectory_segments', inputs: [port('request', 'PREPARE_REQUEST',
      makeTable('PRWPrepareRequest', { INSTANCE: instance, SOURCE_HANDLES: group.map((s) => s.handle),
        START_EPOCH: catalog.instant(standard.fixtureEpochTt, 'TT'), DURATION_SECONDS: seconds, PROFILE: 'conjunction-screening' }))] }),
    ...group.map((seed) => encodePluginInvokeRequest({ methodId: 'describe_trajectory_segments', inputs: [port('request', 'DESCRIBE_REQUEST',
      makeTable('PRWDescribeRequest', { INSTANCE: instance, SEGMENT_SET_HANDLE: 1, SOURCE_HANDLES: [seed.handle] }))] })),
  ];
}
const cpu = (since) => { const c = process.threadCpuUsage(since); return (c.user + c.system) / 1e6; };
async function run(harness, bytes) {
  let cpuS = 0;
  const sources = [];
  for (const [i, request] of bytes.entries()) {
    const before = process.threadCpuUsage();
    let response = decodePluginInvokeResponse(await harness.invokeRaw(request));
    cpuS += cpu(before);
    if (response.statusCode !== 0) throw new Error(`call ${i}: ${response.errorCode}: ${response.errorMessage}`);
    if (response.yielded) throw new Error(`call ${i} yielded`);
    if (i >= 2) sources.push({ bytes: response.outputs[0].payload, ephemeris: decodePrw(response.outputs[0].payload).DESCRIBE_RESULT.SOURCES[0].EPHEMERIS });
  }
  return { cpuS, sources };
}
// The ephemeris content (every record's epoch, span and coefficients), apart
// from the instance identity the describe result also carries.
function ephemerisDigest(e) {
  const h = createHash('sha256');
  for (const r of e.POSITION_RECORDS) {
    h.update(`${r.EPOCH_MID}|${r.EPOCH_HALF_SPAN}|`);
    for (const k of ['POS_COEFF_X', 'POS_COEFF_Y', 'POS_COEFF_Z', 'VEL_COEFF_X', 'VEL_COEFF_Y', 'VEL_COEFF_Z'])
      h.update(new Uint8Array(Float64Array.from(r[k]).buffer));
  }
  return h.digest('hex');
}
const browser = (artifact) => createBrowserModuleHarness({ wasmSource: artifacts[artifact], manifest, surface: 'direct' });
async function once(artifact, bytes) {
  const h = await browser(artifact);
  try { return await run(h, bytes); } finally { await h.destroy(); }
}
function sampler(ephemeris) {
  const records = ephemeris.POSITION_RECORDS, mids = records.map((r) => isoSeconds(r.EPOCH_MID));
  const views = records.map((r) => ({ POSITION_RECORDS: [r] }));
  let index = 0;
  return (iso) => {
    const at = isoSeconds(iso);
    while (index + 1 < records.length && secondsBetween(mids[index], at) > records[index].EPOCH_HALF_SPAN + 1e-9) ++index;
    return evaluatePpe(views[index], iso);
  };
}
function difference(a, b) {
  const sa = sampler(a), sb = sampler(b);
  let positionM = 0, velocityMS = 0, atS = 0;
  for (let t = 0; t <= DURATION; t += SAMPLE_S) {
    const iso = isoAfter(standard.fixtureEpochTt, t), x = sa(iso), y = sb(iso);
    const dr = Math.hypot(...x.position.map((v, i) => v - y.position[i])) * 1000;
    const dv = Math.hypot(...x.velocity.map((v, i) => v - y.velocity[i])) * 1000;
    if (!Number.isFinite(dr) || !Number.isFinite(dv)) throw new Error(`nonfinite difference at ${t} s`);
    if (dr > positionM) { positionM = dr; atS = t; }
    velocityMS = Math.max(velocityMS, dv);
  }
  return { positionM, velocityMS, atS };
}

const failures = [], rows = [];
const loadStart = os.loadavg();
for (const seed of seeds) {
  const bytes = requests([seed], DURATION);
  const timing = { baseline: Infinity, candidate: Infinity };
  let result = {};
  for (let r = 0; r < reps; ++r) for (const artifact of ['baseline', 'candidate']) {
    const out = await once(artifact, bytes);
    timing[artifact] = Math.min(timing[artifact], out.cpuS);
    result[artifact] = out;
  }
  const d = difference(result.candidate.sources[0].ephemeris, result.baseline.sources[0].ephemeris);
  const identical = sha(result.candidate.sources[0].bytes) === sha(result.baseline.sources[0].bytes);
  if (!(d.positionM <= bound)) failures.push(`${seed.label}: candidate ${d.positionM.toExponential(3)} m from the baseline at ${d.atS} s (bound ${bound} m)`);
  rows.push({ seed: seed.label, baselineCpuSPerObjectDay: timing.baseline / DAYS, candidateCpuSPerObjectDay: timing.candidate / DAYS,
    speedup: timing.baseline / timing.candidate, maxPositionDifferenceM: d.positionM, atS: d.atS, maxVelocityDifferenceMS: d.velocityMS,
    byteIdentical: identical, candidateEphemerisSha256: ephemerisDigest(result.candidate.sources[0].ephemeris) });
  console.error(`${seed.label}: ${(timing.baseline / DAYS).toFixed(4)} -> ${(timing.candidate / DAYS).toFixed(4)} CPU-s/object-day, `
    + `${d.positionM.toExponential(3)} m${identical ? ' (byte-identical)' : ''}`);
}
// Batching: every seed in one candidate instance gives each the same ephemeris.
const together = await once('candidate', requests(seeds, DURATION));
together.sources.forEach((source, i) => {
  if (ephemerisDigest(source.ephemeris) !== rows[i].candidateEphemerisSha256) failures.push(`${seeds[i].label}: batched ephemeris differs from the single-object run`);
});
// Runtimes: browser and native WasmEdge on the same request bytes.
let wasmedge = { skipped: 'wasmedge-hours 0' };
if (wasmedgeHours > 0) {
  const span = wasmedgeHours * 3600, bytes = requests(seeds, span);
  const b = await once('candidate', bytes);
  const runner = await nativeRunner();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffm-ab-'));
  try {
    fs.writeFileSync(path.join(dir, 'module.wasm'), candidateWasm);
    const h = await createModuleHarness({ runtime: { kind: 'wasmedge', wasmPath: path.join(dir, 'module.wasm'), wasmEdgeRunnerBinary: runner } });
    let w;
    try { w = await run(h, bytes); } finally { await h.destroy(); }
    const same = b.sources.every((s, i) => sha(s.bytes) === sha(w.sources[i].bytes));
    if (!same) failures.push(`browser and WasmEdge bytes differ over ${wasmedgeHours} h`);
    wasmedge = { hours: wasmedgeHours, objects: seeds.length, byteIdentical: same };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const doc = { ok: failures.length === 0, baselineCommit, baselineWasmSha256: sha(baselineWasm), candidateWasmSha256: sha(candidateWasm),
  boundM: bound, days: DAYS, sampleSeconds: SAMPLE_S, reps, cpuMethod: 'process.threadCpuUsage over ingest + prepare + describe, alternating baseline and candidate, smallest of reps, divided by 3 days',
  host: { cpu: os.cpus()[0]?.model, logicalCpus: os.availableParallelism(), loadAverageStart: loadStart, loadAverageEnd: os.loadavg() },
  rows, batchedIdentical: !failures.some((f) => f.includes('batched')), wasmedge, failures };
if (o.out) fs.writeFileSync(o.out, `${JSON.stringify(doc, null, 1)}\n`);
console.log(JSON.stringify({ ok: doc.ok, rows: rows.map((r) => ({ seed: r.seed, speedup: Number(r.speedup.toFixed(3)), maxPositionDifferenceM: r.maxPositionDifferenceM })), wasmedge, failures }, null, 1));
if (!doc.ok) process.exitCode = 1;

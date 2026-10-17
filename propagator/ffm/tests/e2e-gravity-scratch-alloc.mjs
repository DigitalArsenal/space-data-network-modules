#!/usr/bin/env node
// One E2E, run with plain node. No browser, network, test framework, or JS physics.
// Reference: the SHA-256-pinned pre-fix source compiled at the same release
// version. The original main artifact is authenticated too. Equal version
// avoids a deliberate PPE producer-label difference; no payload is normalized.
// Seeds: supplied GCRF km/km/s states, serialized in SI and re-epoched (without
// propagation) to the fixture's UTC epoch. Equivalence tolerance is zero bytes:
// this scratch-storage change must preserve every serialized numerical result.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const execute = promisify(execFile);
const moduleRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = path.resolve(moduleRoot, '../..');
const support = path.join(moduleRoot, 'tests/gravity-scratch-alloc');
const epoch = '2026-08-01T12:00:00.000000';
const target = '2026-08-02T12:00:00.000000';
const days = 3;
const durationSeconds = 259200;
const repetitions = 2;
const compileJobs = 3; // Probe plus the two environment variants; never over six.
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const load = () => os.loadavg();
const readJson = async filename => JSON.parse(await fs.readFile(filename, 'utf8'));
const fixed = value => value.toFixed(6);

async function command(tool, args, options = {}) {
  try {
    return await execute(tool, args, { cwd: repoRoot, timeout: 180000,
      maxBuffer: 64 * 1024 * 1024, ...options });
  } catch (error) {
    const detail = error.code === 'ENOENT' ? `Required tool is missing: ${tool}`
      : `${tool} ${args.join(' ')} failed (${error.code ?? error.signal}): ${error.stderr || error.message}`;
    throw new Error(detail, { cause: error });
  }
}

async function compiler() {
  const failures = [];
  for (const [tool, prefix] of (process.platform === 'darwin'
    ? [['xcrun', ['clang++']], ['clang++', []]] : [['clang++', []]])) {
    try {
      const result = await command(tool, [...prefix, '--version']);
      assert.match(result.stdout, /clang/i, 'The native probe requires host clang++');
      return { tool, prefix, version: result.stdout.trim() };
    } catch (error) { failures.push(error.message); }
  }
  throw new Error(`Host clang++ is required (install local command-line tools); no download attempted. ${failures.join('; ')}`);
}

async function nativeProbe(temp, baseSource) {
  const cc = await compiler();
  const beforeSource = path.join(temp, 'environment_models.cpp');
  await fs.writeFile(beforeSource, baseSource);
  const sources = [path.join(support, 'alloc_probe.cpp'), beforeSource,
    path.join(moduleRoot, 'lib/environment_models.cpp')];
  const objects = ['probe.o', 'before.o', 'after.o'].map(name => path.join(temp, name));
  const flags = ['-std=gnu++17', '-O2', '-DNDEBUG', '-ffp-contract=off',
    '-ffunction-sections', '-fdata-sections', '-I', path.join(moduleRoot, 'lib')];
  // Only the production gravity loader/recursion is reachable from this probe.
  // Dead stripping removes unrelated environment models and their dependencies;
  // the single shared probe object is reused in both links, without stubs.
  const compiled = await Promise.allSettled(sources.map((source, index) =>
    command(cc.tool, [...cc.prefix, ...flags, '-c', source, '-o', objects[index]],
      { env: { ...process.env, TMPDIR: temp } })));
  const errors = compiled.filter(result => result.status === 'rejected');
  if (errors.length) throw new AggregateError(errors.map(result => result.reason),
    errors.map(result => result.reason.message).join('\n'));
  const result = { compiler: cc.version, compileJobs, flags, before: null, after: null };
  for (const [index, variant] of ['before', 'after'].entries()) {
    const executable = path.join(temp, `alloc-${variant}`);
    await command(cc.tool, [...cc.prefix, objects[0], objects[index + 1],
      process.platform === 'darwin' ? '-Wl,-dead_strip' : '-Wl,--gc-sections', '-o', executable],
      { env: { ...process.env, TMPDIR: temp } });
    const loadStart = load();
    const measured = await command(executable, []);
    result[variant] = { ...JSON.parse(measured.stdout), loadStart, loadEnd: load() };
    const probe = result[variant];
    assert.equal(probe.warmupEvaluations, 10);
    assert.equal(probe.evaluationsPerRepetition, 10000);
    assert.equal(probe.repetitions, 5);
    assert.equal(probe.samples.length, 5);
    for (const sample of probe.samples) {
      assert.ok(Number.isSafeInteger(sample.allocations) && sample.allocations >= 0);
      assert.ok(Number.isFinite(sample.microsecondsPerEvaluation));
    }
  }
  return result;
}

// A worker owns exactly one seed and is terminated afterward, releasing every
// fresh instance's WASM memory even if V8 has not collected it yet.
async function seedWorker() {
  const [{ createBrowserModuleHarness }, codec, catalog, { environmentInputs }, flatbuffers] = await Promise.all([
    import('space-data-module-sdk/testing'), import('space-data-module-sdk/invoke'),
    import('../catalog.mjs'), import('./lib/fullForce.mjs'), import('flatbuffers'),
  ]);
  const { encodePluginInvokeRequest, decodePluginInvokeResponse } = codec;
  const { seed, before, after, manifest } = workerData;
  const P = catalog.prw;
  const decode = bytes => P.PRW.getSizePrefixedRootAsPRW(new flatbuffers.ByteBuffer(bytes)).unpack();
  const instanceId = `gravity-scratch-${seed.label}`;
  const identity = new P.PRWInstanceT('com.orbpro.ffm', instanceId, 1n);
  // Unit serialization only; every force evaluation is C++/WASM.
  const state = [...seed.position, ...seed.velocity].map(value => value * 1000);
  const input = (portId, arm, record) => ({ portId, typeRef: catalog.TYPE, payload: catalog.encode(arm, record) });
  const request = (methodId, inputs) => encodePluginInvokeRequest({ methodId, inputs });
  const environment = environmentInputs();
  // Full SDK envelopes, including every PRW/environment frame, are built ONCE
  // and passed unchanged to all four instances. Same direct ABI as harness.invoke.
  const ingestBytes = request('ingest_state', [
    input('state', 'RESIDENT_STATE', catalog.residentState({ instanceId, handle: seed.handle,
      catalogNumber: seed.norad, objectId: seed.name, epoch, state, cdAm: seed.cdAm, crAm: seed.crAm })),
    input('configuration', 'EXECUTION_REQUEST', catalog.fullForceRequest({ epoch, state })), ...environment,
  ]);
  // UTC calendar -> Julian-date serialization, as in ffmFarmWorker; no time-scale conversion.
  const startJd = Date.parse(`${epoch}Z`) / 86400000 + 2440587.5;
  const start = new P.TIMInstantT(P.timingStandard.UTC, P.timEpochRepresentation.JULIAN_DATE, startJd);
  const prepareBytes = request('prepare_trajectory_segments', [input('request', 'PREPARE_REQUEST',
    new P.PRWPrepareRequestT(identity, 0, [seed.handle], start, durationSeconds, 'conjunction-screening'))]);
  const invokeBytes = request('invoke', [input('request', 'EXECUTION_REQUEST',
    catalog.fullForceRequest({ epoch, state, target, cdAm: seed.cdAm, crAm: seed.crAm })), ...environment]);
  let describeBytes;
  let segmentSet;
  let reference;
  const comparisons = [];
  const samples = [];
  const loadStart = load();

  for (let repetition = 0; repetition < repetitions; ++repetition) {
    for (const variant of ['before', 'after']) {
      const harness = await createBrowserModuleHarness({ wasmSource: variant === 'before' ? before : after,
        manifest, surface: 'direct' });
      const responses = [];
      const call = async (method, bytes, timed = false) => {
        const cpuStart = timed ? process.threadCpuUsage() : null;
        const raw = await harness.invokeRaw(bytes);
        const cpu = timed ? process.threadCpuUsage(cpuStart) : null;
        const { arenaLease, outputFrames, payloadArena, ...response } = decodePluginInvokeResponse(raw);
        // Copy all output payloads before another call can recycle module memory.
        // SDK arena leases are host ownership objects, not response wire fields.
        response.outputs = response.outputs.map(({ arenaLease, ...output }) =>
          ({ ...output, payload: Buffer.from(output.payload) }));
        responses.push({ method, ...response });
        assert.equal(response.statusCode, 0,
          `${seed.label} ${variant} ${method}: ${response.errorCode}: ${response.errorMessage}`);
        // Ingest acknowledges success without payloads; the other operations
        // must return data so identical empty/error results cannot pass.
        if (method !== 'ingest_state') assert.ok(response.outputs.length > 0, `${method} returned no output payload`);
        return { response, cpuSeconds: cpu ? (cpu.user + cpu.system) / 1e6 : undefined };
      };
      try {
        await call('ingest_state', ingestBytes);
        const sampleLoadStart = load();
        const prepared = await call('prepare_trajectory_segments', prepareBytes, true);
        const preparedRoot = decode(prepared.response.outputs[0].payload).PREPARE_RESULT;
        assert.ok(preparedRoot?.COVERAGE_COMPLETE, `${seed.label}: incomplete trajectory coverage`);
        if (!describeBytes) {
          segmentSet = preparedRoot.SEGMENT_SET_HANDLE;
          describeBytes = request('describe_trajectory_segments', [input('request', 'DESCRIBE_REQUEST',
            new P.PRWDescribeRequestT(identity, segmentSet))]);
        }
        assert.equal(preparedRoot.SEGMENT_SET_HANDLE, segmentSet, 'Fresh instances must return the same segment set');
        let chunks = 0;
        let records = 0;
        let finalChunk = false;
        while (!finalChunk) {
          assert.ok(chunks < 10000, `${seed.label}: describe never reached FINAL_CHUNK`);
          const described = await call('describe_trajectory_segments', describeBytes);
          ++chunks;
          for (const output of described.response.outputs) {
            const description = decode(output.payload).DESCRIBE_RESULT;
            assert.ok(description?.SOURCES?.length, 'Describe returned no trajectory sources');
            for (const source of description.SOURCES) {
              assert.equal(source.SOURCE_HANDLE, seed.handle);
              assert.ok(source.EPHEMERIS?.POSITION_RECORDS?.length, 'Describe returned no trajectory records');
              records += source.EPHEMERIS.POSITION_RECORDS.length;
            }
            assert.ok(!finalChunk, 'Describe emitted an output after FINAL_CHUNK');
            finalChunk = description.FINAL_CHUNK;
          }
        }
        const invoked = await call('invoke', invokeBytes);
        assert.ok(decode(invoked.response.outputs[0].payload).EXECUTION_RESULT?.FINAL_SAMPLE,
          'Stateless invoke returned no final sample');
        samples.push({ variant, repetition: repetition + 1, prepareCpuSeconds: prepared.cpuSeconds,
          prepareCpuSecondsPerDay: prepared.cpuSeconds / days, describeChunks: chunks, trajectoryRecords: records,
          statusCodes: responses.map(response => response.statusCode), loadStart: sampleLoadStart, loadEnd: load() });
        if (!reference) reference = responses;
        else {
          assert.equal(responses.length, reference.length, `${seed.label}: response count differs`);
          let bytesCompared = 0;
          for (let i = 0; i < responses.length; ++i) {
            const expected = reference[i], actual = responses[i];
            assert.equal(actual.statusCode, expected.statusCode, `${seed.label}: status differs at response ${i}`);
            const { outputs: expectedOutputs, ...expectedMetadata } = expected;
            const { outputs: actualOutputs, ...actualMetadata } = actual;
            assert.deepEqual(actualMetadata, expectedMetadata, `${seed.label}: response metadata differs at ${i}`);
            assert.equal(actualOutputs.length, expectedOutputs.length, `${seed.label}: output count differs at ${i}`);
            for (let j = 0; j < actualOutputs.length; ++j) {
              const { payload: expectedPayload, ...expectedPort } = expectedOutputs[j];
              const { payload: actualPayload, ...actualPort } = actualOutputs[j];
              assert.deepEqual(actualPort, expectedPort, `${seed.label}: output metadata differs at ${i}/${j}`);
              if (!expectedPayload.equals(actualPayload)) {
                const changed = [];
                for (let offset = 0; offset < Math.max(expectedPayload.length, actualPayload.length) && changed.length < 12; ++offset)
                  if (expectedPayload[offset] !== actualPayload[offset]) changed.push({ offset,
                    before: expectedPayload.subarray(Math.max(0, offset - 28), offset + 16).toString('utf8'),
                    after: actualPayload.subarray(Math.max(0, offset - 28), offset + 16).toString('utf8') });
                throw new Error(`${seed.label} ${variant} repetition ${repetition + 1}: ${actual.method} payload ${j} differs: ${JSON.stringify(changed)}`);
              }
              bytesCompared += expectedPayload.length;
            }
          }
          comparisons.push({ variant, repetition: repetition + 1, bytesCompared });
        }
      } finally { await harness.destroy(); }
    }
  }
  const minimumPrepareCpuSeconds = Object.fromEntries(['before', 'after'].map(variant =>
    [variant, Math.min(...samples.filter(sample => sample.variant === variant).map(sample => sample.prepareCpuSeconds))]));
  return { label: seed.label, identical: true, bytesCompared: comparisons.reduce((sum, item) => sum + item.bytesCompared, 0),
    responseBytesPerRun: reference.reduce((sum, response) => sum + response.outputs.reduce((n, output) => n + output.payload.length, 0), 0),
    responsesPerRun: reference.length, comparisons, samples, minimumPrepareCpuSeconds,
    minimumPrepareCpuSecondsPerDay: Object.fromEntries(Object.entries(minimumPrepareCpuSeconds).map(([key, value]) => [key, value / days])),
    loadStart, loadEnd: load() };
}

async function runSeed(data) {
  const worker = new Worker(new URL(import.meta.url), { workerData: data });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${data.seed.label}: worker exceeded the 180-second hang guard`)), 180000);
      worker.once('message', message => { clearTimeout(timer); message.error ? reject(new Error(message.error)) : resolve(message.result); });
      worker.once('error', error => { clearTimeout(timer); reject(error); });
      worker.once('exit', code => { clearTimeout(timer); reject(new Error(`${data.seed.label}: worker exited without a result (${code})`)); });
    });
  } finally { await worker.terminate(); }
}

async function main() {
  const started = performance.now();
  const report = { pass: false, epoch, target, days, durationSeconds, statelessDays: 1, repetitions,
    expectedAllocationsPerEvaluation: { before: 132, after: 0 }, loadStart: load(), seeds: [] };
  let temp;
  try {
    assert.equal(typeof process.threadCpuUsage, 'function', 'Node with process.threadCpuUsage is required (Node >=22.19 or >=24.6)');
    const base = await readJson(path.join(support, 'base.json'));
    assert.match(base.commit, /^[a-f0-9]{40}$/, 'base.commit must be a full commit hash');
    assert.equal(base.wasm, 'propagator/ffm/dist/isomorphic/module.wasm');
    assert.equal(base.sources, 'propagator/ffm/lib/environment_models.cpp');
    console.log('Gravity scratch allocation E2E — plain WebAssembly in Node; no browser or network');
    console.log(`Epoch ${epoch} UTC; resident ${days} days; stateless 1 day; before/after/before/after; load ${report.loadStart.join(', ')}`);
    // The only Git commands this E2E runs: the two explicitly authorized,
    // read-only baseline blob reads. Disable lazy object fetching and prompts.
    const gitOptions = { encoding: 'buffer', env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' } };
    const pinned = (await command('git', ['show', `${base.commit}:${base.wasm}`], gitOptions)).stdout;
    assert.equal(sha256(pinned), base.sha256, 'Pinned main WASM SHA-256 does not match base.json');
    const baseSource = (await command('git', ['show', `${base.commit}:${base.sources}`], gitOptions)).stdout;
    const sameVersion = base.sameVersionReference;
    assert.equal(sameVersion.file, 'before-1.4.1.wasm');
    assert.equal(sameVersion.sourceSha256, sha256(baseSource), 'Same-version reference source must be the pinned pre-fix source');
    assert.equal(sameVersion.version, (await readJson(path.join(moduleRoot, 'plugin-manifest.json'))).version);
    const before = await fs.readFile(path.join(support, sameVersion.file));
    assert.equal(sha256(before), sameVersion.sha256, 'Same-version reference WASM differs from its pinned build');
    const after = await fs.readFile(path.join(repoRoot, base.wasm));
    report.base = base;
    report.artifacts = { pinnedMainSha256: sha256(pinned), beforeSha256: sha256(before), afterSha256: sha256(after), beforeBytes: before.length, afterBytes: after.length,
      beforeSourceSha256: sha256(baseSource), afterSourceSha256: sha256(await fs.readFile(path.join(repoRoot, base.sources))) };
    console.log(`WASM SHA-256 before ${report.artifacts.beforeSha256}; after ${report.artifacts.afterSha256}`);
    temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ffm-gravity-scratch-'));
    console.log(`Native probe: compiling with host clang++; ${compileJobs} parallel jobs; shared probe object`);
    report.native = await nativeProbe(temp, baseSource);
    const nativeBefore = report.native.before, nativeAfter = report.native.after;
    console.log(`Native gravity 70/30/4: allocations/evaluation ${nativeBefore.allocationsPerEvaluation} -> ${nativeAfter.allocationsPerEvaluation}; expected 132 -> 0`);
    console.log(`Native gravity: minimum us/evaluation ${fixed(nativeBefore.minimumMicrosecondsPerEvaluation)} -> ${fixed(nativeAfter.minimumMicrosecondsPerEvaluation)}; 5 x 10000 evaluations after 10 warmups`);
    console.log(`Native load before ${nativeBefore.loadStart.join(', ')}; after ${nativeAfter.loadEnd.join(', ')}`);
    assert.equal(nativeBefore.allocationsPerEvaluation, 132, 'Baseline must make exactly 132 scratch allocations per evaluation');
    assert.ok(nativeAfter.samples.every(sample => sample.allocations === 0), 'Candidate probe must have zero allocations after warmup');
    assert.equal(nativeAfter.allocationsPerEvaluation, 0);
    const seeds = await readJson(path.join(support, 'seeds.json'));
    assert.deepEqual(seeds.map(seed => seed.label), ['ISS', 'STARLINK', 'SSO800', 'LOW250', 'GPS', 'GEO', 'MOLNIYA', 'GTO']);
    const manifest = await readJson(path.join(moduleRoot, 'dist/plugin-manifest.json'));
    for (const seed of seeds) {
      const result = await runSeed({ seed, before, after, manifest });
      report.seeds.push(result);
      const cpu = result.samples.map(sample => fixed(sample.prepareCpuSeconds)).join('/');
      const minimum = result.minimumPrepareCpuSeconds;
      const perDay = result.minimumPrepareCpuSecondsPerDay;
      console.log(`${result.label}: identical=yes; bytes compared=${result.bytesCompared}; responses/run=${result.responsesPerRun}; describe chunks/run=${result.samples[0].describeChunks}; prepare CPU s B/A/B/A=${cpu}; min B/A=${fixed(minimum.before)}/${fixed(minimum.after)}; s/day B/A=${fixed(perDay.before)}/${fixed(perDay.after)}; load=${result.loadEnd.join(', ')}`);
    }
    report.bytesCompared = report.seeds.reduce((sum, seed) => sum + seed.bytesCompared, 0);
    report.pass = true;
  } catch (error) {
    report.error = error.stack ?? String(error);
    console.log(`FAIL: ${error.message}`);
    process.exitCode = 1;
  } finally {
    if (temp) {
      try { await fs.rm(temp, { recursive: true, force: true }); }
      catch (error) { report.pass = false; report.cleanupError = error.message; process.exitCode = 1; }
    }
    report.loadEnd = load();
    report.elapsedSeconds = (performance.now() - started) / 1000;
    console.log(`${report.pass ? 'PASS' : 'FAIL'}: ${report.seeds.length}/8 seeds; elapsed ${fixed(report.elapsedSeconds)} s; load ${report.loadEnd.join(', ')}; timing is informational`);
    console.log(JSON.stringify(report));
  }
}

// All dependencies and WASM sources are local. Unexpected fetches fail closed.
globalThis.fetch = async () => { throw new Error('Network access is disabled for this E2E'); };
if (isMainThread) await main();
else {
  try { parentPort.postMessage({ result: await seedWorker() }); }
  catch (error) { parentPort.postMessage({ error: error.stack ?? String(error) }); }
}

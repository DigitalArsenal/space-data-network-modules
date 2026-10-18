// A slice of the single resident E2E, through public SDS/SDK methods. It
// checks observable selection, ordering, cache, and backward-path behavior.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';
import { packageRoot, standardRoot } from '../standard.mjs';
import { FAST_CATALOG_INTEGRATOR } from '../catalog.mjs';
const catalog = await import(pathToFileURL(path.join(standardRoot, 'catalog.mjs')));
const { environmentInputs, isoAfter, evaluatePpe } = await import(pathToFileURL(path.join(standardRoot, 'tests/lib/fullForce.mjs')));
const { makeTable, encodePrw, decodePrw, coordinateSystem, TYPE } = await import(pathToFileURL(path.join(standardRoot, 'tests/lib/prwCodec.mjs')));
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const frame = (portId, arm, value) => ({ portId, typeRef: TYPE, payload: encodePrw(arm, value) });
const pin = json(path.join(packageRoot, 'tests/fixtures/standard.json'));
const seeds = json(path.join(packageRoot, 'tests/fixtures/seeds.json'));
const compiled = new Map();
const T3 = { tolerance: 1e-14, initialStep: 2, minStep: 1e-4, maxStep: 2, maxSteps: 100000000 };

async function host(root, integrator, poison = true, fixtures = null) {
  if (!compiled.has(root)) compiled.set(root, await WebAssembly.compile(fs.readFileSync(path.join(root, 'dist/isomorphic/module.wasm'))));
  const moduleId = root === packageRoot ? 'com.orbpro.ffm-fast' : 'com.orbpro.ffm';
  const instance = makeTable('PRWInstance', { MODULE_ID: moduleId, INSTANCE_ID: 'phase2-batch', GENERATION: 1n });
  const h = await createBrowserModuleHarness({ wasmSource: compiled.get(root),
    manifest: json(path.join(root, 'plugin-manifest.json')), surface: 'direct' });
  const objects = fixtures ?? seeds.map((seed, i) => ({ ...seed, state: [...seed.position, ...seed.velocity].map(x => x * 1000), epochOffset: i * 7.125 }));
  const states = objects.map((seed) => {
    const record = catalog.residentState({ instanceId: instance.INSTANCE_ID, generation: 1n,
      handle: seed.handle, catalogNumber: seed.norad, objectId: seed.label,
      epoch: isoAfter(pin.fixtureEpochUtc, seed.epochOffset ?? 0), state: seed.state,
      cdAm: seed.cdAm, crAm: seed.crAm });
    record.INSTANCE.MODULE_ID = moduleId;
    return frame('state', 'RESIDENT_STATE', record);
  });
  // A valid, nonzero state below the reentry surface is accepted at ingest,
  // but cannot be propagated. Leaving it unselected proves subset semantics.
  if (poison) {
    const record = catalog.residentState({ instanceId: instance.INSTANCE_ID, generation: 1n,
      handle: 999999, catalogNumber: 999999, objectId: 'unselected-reentry-sentinel',
      epoch: pin.fixtureEpochUtc, state: [6400000, 0, 0, 0, 7800, 0], cdAm: .02, crAm: .02 });
    record.INSTANCE.MODULE_ID = moduleId;
    states.push(frame('state', 'RESIDENT_STATE', record));
  }
  const initial = seeds[0];
  try {
    const response = await h.invoke({ methodId: 'ingest_state', inputs: [...states,
      frame('configuration', 'EXECUTION_REQUEST', catalog.fullForceRequest({ epoch: pin.fixtureEpochUtc,
        state: [...initial.position, ...initial.velocity].map(x => x * 1000), integrator })), ...environmentInputs()] });
    assert.equal(response.statusCode, 0, `ingest: ${response.errorCode}: ${response.errorMessage}`);
  } catch (error) { await h.destroy(); throw error; }
  return { h, instance };
}
async function prepare(host, handles, offset, duration) {
  const response = await host.h.invoke({ methodId: 'prepare_trajectory_segments', inputs: [frame('request', 'PREPARE_REQUEST',
    makeTable('PRWPrepareRequest', { INSTANCE: host.instance, SOURCE_HANDLES: handles,
      START_EPOCH: catalog.instant(isoAfter(pin.fixtureEpochTt, offset), 'TT'), DURATION_SECONDS: duration,
      PROFILE: 'conjunction-screening' }))] });
  assert.equal(response.statusCode, 0, `prepare: ${response.errorCode}: ${response.errorMessage}`);
  return decodePrw(response.outputs[0].payload).PREPARE_RESULT.SEGMENT_SET_HANDLE;
}
async function describe(host, segmentSet, handles) {
  const request = { methodId: 'describe_trajectory_segments', outputStreamCap: handles.length,
    inputs: [frame('request', 'DESCRIBE_REQUEST', makeTable('PRWDescribeRequest', {
      INSTANCE: host.instance, SEGMENT_SET_HANDLE: segmentSet, SOURCE_HANDLES: handles }))] };
  const output = new Map();
  for (;;) {
    const response = await host.h.invoke(request);
    assert.equal(response.statusCode, 0, `describe: ${response.errorCode}: ${response.errorMessage}`);
    for (const frame of response.outputs) for (const source of decodePrw(frame.payload).DESCRIBE_RESULT.SOURCES) {
      assert(!output.has(source.SOURCE_HANDLE), 'duplicate returned source');
      // Normalize only transport bookkeeping; retain every PPE coefficient,
      // quality value, identity, epoch, and frame byte in the comparison.
      const bytes = Buffer.from(encodePrw('DESCRIBE_RESULT', makeTable('PRWDescribeResult', {
        INSTANCE: host.instance, SEGMENT_SET_HANDLE: 1, SOURCE_OFFSET: 0n, FINAL_CHUNK: true, SOURCES: [source] })));
      output.set(source.SOURCE_HANDLE, { bytes, ppe: source.EPHEMERIS });
    }
    if (!response.yielded) break;
  }
  assert.deepEqual([...output.keys()], handles);
  return output;
}
export async function batchEvidence() {
  const handles = seeds.map(seed => seed.handle).reverse();
  const windows = [{ name: 'midnight', offset: 42500, duration: 900 },
    { name: 'carried-forward', offset: 43400, duration: 600 },
    { name: 'earlier-forward', offset: 1200, duration: 600 },
    { name: 'backward', offset: -1200, duration: 600 }];
  const batch = await host(packageRoot, FAST_CATALOG_INTEGRATOR);
  const rows = [];
  try {
    for (const window of windows) {
      const selected = window.name === 'earlier-forward' ? handles.filter((_, i) => i % 2 === 0) : handles;
      const set = await prepare(batch, selected, window.offset, window.duration);
      const batched = await describe(batch, set, selected);
      const serial = await host(packageRoot, FAST_CATALOG_INTEGRATOR);
      const hash = createHash('sha256');
      try {
        for (const handle of selected) {
          const single = await prepare(serial, [handle], window.offset, window.duration);
          const source = (await describe(serial, single, [handle])).get(handle);
          assert(source.bytes.equals(batched.get(handle).bytes), `${window.name}: batch/cold serial bytes differ for ${handle}`);
          hash.update(source.bytes);
        }
      } finally { await serial.h.destroy(); }
      const row = { ...window, objects: selected.length, byteIdentical: true, serializedSha256: hash.digest('hex') };
      if (window.name === 'backward') {
        // Standard T3 provides an independent backward accuracy reference;
        // the initial vectors are unchanged, with deliberately mixed epochs.
        const reference = await host(standardRoot, T3, false);
        try {
          const referenceSet = await prepare(reference, selected, window.offset, window.duration);
          const expected = await describe(reference, referenceSet, selected);
          let positionM = 0, velocityMps = 0;
          for (const handle of selected) for (let dt = 0; dt <= window.duration; dt += 10) {
            const epoch = isoAfter(pin.fixtureEpochTt, window.offset + dt);
            const a = evaluatePpe(batched.get(handle).ppe, epoch), b = evaluatePpe(expected.get(handle).ppe, epoch);
            positionM = Math.max(positionM, Math.hypot(...a.position.map((x, i) => x - b.position[i])) * 1000);
            velocityMps = Math.max(velocityMps, Math.hypot(...a.velocity.map((x, i) => x - b.velocity[i])) * 1000);
          }
          // FIT's 1 cm position budget; SCREEN's 1 mm/s velocity budget.
          assert(positionM <= .01 && velocityMps <= .001, `backward T3 comparison: ${positionM} m, ${velocityMps} m/s`);
          row.reference = { integrator: T3, positionM, velocityMps, samplingSeconds: 10 };
        } finally { await reference.h.destroy(); }
      }
      rows.push(row);
    }
    // The sentinel is genuinely unpropagatable; subset success above cannot
    // be explained by a harmless extra trajectory being silently prepared.
    const bad = await batch.h.invoke({ methodId: 'prepare_trajectory_segments', inputs: [frame('request', 'PREPARE_REQUEST',
      makeTable('PRWPrepareRequest', { INSTANCE: batch.instance, SOURCE_HANDLES: [999999],
        START_EPOCH: catalog.instant(pin.fixtureEpochTt, 'TT'), DURATION_SECONDS: 60, PROFILE: 'conjunction-screening' }))] });
    assert.notEqual(bad.statusCode, 0, 'selected reentry sentinel must fail');
    assert.match(`${bad.errorCode}: ${bad.errorMessage}`, /reentry/i);
    assert.match(bad.errorMessage, /999999/, 'failure must identify the selected object');
    return { ok: true, cohortSize: 32, heterogeneousEpochSpacingSeconds: 7.125,
      unselectedReentrySentinelPreserved: true, rows };
  } finally { await batch.h.destroy(); }
}

async function residentState(host, handle, offset) {
  const response = await host.h.invoke({ methodId: 'propagate_state', inputs: [frame('request', 'RESIDENT_REQUEST',
    makeTable('PRWResidentRequest', { INSTANCE: host.instance, ENTITY_HANDLES: [handle],
      TARGET_EPOCH: catalog.instant(isoAfter(pin.fixtureEpochTt, offset), 'TT'), TARGET_COORDINATE_SYSTEM: coordinateSystem() }))] });
  assert.equal(response.statusCode, 0, `state: ${response.errorCode}: ${response.errorMessage}`);
  return decodePrw(response.outputs[0].payload).RESIDENT_STATE.STATE;
}
async function sunAtTdb(host, epoch) {
  const response = await host.h.invoke({ methodId: 'invoke', inputs: [frame('request', 'EPHEMERIS_REQUEST',
    makeTable('PRWEphemerisRequest', { TARGET_NAIF_ID: 10, CENTER_NAIF_ID: 399, EPOCH: catalog.instant(epoch, 'TDB') })),
    ...environmentInputs().filter(input => input.portId === 'kernel')] });
  assert.equal(response.statusCode, 0, `Sun ephemeris: ${response.errorCode}: ${response.errorMessage}`);
  return decodePrw(response.outputs[0].payload).EPHEMERIS_RESULT.STATE.STATE.POSITION;
}
let nativeGenerator;
function boundaryGenerator() {
  if (nativeGenerator) return nativeGenerator;
  const source = path.join(packageRoot, 'scripts/boundary-states.cpp');
  const cache = path.join(packageRoot, '.sdk-build');
  fs.mkdirSync(cache, { recursive: true });
  const binary = path.join(cache, 'boundary-states');
  const run = (command, args, input) => {
    const result = spawnSync(command, args, { encoding: 'utf8', input, maxBuffer: 4 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`${command}: ${result.error ?? result.stderr}`);
    return result.stdout;
  };
  run('c++', ['-std=c++17', '-O2', '-ffp-contract=off', '-I', path.join(standardRoot, 'lib'), source, '-o', binary]);
  nativeGenerator = { source, binary, run };
  return nativeGenerator;
}
export async function boundaryEvidence() {
  const { source, binary, run } = boundaryGenerator();
  const orientation = await host(standardRoot, T3, false);
  const orientations = [];
  try {
    // The standard resident encoder supplies the converted TDB label; JS
    // neither converts time scales nor constructs orbit geometry.
    for (const offset of [917.123, 1050.123]) {
      const state = await residentState(orientation, seeds[0].handle, offset);
      assert.equal(state.EPOCH_TIME_SYSTEM, 'TDB');
      orientations.push({ offset, epochTdb: state.EPOCH, sunM: await sunAtTdb(orientation, state.EPOCH) });
    }
  } finally { await orientation.h.destroy(); }
  const cases = JSON.parse(run(binary, [String(catalog.GM),
    ...orientations.flatMap(({ sunM }) => [sunM.X, sunM.Y, sunM.Z].map(String))]));
  const fixtures = cases.map((entry, i) => ({ ...entry, label: entry.name, handle: 10000 + i,
    norad: 10000 + i, cdAm: .02, crAm: entry.crAm ?? .02, epochOffset: 0 }));
  const handles = fixtures.map(entry => entry.handle);
  const fast = await host(packageRoot, FAST_CATALOG_INTEGRATOR, false, fixtures);
  const reference = await host(standardRoot, T3, false, fixtures);
  const rows = [];
  try {
    const a = await describe(fast, await prepare(fast, handles, 0, 1800), handles);
    const b = await describe(reference, await prepare(reference, handles, 0, 1800), handles);
    for (const entry of fixtures) {
      const actual = a.get(entry.handle).ppe, expected = b.get(entry.handle).ppe;
      assert(actual.COMMENT.includes(`Fast forward resident integrator: ${entry.expected}.`),
        `${entry.name}: automatic integrator differs: ${actual.COMMENT.join('; ')}`);
      let positionM = 0, velocityMps = 0;
      for (let elapsed = 0; elapsed <= 1800; elapsed += entry.graze ? 1 : 10) {
        const epoch = isoAfter(pin.fixtureEpochTt, elapsed);
        const x = evaluatePpe(actual, epoch), y = evaluatePpe(expected, epoch);
        positionM = Math.max(positionM, Math.hypot(...x.position.map((value, i) => value - y.position[i])) * 1000);
        velocityMps = Math.max(velocityMps, Math.hypot(...x.velocity.map((value, i) => value - y.velocity[i])) * 1000);
      }
      assert(positionM <= .01 && velocityMps <= .001, `${entry.name}: T3 error ${positionM} m, ${velocityMps} m/s`);
      const row = { name: entry.name, integrator: entry.expected, seconds: 1800,
        samplingSeconds: entry.graze ? 1 : 10, positionM, velocityMps, crAm: entry.crAm,
        strongGraze: entry.strongGraze ?? false };
      if (entry.graze) {
        const samples = [];
        const halfWidth = entry.auditHalfWidthSeconds;
        const center = Math.floor(entry.grazeCenterSeconds);
        for (let offset = center - halfWidth; offset <= center + halfWidth; ++offset) {
          const state = await residentState(reference, entry.handle, offset);
          const solar = await sunAtTdb(reference, state.EPOCH);
          samples.push([offset, state.POSITION.X, state.POSITION.Y, state.POSITION.Z, solar.X, solar.Y, solar.Z].join(' '));
        }
        row.shadow = JSON.parse(run(binary, ['--audit-shadow'], `${samples.join('\n')}\n`));
        if (entry.strongGraze) for (const key of ['penumbraAtStepStart', 'penumbraAtStepMidpoint', 'penumbraAtStepEnd'])
          assert(row.shadow[key] > 0, `Strong graze must be hidden from endpoint/midpoint-only detection: ${key}`);
      }
      rows.push(row);
    }
    const grazes = rows.filter(row => row.shadow?.penumbraCrossings === 2 && row.shadow.umbraCrossings === 0 &&
      row.shadow.midpointCrossings === 0 && row.shadow.minimumPenumbra < 0 && row.shadow.minimumMidpoint > 0);
    assert(grazes.length > 0, 'Independent standard trajectory did not realize a penumbra-only enter/exit graze');
    assert(grazes.some(row => row.strongGraze), 'The larger-area reference object must realize a penumbra-only graze');
    return { ok: true, sourceSha256: createHash('sha256').update(fs.readFileSync(source)).digest('hex'),
      initialStateSource: 'C++ two-body perigee states with configured TT-compatible GM; grazing planes oriented using standard DE440 Sun',
      gmM3s2: catalog.GM, orientations, epochUtc: pin.fixtureEpochUtc, frame: 'GCRF',
      referenceIntegrator: T3, confirmedPenumbraOnlyGrazes: grazes.length, rows };
  } finally { await fast.h.destroy(); await reference.h.destroy(); }
}

export async function startupDomainEvidence() {
  const { binary, run } = boundaryGenerator();
  const offset = 1.125, duration = 60, handle = 20000;
  const fixtures = [{ label: 'ascending above reentry surface', handle, norad: handle,
    state: JSON.parse(run(binary, ['--startup-state'])), epochOffset: offset, cdAm: .02, crAm: .02 }];
  // Establish the physical forward interval with standard T3 before Fast.
  const reference = await host(standardRoot, T3, false, fixtures);
  let fast;
  try {
    const expected = (await describe(reference, await prepare(reference, [handle], offset, duration), [handle])).get(handle).ppe;
    fast = await host(packageRoot, FAST_CATALOG_INTEGRATOR, false, fixtures);
    const actual = (await describe(fast, await prepare(fast, [handle], offset, duration), [handle])).get(handle).ppe;
    let ppePositionM = 0, ppeVelocityMps = 0, statePositionM = 0, stateVelocityMps = 0;
    for (let elapsed = 0; elapsed <= duration; ++elapsed) {
      const epoch = isoAfter(pin.fixtureEpochTt, offset + elapsed);
      const a = evaluatePpe(actual, epoch), b = evaluatePpe(expected, epoch);
      ppePositionM = Math.max(ppePositionM, Math.hypot(...a.position.map((x, i) => x - b.position[i])) * 1000);
      ppeVelocityMps = Math.max(ppeVelocityMps, Math.hypot(...a.velocity.map((x, i) => x - b.velocity[i])) * 1000);
    }
    for (const elapsed of [0, 10, 30, 60]) {
      const a = await residentState(fast, handle, offset + elapsed), b = await residentState(reference, handle, offset + elapsed);
      statePositionM = Math.max(statePositionM, Math.hypot(...['X', 'Y', 'Z'].map(axis => a.POSITION[axis] - b.POSITION[axis])));
      stateVelocityMps = Math.max(stateVelocityMps, Math.hypot(...['X', 'Y', 'Z'].map(axis => a.VELOCITY[axis] - b.VELOCITY[axis])));
    }
    assert(ppePositionM <= .01 && ppeVelocityMps <= .001 && statePositionM <= .01 && stateVelocityMps <= .001,
      `Ascending startup-domain comparison: ${JSON.stringify({ ppePositionM, ppeVelocityMps, statePositionM, stateVelocityMps })}`);
    return { ok: true, offsetSeconds: offset, durationSeconds: duration,
      referenceIntegrator: T3, actualPolicy: actual.COMMENT, ppePositionM, ppeVelocityMps, statePositionM, stateVelocityMps };
  } finally { await fast?.h.destroy(); await reference.h.destroy(); }
}

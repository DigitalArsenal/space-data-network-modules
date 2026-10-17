#!/usr/bin/env node
// The farm slice of the FFM Fast E2E: actual epoch-state -> resident FFM/Fast
// -> portable trajectories -> conjunction screening. No generated truth and
// no JS physics; C5 compares serialized PPE bytes from cold/carried runs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import * as flatbuffers from 'flatbuffers';
import { compareEvents } from './ca-comparison.mjs';
import { runReferenceCatalog } from './reference-farm.mjs';
import { PRW } from 'spacedatastandards.org/lib/js/PRW/main.js';
import { PPE } from 'spacedatastandards.org/lib/js/PPE/main.js';
import { modulesRoot, loadFarm, loadCatalog, selectCatalog, encodeCatalog, runCatalog, sha256 } from './benchmark-catalog.mjs';

const { values: o } = parseArgs({ options: {
  catalog: { type: 'string' }, environment: { type: 'string' }, out: { type: 'string' }, 'farm-module': { type: 'string' },
  workers: { type: 'string' }, start: { type: 'string', default: '2026-10-04T00:00:00Z' },
  objects: { type: 'string', default: '1000' }, 'screen-objects': { type: 'string', default: '2000' },
  'screen-workers': { type: 'string', default: '1' }, 'uncertainty-model': { type: 'string' },
  'carry-only': { type: 'boolean', default: false }, phase: { type: 'string', default: 'phase-1' },
} });
if (!o.catalog || !o.environment || !o.out) throw new Error('Required: --catalog archive.json[.gz] --environment PRW-directory --out result.json [--farm-module reviewed-patch/ffmFarm.mjs].');
const catalog = loadCatalog(o.catalog), { createFfmFarm } = await loadFarm(o['farm-module']);
const workers = o.workers ? Number(o.workers) : undefined;
const startJd = Date.parse(o.start) / 86400000 + 2440587.5;
const result = { phase: o.phase, completed: false, catalogSha256: catalog.sha256, startUtc: o.start, carry: [], propagation: [], screen: [],
  limitations: ['Sigma comparison uses E14 GP prediction-error covariance as an input uncertainty scale; it does not assert calibrated FFM covariance.'] };
const ppeBytes = (frames) => {
  const map = new Map();
  for (const frame of frames) {
    const sources = PRW.getSizePrefixedRootAsPRW(new flatbuffers.ByteBuffer(frame)).DESCRIBE_RESULT().unpack().SOURCES;
    for (const source of sources) {
      const builder = new flatbuffers.Builder(4096);
      PPE.finishPPEBuffer(builder, source.EPHEMERIS.pack(builder));
      assert(!map.has(source.SOURCE_HANDLE), `Duplicate source ${source.SOURCE_HANDLE}`);
      map.set(source.SOURCE_HANDLE, Buffer.from(builder.asUint8Array()));
    }
  }
  return map;
};
async function carry(implementation) {
  const records = selectCatalog(catalog.records, 9).records;
  const initial = records.slice(0, 8);
  const changed = { ...initial[0], MEAN_ANOMALY: (Number(initial[0].MEAN_ANOMALY) + 0.01) % 360 };
  // This controlled input change exercises invalidation; it is not represented
  // as a new archived observation. Keep six, change one, delete one, add one.
  const next = [...initial.slice(1, 7), changed, records[8]].reverse();
  const originalBytes = await encodeCatalog(initial), nextBytes = await encodeCatalog(next);
  const base = { modulesRoot, environment: o.environment, workers, profile: 'full-force', screenStartJd: startJd };
  let warm, cold;
  try {
    // Omission proves the default FFM branch, not just an explicit selector.
    warm = await createFfmFarm({ ...base, catalog: originalBytes, ...(implementation === 'ffm' ? {} : { implementation }) });
    assert.equal(warm.implementation, implementation); assert.equal(warm.moduleId, `com.orbpro.${implementation}`);
    assert(warm.workers > 0 && warm.workers <= initial.length);
    assert.equal(warm.excluded.length, 0, 'C5 requires all selected objects to derive.');
    const firstHandles = new Map(warm.objects.map((r) => [r.norad, r.handle]));
    await assert.rejects(warm.updateCatalog(originalBytes, { handles: Array(initial.length).fill(1) }), /unique positive uint32/);
    await assert.rejects(warm.updateCatalog([originalBytes[0], originalBytes[0]]), /unique positive NORAD/);
    assert.equal(warm.objects.length, initial.length, 'Invalid updates must leave the resident catalog intact.');
    const first = await warm.window(startJd, 1 / 24);
    assert.equal(first.frames.length, initial.length, 'C5 warm screen must cover every initial object.');
    // Queue a window immediately: it must observe the completed update.
    const updatePromise = warm.updateCatalog(nextBytes);
    const carriedPromise = warm.window(startJd + 1 / 24, 1 / 24);
    const [update, carried] = await Promise.all([updatePromise, carriedPromise]);
    assert.deepEqual(Object.fromEntries(['unchanged', 'changed', 'added', 'deleted', 'derived'].map((k) => [k, update[k]])),
      { unchanged: 6, changed: 1, added: 1, deleted: 1, derived: 2 });
    for (const row of warm.objects) if (firstHandles.has(row.norad)) assert.equal(row.handle, firstHandles.get(row.norad));
    assert(!warm.objects.some((r) => r.norad === Number(initial[7].NORAD_CAT_ID)));
    const handles = warm.objects.map((r) => r.handle);
    const warmTrajectories = ppeBytes(carried.frames);
    cold = await createFfmFarm({ ...base, implementation, catalog: nextBytes, handles });
    const coldWindow = await cold.window(startJd + 1 / 24, 1 / 24), coldTrajectories = ppeBytes(coldWindow.frames);
    assert.equal(warmTrajectories.size, next.length); assert.equal(coldTrajectories.size, next.length);
    for (const [handle, bytes] of coldTrajectories) assert(bytes.equals(warmTrajectories.get(handle)), `${implementation} C5 trajectory differs for handle ${handle}.`);
    const unchanged = await warm.updateCatalog(nextBytes);
    assert.equal(unchanged.derived, 0); assert.equal(unchanged.unchanged, next.length);
    for (const stats of warm.residency) { assert(stats.instances <= stats.maximumInstances); assert(stats.retained <= Math.max(2048, 2 * stats.live)); }
    const residency = warm.residency;
    // Deleting every object must release every resident instance and return no
    // stale trajectory; repopulation must still work with stable unique handles.
    const empty = await warm.updateCatalog([]);
    assert.equal(empty.deleted, next.length); assert.equal(warm.instances, 0);
    assert.equal((await warm.window(startJd + 2 / 24, 1 / 24)).frames.length, 0);
    const repopulated = await warm.updateCatalog(nextBytes);
    assert.equal(repopulated.added, next.length);
    const signature = sha256(Buffer.concat([...coldTrajectories.entries()].sort(([a], [b]) => a - b).map(([, bytes]) => bytes)));
    return { implementation, workers: warm.workers, workerPolicy: warm.workerPolicy, update, trajectories: coldTrajectories.size,
      byteIdentical: true, invalidUpdatesPreservedCatalog: true, concurrentWindowSerialized: true, ppeSha256: signature, unchangedUpdateDerived: unchanged.derived, deletedAll: empty.deleted, repopulated: repopulated.added,
      residency, carriedWindowCpuSeconds: warm.cpu.windows[1].cpuS, coldWindowCpuSeconds: cold.cpu.windows[0].cpuS };
  } finally { await warm?.close(); await cold?.close(); }
}

try {
  await assert.rejects(createFfmFarm({ catalog: [], modulesRoot, implementation: 'unknown' }), /Unknown FFM implementation/);
  await assert.rejects(createFfmFarm({ catalog: [], modulesRoot, workers: 0 }), /positive integer/);
  for (const implementation of ['ffm', 'ffm-fast']) {
    result.carry.push(await carry(implementation));
    console.log(JSON.stringify({ stage: 'C5', ...result.carry.at(-1) }));
  }
  if (o['carry-only']) result.limitations.push('Propagation 1,000 x 3 d and CA 2,000 x 1 d omitted by --carry-only; this is a partial E2E.');
  else {
    for (const [screen, count, days] of [[false, Number(o.objects), 3], [true, Number(o['screen-objects']), 1]]) {
      const selected = selectCatalog(catalog.records, count), list = screen ? result.screen : result.propagation;
      for (const implementation of ['ffm', 'ffm-fast']) {
        const measured = await runCatalog({ ...selected, catalogSha256: catalog.sha256, implementation, environment: o.environment, workers,
          startUtc: o.start, days, windowHours: 1, screen, screenWorkers: Number(o['screen-workers']), farmModule: o['farm-module'], phase: o.phase,
          uncertaintyModel: o['uncertainty-model'] });
        list.push(measured); assert(measured.completed, measured.error);
        fs.writeFileSync(o.out, JSON.stringify(result, null, 2) + '\n');
      }
      assert.equal(list[0].excluded, list[1].excluded); assert.equal(list[0].dropped, list[1].dropped);
      if (screen) {
        result.reference = await runReferenceCatalog({ ...selected, catalogSha256: catalog.sha256, environment: o.environment, workers,
          startUtc: o.start, days, windowHours: 1, screen, screenWorkers: Number(o['screen-workers']), farmModule: o['farm-module'],
          uncertaintyModel: o['uncertainty-model'] });
        fs.writeFileSync(o.out, JSON.stringify(result, null, 2) + '\n');
        assert(result.reference.completed, result.reference.error);
      }
    }
    result.caComparison = compareEvents(result.screen[0], result.screen[1], result.reference, catalog.records, modulesRoot, sha256);
    assert(result.caComparison.pass, 'Fast must match the reference event set and meet 1 m / 1 ms for every event within the eight-day prediction-age domain.');
    if (Number(o.objects) !== 1000 || Number(o['screen-objects']) !== 2000)
      result.limitations.push('Object-count override: this is not the required 1,000-object / 2,000-object catalog acceptance run.');
  }
  result.completed = !o['carry-only'] && Number(o.objects) === 1000 && Number(o['screen-objects']) === 2000;
  result.checksPassed = true;
} catch (error) { result.error = String(error.stack ?? error); process.exitCode = 1; }
finally { fs.writeFileSync(o.out, JSON.stringify(result, null, 2) + '\n'); }
console.log(JSON.stringify({ completed: result.completed, checksPassed: result.checksPassed ?? false, carry: result.carry,
  caComparison: result.caComparison, error: result.error, output: path.resolve(o.out) }));

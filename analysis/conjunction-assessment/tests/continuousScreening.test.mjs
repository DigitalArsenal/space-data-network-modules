// Continuous screening (gpu/continuousScreen.mjs) on invented element sets
// (tests/lib/syntheticCatalog.mjs): crossing circular orbits near 550 km and
// one set SGP4 cannot propagate. TEME, UTC, two 1-hour windows from
// 2026-10-01T00:00Z, 20 km threshold, 60 s coarse steps. The reference is the
// established windowed screen (search_candidates, refine_candidates); every
// comparison is exact (each event's every field), because both paths refine
// the same pairs from the same sources in the module.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createConjunctionCommandHarness } from './lib/conjunctionCommandHarness.mjs';
import { syntheticGp, updatedGp } from './lib/syntheticCatalog.mjs';
import { createOmmEncoder } from '../scripts/lib/ommCatalog.mjs';
import { decodeCatalogResult, prepareIndex, releaseIndex, screenCatalog, screenWindows, sgp4Sources, windowRequest } from '../gpu/catalogScreen.mjs';
import { mergeWindowEvents, objectKey } from '../gpu/allVsAll.mjs';
import { ROLE, cutBlocks, sampleWindowGrid, screenStoredWindow, spliceGridRows, unitRoles } from '../gpu/continuousScreen.mjs';

const windows = screenWindows(2461314.5, 2 / 24, 1);
const controls = { thresholdKm: 20, coarseStepSec: 60, workers: 4 };
const encode = await createOmmEncoder();
const canonical = (e) => JSON.stringify(e, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
const keysOf = (e) => [objectKey(e.PRIMARY_ID, e.PRIMARY_NORAD_ID), objectKey(e.SECONDARY_ID, e.SECONDARY_NORAD_ID)];
const sameSet = (a, b) => a.length === b.length && new Set(a).size === a.length && a.every((x) => new Set(b).has(x));

async function session(workers = controls.workers) {
  const harness = await createConjunctionCommandHarness({ runtimeKind: 'browser' });
  const invoke = (methodId, inputs) => harness.invoke({ methodId, inputs });
  const options = { ...controls, workers };
  return {
    invoke, destroy: () => harness.destroy?.(),
    full: async (frames) => (await screenCatalog({ invoke, propagator: 'sgp4', catalog: frames, windows, controls: options })).events,
    grids: async (frames) => {
      const handle = await prepareIndex(invoke, sgp4Sources(frames));
      const grids = [];
      for (const w of windows) grids.push(await sampleWindowGrid({ invoke, request: windowRequest(handle, 'TEME', w, options) }));
      await releaseIndex(invoke, handle);
      return grids;
    },
    // One window of a stored grid with roles, refined on an index of the rows its candidates name.
    window: async (frames, grid, w, roles, onResult) => {
      const sources = sgp4Sources(frames);
      return screenStoredWindow({ invoke, decodeCatalogResult, grid, roles, onResult, request: windowRequest(0, 'TEME', windows[w], options),
        refineIndex: async (rows) => {
          const h = await prepareIndex(invoke, rows.map((r) => sources[r]));
          return { request: windowRequest(h, 'TEME', windows[w], options), release: () => releaseIndex(invoke, h) };
        } });
    },
  };
}
const excludedKeys = (frames, grids) => {
  const sources = sgp4Sources(frames), out = new Set();
  for (const g of grids) for (const row of g.excluded.keys()) out.add(objectKey(sources[row].OBJECT_ID, sources[row].NORAD_CATALOG_ID));
  return out;
};

test('Incremental: re-screening only the updated objects equals the full re-screen for every pair with an updated member', async () => {
  const s = await session();
  try {
    const before = syntheticGp(), after = updatedGp(before, { count: 40 });
    const framesBefore = before.map(encode), framesAfter = after.records.map(encode);
    const fullBefore = await s.full(framesBefore), fullAfter = await s.full(framesAfter);
    // The kept grid of the old catalog, the updated rows refreshed from an index of just them.
    const grids = await s.grids(framesBefore), parts = await s.grids(after.rows.map((r) => framesAfter[r]));
    grids.forEach((g, w) => spliceGridRows(g, parts[w], after.rows));
    const roles = new Uint8Array(framesAfter.length);
    for (const r of after.rows) roles[r] = ROLE.PRIMARY;
    const events = [];
    for (let w = 0; w < windows.length; w++) events.push(...(await s.window(framesAfter, grids[w], w, roles)).events);
    const incremental = mergeWindowEvents(events, excludedKeys(framesAfter, grids)).map(canonical);
    const sources = sgp4Sources(framesAfter);
    const updated = new Set(after.rows.map((r) => objectKey(sources[r].OBJECT_ID, sources[r].NORAD_CATALOG_ID)));
    const touches = (e) => keysOf(e).some((k) => updated.has(k));
    const expected = fullAfter.filter(touches).map(canonical);
    assert.ok(expected.length >= 5 && fullAfter.length > expected.length, `${expected.length} affected of ${fullAfter.length}`);
    assert.ok(sameSet(incremental, expected), 'the incremental events are the full screen\'s events with an updated member');
    // The previous screen with those pairs replaced is the new full screen.
    const merged = [...fullBefore.filter((e) => !touches(e)).map(canonical), ...incremental];
    assert.ok(sameSet(merged, fullAfter.map(canonical)), 'previous screen + incremental = full re-screen');
  } finally { await s.destroy(); }
});

test('Work units: object blocks x windows cover every pair once and reproduce the full screen', async () => {
  const s = await session();
  try {
    const frames = syntheticGp().map(encode);
    const full = (await s.full(frames)).map(canonical);
    const grids = await s.grids(frames);
    const blocks = cutBlocks(Array.from({ length: frames.length }, (_, i) => i), 90);
    const events = [];
    for (let u = 0; u < blocks.length; u++) {
      for (let w = 0; w < windows.length; w++) events.push(...(await s.window(frames, grids[w], w, unitRoles(frames.length, blocks, u))).events);
    }
    assert.equal(new Set(events.map(canonical)).size, events.length, 'no pair is screened by two units');
    assert.ok(sameSet(mergeWindowEvents(events, excludedKeys(frames, grids)).map(canonical), full));
  } finally { await s.destroy(); }
});

test('Replication: a unit run on two instances, with 1 and 4 module threads, gives byte-identical results', async () => {
  const hashes = [];
  for (const workers of [1, 4]) {
    const s = await session(workers);
    try {
      const frames = syntheticGp().map(encode);
      const grids = await s.grids(frames);
      const roles = unitRoles(frames.length, cutBlocks(Array.from({ length: frames.length }, (_, i) => i), 90), 1);
      const hash = createHash('sha256');
      const run = await s.window(frames, grids[1], 1, roles, (payload) => hash.update(payload));
      assert.ok(run.events.length > 0);
      hashes.push(hash.digest('hex'));
    } finally { await s.destroy(); }
  }
  assert.equal(hashes[0], hashes[1]);
});

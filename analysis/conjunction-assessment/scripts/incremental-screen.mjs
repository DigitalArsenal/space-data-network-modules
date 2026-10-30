#!/usr/bin/env node
// Incremental screening on real update batches. The catalog is a GP snapshot;
// each batch applies the element sets Space-Track created in its interval
// (gp_history by CREATION_DATE). For each batch it runs
//   full:        the established windowed screen of the whole updated catalog
//                (search_candidates, refine_candidates);
//   incremental: the kept catalog grid with the updated objects' rows
//                refreshed, searched with them as primaries (search_grid,
//                refine_candidates);
// and checks that the incremental events equal the full screen's events for
// every pair with an updated member, and that the previous full screen with
// those pairs replaced equals the new full screen. Writes aggregates only:
// counts, timings, CPU time and event-set hashes, never an element set.
//
// usage: node scripts/incremental-screen.mjs --catalog-json <gp.json> --gp-history <by-creation dir>
//          --batches <ISO,ISO,...> [--start 2461314.5] [--days 3] [--window-hours 6] [--threshold-km 5]
//          [--step-s 60] [--workers 6] [--subsets k1,k2,...] --out <summary.json>
// --subsets: instead of chained batches, the first batch's updated objects (existing ones only) in a
// fixed pseudo-random order, the first k of them applied to the snapshot for each k; each state is
// compared with the snapshot, and the grid is restored after each.
import fs from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { PRWInstanceT } from 'spacedatastandards.org/lib/js/CQR/main.js';
import { createConjunctionCommandHarness } from '../tests/lib/conjunctionCommandHarness.mjs';
import { decodeCatalogResult, prepareIndex, releaseIndex, screenCatalog, screenWindows, sgp4Sources, windowRequest } from '../gpu/catalogScreen.mjs';
import { mergeWindowEvents, objectKey, refuseAt } from '../gpu/allVsAll.mjs';
import { ROLE, sampleWindowGrid, screenStoredWindow, spliceGridRows } from '../gpu/continuousScreen.mjs';
import { createOmmEncoder } from './lib/ommCatalog.mjs';
import { elementKey, recordsCreated, utcMs } from './lib/gpHistory.mjs';

const { values: o } = parseArgs({ options: {
  'catalog-json': { type: 'string' }, 'gp-history': { type: 'string' }, batches: { type: 'string' },
  start: { type: 'string', default: '2461314.5' }, days: { type: 'string', default: '3' }, 'window-hours': { type: 'string', default: '6' },
  'threshold-km': { type: 'string', default: '5' }, 'step-s': { type: 'string', default: '60' }, workers: { type: 'string', default: '6' },
  subsets: { type: 'string' }, out: { type: 'string' },
} });
if (!o['catalog-json'] || !o['gp-history'] || !o.batches || !o.out) throw new Error('--catalog-json, --gp-history, --batches and --out are required.');
const controls = { thresholdKm: Number(o['threshold-km']), coarseStepSec: Number(o['step-s']), workers: Number(o.workers), algorithm: 'ALFANO_MAXIMUM' };
const windows = screenWindows(Number(o.start), Number(o.days), Number(o['window-hours']));
const log = (m) => console.error(`${new Date().toISOString().slice(11, 19)} ${m}`);

// Measures wall and process CPU time (every thread of this process: the module's included).
async function measured(fn) {
  const c = process.cpuUsage(), t = performance.now();
  const value = await fn();
  const u = process.cpuUsage(c);
  return { value, wallS: (performance.now() - t) / 1000, cpuS: (u.user + u.system) / 1e6 };
}
const canonical = (e) => JSON.stringify(e, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
const keysOf = (e) => [objectKey(e.PRIMARY_ID, e.PRIMARY_NORAD_ID), objectKey(e.SECONDARY_ID, e.SECONDARY_NORAD_ID)];
const digest = (strings) => {
  const hash = createHash('sha256');
  for (const x of [...strings].sort()) hash.update(x).update('\n');
  return hash.digest('hex');
};

// The catalog states: the snapshot, then each batch's newest element set per object.
const encode = await createOmmEncoder();
const base = JSON.parse(fs.readFileSync(o['catalog-json'], 'utf8'));
const t0 = Math.max(...base.map((r) => utcMs(r.CREATION_DATE)));
const bounds = [t0 + 1000, ...o.batches.split(',').map((x) => Date.parse(x))];   // the snapshot holds whole seconds
const rows = new Map(base.map((r, i) => [Number(r.NORAD_CAT_ID), i]));
const records = base.slice();
const states = [{ records: records.slice(), updated: [] }];
const history = recordsCreated(o['gp-history'], bounds[0], bounds.at(-1));
for (let b = 1; b < bounds.length; b++) {
  const newest = new Map();
  for (const r of history) {
    const created = utcMs(r.CREATION_DATE);
    if (created < bounds[b - 1] || created >= bounds[b]) continue;
    const n = Number(r.NORAD_CAT_ID), prior = newest.get(n);
    if (!prior || utcMs(r.EPOCH) >= utcMs(prior.EPOCH)) newest.set(n, r);
  }
  const updated = [];
  for (const [norad, r] of newest) {
    if (!encode(r)) continue;
    let row = rows.get(norad);
    if (row === undefined) { row = records.length; rows.set(norad, row); records.push(r); updated.push(row); continue; }
    if (utcMs(r.EPOCH) < utcMs(records[row].EPOCH) || elementKey(r) === elementKey(records[row])) continue;
    records[row] = r;
    updated.push(row);
  }
  states.push({ records: records.slice(), updated: updated.sort((a, b) => a - b), from: new Date(bounds[b - 1]).toISOString(), to: new Date(bounds[b]).toISOString() });
}
if (o.subsets) {
  const first = states[1], order = first.updated.filter((r) => r < base.length)
    .map((r) => [createHash('sha256').update(`subset:${base[r].NORAD_CAT_ID}`).digest('hex'), r]).sort().map((x) => x[1]);
  states.splice(1);
  for (const k of o.subsets.split(',').map(Number)) {
    const chosen = order.slice(0, k).sort((a, b) => a - b), recs = base.slice();
    for (const r of chosen) recs[r] = first.records[r];
    states.push({ records: recs, updated: chosen, subset: k, from: first.from, to: first.to });
  }
}

// Full screens: the established path, one fresh module instance per catalog state.
async function fullScreen(frames) {
  const harness = await createConjunctionCommandHarness({ runtimeKind: 'browser' });
  try {
    return await measured(() => screenCatalog({ invoke: (m, inputs) => harness.invoke({ methodId: m, inputs }), propagator: 'sgp4',
      catalog: frames, windows, controls }));
  } finally { await harness.destroy?.(); }
}

const harness = await createConjunctionCommandHarness({ runtimeKind: 'browser' });
const invoke = (methodId, inputs) => harness.invoke({ methodId, inputs });
const CATALOG = new PRWInstanceT('conjunction-assessment', 'continuous-catalog', 1n);
const UPDATES = new PRWInstanceT('conjunction-assessment', 'continuous-updates', 1n);
const REFINE = new PRWInstanceT('conjunction-assessment', 'continuous-refine', 1n);
const summary = { catalog: { snapshotCreatedTo: new Date(t0).toISOString(), objects: base.length }, windows: windows.length,
  controls, host: { cpus: os.cpus().length, model: os.cpus()[0]?.model, node: process.version }, batches: [] };
let previous = null, grids = null;
try {
  for (let b = 0; b < states.length; b++) {
    const state = states[b];
    const frames = state.records.map(encode);
    const sources = sgp4Sources(frames);
    const identity = sources.map((s) => objectKey(s.OBJECT_ID, s.NORAD_CATALOG_ID));
    log(`state ${b}: ${frames.length} objects, ${state.updated.length} updated; full screen`);
    const full = await fullScreen(frames);
    const fullEvents = new Map(full.value.events.map((e) => [canonical(e), e]));
    const entry = { batch: b, ...(state.subset ? { subset: state.subset } : {}), from: state.from, to: state.to, objects: frames.length, updated: state.updated.length,
      newObjects: state.updated.filter((r) => r >= (states[b - 1]?.records.length ?? Infinity)).length,
      full: { events: fullEvents.size, candidates: full.value.candidates, excluded: full.value.excluded.length,
        wallS: +full.wallS.toFixed(1), cpuS: +full.cpuS.toFixed(1), eventsSha256: digest(fullEvents.keys()) },
      load1: +os.loadavg()[0].toFixed(1) };
    if (b === 0) {
      // The catalog index: every window's grid from coarse_grid.
      const build = await measured(async () => {
        const handle = await prepareIndex(invoke, sources, [], CATALOG);
        grids = [];
        for (const w of windows) grids.push(await sampleWindowGrid({ invoke, request: windowRequest(handle, 'TEME', w, controls, CATALOG) }));
        await releaseIndex(invoke, handle, CATALOG);
      });
      entry.indexBuild = { wallS: +build.wallS.toFixed(1), cpuS: +build.cpuS.toFixed(1),
        gridMB: +(grids.reduce((s, g) => s + g.blocks.reduce((t, x) => t + x.length, 0), 0) / 1e6).toFixed(0) };
    } else {
      const stages = {};
      const inc = await measured(async () => {
        // 1. The updated objects' rows: coarse_grid on an index of just them, spliced into the kept grid.
        let s = await measured(async () => {
          if (!state.updated.length) return;
          const h = await prepareIndex(invoke, sgp4Sources(state.updated.map((r) => frames[r])), [], UPDATES);
          for (let w = 0; w < windows.length; w++) {
            const part = await sampleWindowGrid({ invoke, request: windowRequest(h, 'TEME', windows[w], controls, UPDATES) });
            spliceGridRows(grids[w], part, state.updated);
          }
          await releaseIndex(invoke, h, UPDATES);
        });
        stages.refreshRows = s;
        // 2. Each window's grid searched with the updated objects as primaries, then refined on an
        //    index of the objects in its candidates.
        const roles = new Uint8Array(frames.length).fill(ROLE.SECONDARY);
        for (const r of state.updated) roles[r] = ROLE.PRIMARY;
        const events = [], timings = { searchMs: 0, refineMs: 0 };
        let candidates = 0;
        s = await measured(async () => {
          for (let w = 0; w < windows.length; w++) {
            const refineIndex = async (rows) => {
              const h = await prepareIndex(invoke, rows.map((r) => sources[r]), [], REFINE);
              return { request: windowRequest(h, 'TEME', windows[w], controls, REFINE), release: () => releaseIndex(invoke, h, REFINE) };
            };
            const run = await screenStoredWindow({ invoke, decodeCatalogResult, request: windowRequest(0, 'TEME', windows[w], controls, REFINE),
              grid: grids[w], roles, refineIndex });
            events.push(...run.events);
            candidates += run.candidates;
            timings.searchMs += run.timings.searchMs;
            timings.refineMs += run.timings.refineMs;
          }
        });
        stages.screen = { ...s, searchS: timings.searchMs / 1000, refineS: timings.refineMs / 1000 };
        const cutoffs = new Map();
        for (const g of grids) for (const [row, jd] of g.excluded) refuseAt(cutoffs, identity[row], jd);
        return { events: mergeWindowEvents(events, cutoffs), candidates };
      });
      const updatedKeys = new Set(state.updated.map((r) => identity[r]));
      const touches = (e) => keysOf(e).some((k) => updatedKeys.has(k));
      const incEvents = new Set(inc.value.events.map(canonical));
      const expected = new Set([...fullEvents].filter(([, e]) => touches(e)).map(([k]) => k));
      const merged = new Set([...previous].filter(([, e]) => !touches(e)).map(([k]) => k));
      for (const k of incEvents) merged.add(k);
      const same = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
      entry.incremental = { events: incEvents.size, candidates: inc.value.candidates, wallS: +inc.wallS.toFixed(1), cpuS: +inc.cpuS.toFixed(1),
        stages: Object.fromEntries(Object.entries(stages).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).filter(([n]) => n !== 'value')
          .map(([n, x]) => [n, +x.toFixed(2)]))])),
        eventsSha256: digest(incEvents) };
      entry.pairFraction = +(1 - (1 - state.updated.length / frames.length) ** 2).toFixed(4);
      entry.equal = { affectedPairs: same(incEvents, expected), affectedEventsInFull: expected.size,
        previousWithReplacedPairs: same(merged, new Set(fullEvents.keys())) };
      entry.speedup = { wall: +(full.wallS / inc.wallS).toFixed(1), cpu: +(full.cpuS / inc.cpuS).toFixed(1) };
      log(`state ${b}: incremental ${incEvents.size} events in ${inc.wallS.toFixed(1)} s (full ${full.wallS.toFixed(1)} s); equal ${JSON.stringify(entry.equal)}`);
    }
    summary.batches.push(entry);
    fs.writeFileSync(o.out, JSON.stringify(summary, null, 1) + '\n');
    if (o.subsets && b > 0) {
      // Back to the snapshot: the same objects' snapshot rows spliced in again.
      const baseFrames = states[0].records.map(encode);
      const h = await prepareIndex(invoke, sgp4Sources(state.updated.map((r) => baseFrames[r])), [], UPDATES);
      for (let w = 0; w < windows.length; w++) {
        spliceGridRows(grids[w], await sampleWindowGrid({ invoke, request: windowRequest(h, 'TEME', windows[w], controls, UPDATES) }), state.updated);
      }
      await releaseIndex(invoke, h, UPDATES);
    } else previous = fullEvents;
  }
} finally {
  await harness.destroy?.();
}
console.log(JSON.stringify(summary.batches.map((x) => ({ batch: x.batch, updated: x.updated, full: x.full.wallS, inc: x.incremental?.wallS, equal: x.equal }))));

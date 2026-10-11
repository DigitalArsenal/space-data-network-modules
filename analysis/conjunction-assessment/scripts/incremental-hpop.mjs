#!/usr/bin/env node
// Incremental screening with full-force HPOP trajectories, on real update
// batches. With a numerical propagator the cost of a screen is propagation,
// so the incremental screen propagates only the objects whose element sets
// changed and keeps every other object's trajectory: HPOP is deterministic,
// so propagating an unchanged element set again gives the same bytes (checked
// here on a sample). For a catalog subset (every updated object plus a stride
// sample of LEO objects), it runs
//   full:        HPOP for every object, then the established windowed screen
//                (search_candidates, refine_candidates) on its trajectories;
//   incremental: HPOP for the updated objects only, their rows spliced into
//                the kept grid, search_grid with them as primaries,
//                refine_candidates on an index of the objects in candidates;
// and checks the incremental events against the full re-screen as
// incremental-screen.mjs does. Writes aggregates only.
//
// usage: node scripts/incremental-hpop.mjs --catalog-json <gp.json> --gp-history <by-creation dir> --batches <ISO,...>
//          --hpop-environment <dir> [--base-to <ISO>] [--objects 2000] [--start 2461314.5] [--hours 6] [--threshold-km 5]
// --base-to: element sets created before it join the snapshot first (no incremental step); the batches follow.
// --sample-updates k: keep k of each batch's updated objects (a fixed pseudo-random sample).
// --band lo,hi: the LEO stride sample's perigee band, km (default 300,700).
//          [--farm-workers 5] [--workers 6] [--load-ceiling 45] [--determinism-sample 50] --out <summary.json>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as flatbuffers from 'flatbuffers';
import { PRW } from 'spacedatastandards.org/lib/js/PRW/main.js';
import { CQRObjectSourceT, PRWInstanceT } from 'spacedatastandards.org/lib/js/CQR/main.js';
import { createConjunctionCommandHarness } from '../tests/lib/conjunctionCommandHarness.mjs';
import { decodeCatalogResult, prepareIndex, releaseIndex, screenWindows, windowRequest } from '../gpu/catalogScreen.mjs';
import { mergeWindowEvents, objectKey, screenWindowsOnGpu } from '../gpu/allVsAll.mjs';
import { ROLE, sampleWindowGrid, screenStoredWindow, spliceGridRows } from '../gpu/continuousScreen.mjs';
import { createHpopFarm } from './lib/hpopFarm.mjs';
import { createOmmEncoder } from './lib/ommCatalog.mjs';
import { elementKey, recordsCreated, utcMs } from './lib/gpHistory.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: o } = parseArgs({ options: {
  'catalog-json': { type: 'string' }, 'gp-history': { type: 'string' }, batches: { type: 'string' }, 'hpop-environment': { type: 'string' }, 'base-to': { type: 'string' },
  objects: { type: 'string', default: '2000' }, start: { type: 'string', default: '2461314.5' }, hours: { type: 'string', default: '6' },
  'threshold-km': { type: 'string', default: '5' }, 'farm-workers': { type: 'string', default: '5' }, workers: { type: 'string', default: '6' },
  'load-ceiling': { type: 'string', default: '45' }, 'determinism-sample': { type: 'string', default: '50' }, out: { type: 'string' },
  'sample-updates': { type: 'string' }, band: { type: 'string', default: '300,700' },
} });
if (!o['catalog-json'] || !o['gp-history'] || !o.batches || !o['hpop-environment'] || !o.out) throw new Error('missing arguments; see usage');
const log = (m) => console.error(`${new Date().toISOString().slice(11, 19)} ${m}`);
const canonical = (e) => JSON.stringify(e, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
const keysOf = (e) => [objectKey(e.PRIMARY_ID, e.PRIMARY_NORAD_ID), objectKey(e.SECONDARY_ID, e.SECONDARY_NORAD_ID)];
const same = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
const windows = screenWindows(Number(o.start), Number(o.hours) / 24, 1);
const MARGIN = 2 / 1440;   // HPOP returns whole intervals; this covers TDB - UTC (as the CPU runner)
const controls = { thresholdKm: Number(o['threshold-km']), coarseStepSec: 60, workers: Number(o.workers), algorithm: 'ALFANO_MAXIMUM' };
const encode = await createOmmEncoder();

// The subset: every object a batch updates, then LEO objects (perigee 300-700 km) by stride, in catalog order.
const snapshot = JSON.parse(fs.readFileSync(o['catalog-json'], 'utf8'));
const t0 = Math.max(...snapshot.map((r) => utcMs(r.CREATION_DATE)));
const baseTo = o['base-to'] ? Date.parse(o['base-to']) : t0 + 1000;
const bounds = [baseTo, ...o.batches.split(',').map((x) => Date.parse(x))];
const history = recordsCreated(o['gp-history'], t0 + 1000, bounds.at(-1));
// The base: the snapshot with every newer element set created before baseTo (newest epoch per object).
const baseMap = new Map(snapshot.map((r) => [Number(r.NORAD_CAT_ID), r]));
for (const r of history) {
  if (utcMs(r.CREATION_DATE) >= baseTo) continue;
  const prior = baseMap.get(Number(r.NORAD_CAT_ID));
  if (prior && utcMs(r.EPOCH) >= utcMs(prior.EPOCH)) baseMap.set(Number(r.NORAD_CAT_ID), r);
}
const base = snapshot.map((r) => baseMap.get(Number(r.NORAD_CAT_ID)));
const batches = [];
for (let b = 1; b < bounds.length; b++) {
  const newest = new Map();
  for (const r of history) {
    const c = utcMs(r.CREATION_DATE);
    if (c < bounds[b - 1] || c >= bounds[b]) continue;
    const prior = newest.get(Number(r.NORAD_CAT_ID));
    if (!prior || utcMs(r.EPOCH) >= utcMs(prior.EPOCH)) newest.set(Number(r.NORAD_CAT_ID), r);
  }
  if (o['sample-updates']) {
    const keep = new Set([...newest.keys()].map((n) => [createHash('sha256').update(`hpop-sample:${n}`).digest('hex'), n]).sort()
      .slice(0, Number(o['sample-updates'])).map((x) => x[1]));
    for (const n of [...newest.keys()]) if (!keep.has(n)) newest.delete(n);
  }
  batches.push(newest);
}
const byNorad = new Map(base.map((r) => [Number(r.NORAD_CAT_ID), r]));
const updatedNorads = new Set(batches.flatMap((m) => [...m.keys()].filter((n) => byNorad.has(n))));
const [bandLo, bandHi] = o.band.split(',').map(Number);
const leo = base.filter((r) => Number(r.PERIAPSIS) >= bandLo && Number(r.PERIAPSIS) <= bandHi && !updatedNorads.has(Number(r.NORAD_CAT_ID)));
const stride = Math.max(1, Math.floor(leo.length / (Number(o.objects) - updatedNorads.size)));
const chosen = new Set([...updatedNorads, ...leo.filter((_, i) => i % stride === 0).map((r) => Number(r.NORAD_CAT_ID))]);
const subset = base.filter((r) => chosen.has(Number(r.NORAD_CAT_ID)));
const rowOf = new Map(subset.map((r, i) => [Number(r.NORAD_CAT_ID), i]));
log(`subset: ${subset.length} objects (${updatedNorads.size} updated in some batch), ${windows.length} windows of 1 h`);

const environment = o['hpop-environment'];
// HPOP over the screen for these element sets: per window, each object's $PRW record (or a drop).
// rows: each record's subset row (its source handle is row + 1); frames are keyed by row.
async function propagate(records, rows = records.map((_, i) => i)) {
  const farm = await createHpopFarm({ catalog: records.map(encode), modulesRoot: path.resolve(root, '../..'), workers: Number(o['farm-workers']),
    profile: 'full-force', environment, screenStartJd: Number(o.start), loadCeiling: Number(o['load-ceiling']), handles: rows.map((r) => r + 1) });
  try {
    const out = [];
    for (const w of windows) out.push(await farm.window(w.startJd - MARGIN, w.durationDays + 2 * MARGIN));
    const handleOf = (frame) => PRW.getSizePrefixedRootAsPRW(new flatbuffers.ByteBuffer(frame)).DESCRIBE_RESULT().SOURCES(0).SOURCE_HANDLE();
    return { cpuS: farm.cpu.ingestS + farm.cpu.windows.reduce((s, w) => s + w.cpuS, 0), excluded: farm.excluded,
      windows: out.map((x) => ({ frames: new Map(x.frames.map((f) => [handleOf(f) - 1, f])), dropped: x.dropped })) };
  } finally { await farm.close(); }
}

const harness = await createConjunctionCommandHarness({ runtimeKind: 'browser' });
const invoke = (methodId, inputs) => harness.invoke({ methodId, inputs });
const INST = new PRWInstanceT('conjunction-assessment', 'continuous-hpop', 1n);
const identity = (records) => records.map((r, i) => new CQRObjectSourceT(r.OBJECT_ID || String(r.NORAD_CAT_ID), r.OBJECT_NAME, Number(r.NORAD_CAT_ID), null, i + 1));
const keyOf = (r) => objectKey(r.OBJECT_ID || String(r.NORAD_CAT_ID), Number(r.NORAD_CAT_ID));
// An index of the given rows' trajectories for window w (rows in order; handles from the full row numbers).
async function indexOf(records, perWindow, w, rows) {
  const sources = identity(records), frames = [];
  const kept = rows.filter((r) => perWindow[w].frames.has(r));
  for (const r of kept) frames.push(perWindow[w].frames.get(r));
  return { kept, handle: await prepareIndex(invoke, kept.map((r) => sources[r]), frames, INST) };
}
const dropKeys = (records, perWindow) => new Set(perWindow.flatMap((x) => x.dropped.map((d) => keyOf(records[d.handle - 1]))));
// A grid of n non-finite rows with the blocks of `like` (a window's coarse_grid output).
function emptyGrid(like, n) {
  return { excluded: new Map(), objects: n, blocks: like.blocks.map((b) => {
    const v = new DataView(b.buffer, b.byteOffset), count = v.getUint32(8, true);
    const out = new Uint8Array(16 + count * n * 32 + n * 8);
    new Float32Array(out.buffer, 16).fill(Number.NaN);
    out.set(b.subarray(0, 12));
    new DataView(out.buffer).setUint32(12, n, true);
    return out;
  }) };
}
// A trajectory record's polynomial ephemeris, canonical (its instance id names the farm instance, not the orbit).
const trajectoryOf = (frame) => JSON.stringify(PRW.getSizePrefixedRootAsPRW(new flatbuffers.ByteBuffer(frame)).DESCRIBE_RESULT().SOURCES(0).unpack().EPHEMERIS,
  (k, v) => (typeof v === 'bigint' ? v.toString() : v));

// The full screen of a catalog state on its trajectories: the established path.
async function fullScreen(records, traj) {
  const t = performance.now(), c = process.cpuUsage();
  const result = await screenWindowsOnGpu({ invoke, decodeCatalogResult, windows, thresholdKm: controls.thresholdKm, coarseStepSec: 60,
    prepareWindow: async (w, k) => {
      const all = records.map((_, i) => i);
      const { kept, handle } = await indexOf(records, traj.windows, k, all);
      return { request: windowRequest(handle, 'GCRF', w, controls, INST), objects: kept.map((r) => [records[r].OBJECT_ID || String(records[r].NORAD_CAT_ID), Number(records[r].NORAD_CAT_ID)]),
        excluded: traj.windows[k].dropped.map((d) => [records[d.handle - 1].OBJECT_ID || String(records[d.handle - 1].NORAD_CAT_ID), Number(records[d.handle - 1].NORAD_CAT_ID), w.startJd]),
        release: () => releaseIndex(invoke, handle, INST) };
    } });
  const u = process.cpuUsage(c);
  return { events: new Map(result.events.map((e) => [canonical(e), e])), wallS: (performance.now() - t) / 1000, cpuS: (u.user + u.system) / 1e6, candidates: result.candidates };
}

const summary = { subset: subset.length, windows: windows.length, hoursFrom: new Date((Number(o.start) - 2440587.5) * 86400e3).toISOString(), controls,
  host: { cpus: os.cpus().length, model: os.cpus()[0]?.model }, farmWorkers: Number(o['farm-workers']), batches: [] };
try {
  log('full propagation of the subset');
  let records = subset.slice();
  const traj = await propagate(records);
  summary.fullPropagation = { objects: records.length, cpuS: +traj.cpuS.toFixed(1), perObjectS: +(traj.cpuS / records.length).toFixed(3) };
  log(`propagated ${records.length} objects: ${traj.cpuS.toFixed(0)} CPU-s`);
  let full = await fullScreen(records, traj);
  summary.base = { events: full.events.size, candidates: full.candidates, wallS: +full.wallS.toFixed(1), cpuS: +full.cpuS.toFixed(1) };
  // The kept grids: coarse_grid on each window's index of every trajectory.
  const grids = [];
  for (const [w, win] of windows.entries()) {
    const { kept, handle } = await indexOf(records, traj.windows, w, records.map((_, i) => i));
    const g = await sampleWindowGrid({ invoke, request: windowRequest(handle, 'GCRF', win, controls, INST) });
    await releaseIndex(invoke, handle, INST);
    // Grid rows are the subset's rows: objects HPOP could not cover in this window stay non-finite.
    grids.push(spliceGridRows(emptyGrid(g, records.length), g, kept));
  }
  // HPOP is deterministic: unchanged element sets propagated again give the same records.
  const sample = records.map((_, i) => i).filter((i) => !updatedNorads.has(Number(records[i].NORAD_CAT_ID))).slice(0, Number(o['determinism-sample']));
  const again = await propagate(sample.map((i) => records[i]), sample);
  let identical = 0, compared = 0;
  for (const [w] of windows.entries()) for (const i of sample) {
    const a = traj.windows[w].frames.get(i), b = again.windows[w].frames.get(i);
    if (a && b) { compared++; if (trajectoryOf(a) === trajectoryOf(b)) identical++; }
  }
  summary.determinism = { objects: sample.length, recordsCompared: compared, identical };
  log(`determinism: ${identical} of ${compared} records identical`);

  for (const [bi, newest] of batches.entries()) {
    const next = records.slice(), updated = [];
    for (const [n, r] of newest) {
      const row = rowOf.get(n);
      if (row === undefined || !encode(r) || utcMs(r.EPOCH) < utcMs(next[row].EPOCH) || elementKey(r) === elementKey(next[row])) continue;
      next[row] = r;
      updated.push(row);
    }
    updated.sort((a, b) => a - b);
    // Incremental: HPOP for the updated objects only; their rows spliced in; search_grid; refinement.
    const t = performance.now(), c = process.cpuUsage();
    const part = await propagate(updated.map((r) => next[r]), updated);
    const nextTraj = { windows: traj.windows.map((x, w) => ({ frames: new Map(x.frames), dropped: x.dropped.filter((d) => !updated.includes(d.handle - 1)) })) };
    for (const [w] of windows.entries()) {
      for (const r of updated) nextTraj.windows[w].frames.delete(r);
      for (const [r, f] of part.windows[w].frames) nextTraj.windows[w].frames.set(r, f);
      nextTraj.windows[w].dropped.push(...part.windows[w].dropped);
    }
    const events = [];
    for (const [w, win] of windows.entries()) {
      const { kept, handle } = await indexOf(next, nextTraj.windows, w, updated);
      const rowsGrid = await sampleWindowGrid({ invoke, request: windowRequest(handle, 'GCRF', win, controls, INST) });
      await releaseIndex(invoke, handle, INST);
      spliceGridRows(grids[w], rowsGrid, kept);
      const roles = new Uint8Array(next.length);
      for (const r of updated) roles[r] = ROLE.PRIMARY;
      const run = await screenStoredWindow({ invoke, decodeCatalogResult, grid: grids[w], roles, request: windowRequest(0, 'GCRF', win, controls, INST),
        refineIndex: async (rows) => {
          const ix = await indexOf(next, nextTraj.windows, w, rows);
          if (ix.kept.length !== rows.length) throw new Error('a candidate row has no trajectory');
          return { request: windowRequest(ix.handle, 'GCRF', win, controls, INST), release: () => releaseIndex(invoke, ix.handle, INST) };
        } });
      events.push(...run.events);
    }
    const excludedKeys = dropKeys(next, nextTraj.windows);
    for (const g of grids) for (const row of g.excluded.keys()) excludedKeys.add(keyOf(next[row]));
    const inc = mergeWindowEvents(events, excludedKeys);
    const u = process.cpuUsage(c), incWall = (performance.now() - t) / 1000;
    // The full re-screen of the updated catalog (unchanged objects' trajectories kept: see determinism).
    const fullNext = await fullScreen(next, nextTraj);
    const updatedKeys = new Set(updated.map((r) => keyOf(next[r])));
    const touches = (e) => keysOf(e).some((k) => updatedKeys.has(k));
    const incSet = new Set(inc.map(canonical));
    const expected = new Set([...fullNext.events].filter(([, e]) => touches(e)).map(([k]) => k));
    const merged = new Set([...full.events].filter(([, e]) => !touches(e)).map(([k]) => k));
    for (const k of incSet) merged.add(k);
    summary.batches.push({ batch: bi + 1, from: new Date(bounds[bi]).toISOString(), to: new Date(bounds[bi + 1]).toISOString(), updated: updated.length,
      propagationCpuS: { incremental: +part.cpuS.toFixed(1), full: +traj.cpuS.toFixed(1) },
      incremental: { events: incSet.size, wallS: +incWall.toFixed(1), processCpuS: +((u.user + u.system) / 1e6).toFixed(1) },
      full: { events: fullNext.events.size, screenWallS: +fullNext.wallS.toFixed(1) },
      equal: { affectedPairs: same(incSet, expected), affectedEventsInFull: expected.size, previousWithReplacedPairs: same(merged, new Set(fullNext.events.keys())) } });
    log(`batch ${bi + 1}: ${updated.length} updated; propagation ${part.cpuS.toFixed(0)} vs ${traj.cpuS.toFixed(0)} CPU-s; equal ${JSON.stringify(summary.batches.at(-1).equal)}`);
    fs.writeFileSync(o.out, JSON.stringify(summary, null, 1) + '\n');
    records = next; full = fullNext;
    for (const [w] of windows.entries()) { traj.windows[w] = nextTraj.windows[w]; }
  }
} finally {
  await harness.destroy?.();
}
fs.writeFileSync(o.out, JSON.stringify(summary, null, 1) + '\n');
console.log(JSON.stringify(summary));
process.exit(0);

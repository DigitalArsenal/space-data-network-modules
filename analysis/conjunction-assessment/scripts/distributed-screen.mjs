#!/usr/bin/env node
// A distributed screen on one machine. Worker processes act as independent
// volunteers: each declares its capability (module threads, memory, runtime),
// holds its own key, and runs the units it is given through its own module
// instance (gpu/workUnits.mjs). The coordinator only plans units, schedules
// them by capability, moves and hashes bytes, and checks signatures:
//   1. grid units (row blocks x windows) build each window's coarse grid;
//   2. screen units (blocks of primaries x windows) screen it, every pair once.
// A keyed fraction of units runs on two workers (a different runtime where
// one is free); outputs must match byte for byte, a mismatch goes to a third
// worker, the minority worker is marked faulty and every unit it alone
// answered runs again elsewhere. A unit unanswered by its deadline goes to
// another worker; two such drops retire a worker. The merged events are
// compared with the single-process screen of the same catalog. Writes
// aggregates only.
//
// usage: node scripts/distributed-screen.mjs --catalog <omm.uint32be.bin> --store <dir> --out <summary.json>
//          [--start 2461314.5] [--days 3] [--window-hours 6] [--threshold-km 5] [--step-s 60]
//          [--row-blocks 4] [--object-blocks 4] [--replication 0.3] [--secret <text>]
//          [--workers node:2:4096,node:1:768,wasmedge-aot:1:4096,node:1:4096:cheat=0.5,node:1:4096:drop=0.3]
//          [--aotc <path> --aot-runner <path>]   (WasmEdge AOT workers, SDN's patched WasmEdge)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createConjunctionCommandHarness } from '../tests/lib/conjunctionCommandHarness.mjs';
import { screenCatalog, screenWindows, sgp4Sources, splitCatalog } from '../gpu/catalogScreen.mjs';
import { mergeWindowEvents, objectKey } from '../gpu/allVsAll.mjs';
import { cutBlocks, rolesFrame, unitRoles } from '../gpu/continuousScreen.mjs';
import { assembleWindowGrid, exclusionsBytes, unitEvents, unitId } from '../gpu/workUnits.mjs';
import { aotModule } from './lib/aot.mjs';
import { openStore } from './lib/contentStore.mjs';
import { signedByWorker, spawnWorker, stopWorker } from './lib/workerProcess.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: o } = parseArgs({ options: {
  catalog: { type: 'string' }, store: { type: 'string' }, out: { type: 'string' },
  start: { type: 'string', default: '2461314.5' }, days: { type: 'string', default: '3' }, 'window-hours': { type: 'string', default: '6' },
  'threshold-km': { type: 'string', default: '5' }, 'step-s': { type: 'string', default: '60' },
  'row-blocks': { type: 'string', default: '4' }, 'object-blocks': { type: 'string', default: '4' },
  replication: { type: 'string', default: '0.3' }, secret: { type: 'string', default: 'distributed-screen-20261011' },
  workers: { type: 'string', default: 'node:2:4096,node:1:768,node:1:4096,node:1:4096:cheat=0.5,node:1:4096:drop=0.3' },
  aotc: { type: 'string' }, 'aot-runner': { type: 'string' },
} });
if (!o.catalog || !o.store || !o.out) throw new Error('--catalog, --store and --out are required.');
const log = (m) => console.error(`${new Date().toISOString().slice(11, 19)} ${m}`);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const canonical = (e) => JSON.stringify(e, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
const digest = (strings) => { const h = createHash('sha256'); for (const x of [...strings].sort()) h.update(x).update('\n'); return h.digest('hex'); };

const store = openStore(o.store);
const modulePath = path.join(root, 'dist/isomorphic/module.wasm');
const moduleSha = sha(fs.readFileSync(modulePath));
const catalogBytes = new Uint8Array(fs.readFileSync(o.catalog));
const frames = splitCatalog(catalogBytes), objects = frames.length;
const sourcesHash = store.put(catalogBytes);
const windows = screenWindows(Number(o.start), Number(o.days), Number(o['window-hours']));
const controls = { thresholdKm: Number(o['threshold-km']), coarseStepSec: Number(o['step-s']), algorithm: 'ALFANO_MAXIMUM' };
const identity = sgp4Sources(frames).map((s) => objectKey(s.OBJECT_ID, s.NORAD_CATALOG_ID));

// The single-process screen of the same catalog, before any worker starts.
log('reference: single-process screen');
let reference;
{
  const h = await createConjunctionCommandHarness({ runtimeKind: 'browser' });
  const t = performance.now();
  const run = await screenCatalog({ invoke: (m, i) => h.invoke({ methodId: m, inputs: i }), propagator: 'sgp4', catalog: frames, windows,
    controls: { ...controls, workers: 6 } });
  reference = { events: run.events.length, sha256: digest(run.events.map(canonical)), wallS: +((performance.now() - t) / 1000).toFixed(1) };
  await h.destroy?.();
}
log(`reference: ${reference.events} events`);

// Workers: runtime:threads:memoryMiB[:behaviour].
const aot = o['workers'].includes('wasmedge-aot') ? aotModule(modulePath, o.aotc, []) : null;
const workers = await Promise.all(o.workers.split(',').map(async (spec, i) => {
  const [runtime, threads, memoryMiB, behaviour = 'honest'] = spec.split(':');
  const w = await spawnWorker({ id: `w${i + 1}`, runtime, threads: Number(threads), memoryMiB: Number(memoryMiB), behaviour, storeDir: o.store,
    modulePath, aotModule: aot, aotRunner: o['aot-runner'] });
  return Object.assign(w, { busy: null, faulty: false, retired: false, drops: 0, units: { grid: 0, screen: 0 }, cpuS: 0, wallS: 0 });
}));
log(`workers: ${workers.map((w) => `${w.id} ${w.runtime} ${w.threads} threads ${w.memoryMiB} MiB ${w.behaviour}`).join('; ')}`);

// Units, replication and verification.
const replicated = (id) => parseInt(createHmac('sha256', o.secret).update(id).digest('hex').slice(0, 12), 16) / 2 ** 48 < Number(o.replication);
const stats = { units: 0, replicated: 0, matches: 0, mismatches: 0, thirdRuns: 0, faulty: [], reruns: 0, timeouts: 0, retired: [], badSignatures: 0 };
async function runAll(units) {
  const state = new Map(units.map((u) => [u.id, { ...u, results: [], history: [], running: new Set(), accepted: null }]));
  const byId = (id) => workers.find((w) => w.id === id);
  stats.units += units.length;
  for (const s of state.values()) if (replicated(s.id)) stats.replicated++;
  const queue = [], median = { grid: [], screen: [] };
  // Accepted when the results of trusted workers agree and number at least the unit's replication
  // (2 or 1). A disagreement asks for one more run; a strict majority of three or more decides, and
  // the minority is marked faulty. Otherwise the runs still missing are queued.
  const evaluate = (s) => {
    s.results = s.results.filter((r) => !byId(r.worker).faulty);
    const counts = new Map();
    for (const r of s.results) counts.set(r.hash, (counts.get(r.hash) ?? 0) + 1);
    const need = replicated(s.id) ? 2 : 1;
    if (counts.size === 1 && s.results.length >= need) {
      if (!s.accepted && need === 2) stats.matches++;
      s.accepted = s.results[0];
      return;
    }
    if (counts.size > 1) {
      const [hash, n] = [...counts].sort((a, b) => b[1] - a[1])[0];
      if (s.results.length >= 3 && 2 * n > s.results.length) {
        s.accepted = s.results.find((r) => r.hash === hash);
        for (const r of s.results.filter((x) => x.hash !== hash)) markFaulty(byId(r.worker));
        return;
      }
      if (!s.disputed) { s.disputed = true; stats.mismatches++; }
    }
    if (s.accepted) stats.reruns++;
    s.accepted = null;
    const wanted = counts.size > 1 ? s.results.length + 1 : need;
    const pending = s.running.size + queue.filter((id) => id === s.id).length;
    for (let i = s.results.length + pending; i < wanted; i++) { if (counts.size > 1) stats.thirdRuns++; queue.push(s.id); }
  };
  const markFaulty = (w) => {
    if (w.faulty) return;
    w.faulty = true;
    stats.faulty.push(w.id);
    log(`${w.id} is faulty: its answers no longer count, and units that relied on them run again`);
    for (const s of state.values()) evaluate(s);
  };
  for (const s of state.values()) evaluate(s);
  let status;
  return new Promise((resolve) => {
    const done = () => [...state.values()].every((s) => s.accepted) && workers.every((w) => !w.busy);
    const dispatch = () => {
      for (const w of workers) {
        if (w.busy || w.faulty || w.retired) continue;
        const at = queue.findIndex((id) => {
          const s = state.get(id);
          if (s.accepted || s.memoryMiB > w.memoryMiB || s.results.some((r) => r.worker === w.id) || s.running.has(w.id)) return false;
          // A second replica goes to another runtime when one is free.
          const other = s.results[0]?.worker ?? [...s.running][0];
          const otherRuntime = other && byId(other).runtime;
          return !otherRuntime || otherRuntime !== w.runtime ||
            !workers.some((x) => !x.busy && !x.faulty && !x.retired && x.runtime !== otherRuntime && x.memoryMiB >= s.memoryMiB);
        });
        if (at < 0) continue;
        const id = queue.splice(at, 1)[0], s = state.get(id);
        s.running.add(w.id);
        // The deadline: six times the unit's estimated time on this worker, or four times the median so far.
        const observed = median[s.kind].length ? median[s.kind].sort((a, b) => a - b)[median[s.kind].length >> 1] : 0;
        const deadlineS = Math.max(20, 6 * s.estimateS / w.threads, 4 * observed);
        w.busy = { id, timer: setTimeout(() => {   // unanswered: another worker takes it
          stats.timeouts++; w.drops++; s.running.delete(w.id); w.busy = null;
          log(`${w.id} left ${s.kind} unit ${id.slice(0, 8)} unanswered after ${deadlineS.toFixed(0)} s`);
          if (w.drops >= 2 && !w.retired) { w.retired = true; stats.retired.push(w.id); log(`${w.id} retired after ${w.drops} unanswered units`); }
          evaluate(s);
          dispatch();
        }, deadlineS * 1000) };
        w.child.send({ type: 'unit', record: s.record, unitId: id });
      }
      if (done()) resolve(state);
    };
    for (const w of workers) {
      w.child.removeAllListeners('message');
      w.child.on('message', (m) => {
        if (!w.busy || w.busy.id !== m.unitId) return;   // a late answer to a reassigned unit
        clearTimeout(w.busy.timer);
        const s = state.get(m.unitId);
        w.busy = null;
        s.running.delete(w.id);
        if (m.type === 'error') { log(`${w.id} ${m.unitId.slice(0, 8)}: ${m.message.split('\n')[0]}`); evaluate(s); return dispatch(); }
        // The PNM: signed by the worker's key, naming this unit and the output's CID.
        if (!signedByWorker(w, m.unitId, m, store)) { stats.badSignatures++; evaluate(s); return dispatch(); }
        log(`${w.id} ${s.kind} unit ${m.unitId.slice(0, 8)} -> ${m.hash.slice(0, 8)} in ${m.wallS.toFixed(1)} s`);
        w.units[s.kind]++; w.cpuS += m.cpuS; w.wallS += m.wallS;
        median[s.kind].push(m.wallS);
        s.history.push({ worker: w.id, hash: m.hash });
        if (!w.faulty && !s.accepted) s.results.push({ worker: w.id, hash: m.hash });
        evaluate(s);
        dispatch();
      });
    }
    status = setInterval(() => {
      const pending = [...state.values()].filter((x) => !x.accepted);
      log(`waiting: ${pending.length} units (${pending.map((x) => `${x.id.slice(0, 8)} ${x.results.length}+${x.running.size}`).join(', ')}); ` +
        `queue ${queue.length}; busy ${workers.filter((w) => w.busy).map((w) => `${w.id}:${w.busy.id.slice(0, 8)}`).join(', ')}`);
    }, 30000);
    dispatch();
  }).finally(() => clearInterval(status));
}

// 1. Grid units: row blocks x windows; a window's grid is the rows spliced in order.
const t0 = performance.now();
const rowBlocks = cutBlocks(Array.from({ length: objects }, (_, i) => i), Math.ceil(objects / Number(o['row-blocks'])));
const stepsPerWindow = Math.round(Number(o['window-hours']) * 3600 / controls.coarseStepSec) + 1;
const gridUnits = [];
for (const [w, win] of windows.entries()) {
  for (const rows of rowBlocks) {
    const record = { kind: 'ca.grid/1', module: moduleSha, sources: sourcesHash, window: { startJd: win.startJd, durationDays: win.durationDays },
      controls, rows: [rows[0], rows.length], blockSteps: 32 };
    gridUnits.push({ id: await unitId(record), record, kind: 'grid', window: w, rows, memoryMiB: Math.ceil((rows.length * stepsPerWindow * 32 * 2) / 2 ** 20) + 256,
      estimateS: rows.length * stepsPerWindow * 2e-6 });
  }
}
log(`grid units: ${gridUnits.length}`);
const gridState = await runAll(gridUnits);
const windowGrids = [];
for (const [w] of windows.entries()) {
  const grid = assembleWindowGrid(await Promise.all(gridUnits.filter((x) => x.window === w)
    .map(async (u) => ({ output: await store.get(gridState.get(u.id).accepted.hash), rows: u.rows }))));
  windowGrids.push({ blocks: grid.blocks.map((b) => store.put(b)), excluded: store.put(exclusionsBytes(grid.excluded)), excludedRows: [...grid.excluded.keys()],
    megabytes: grid.blocks.reduce((s, b) => s + b.length, 0) / 1e6 });
}
const gridS = (performance.now() - t0) / 1000;
log(`grids: ${windowGrids.length} windows, ${windowGrids.reduce((s, g) => s + g.megabytes, 0).toFixed(0)} MB, ${gridS.toFixed(1)} s`);

// 2. Screen units: blocks of primaries x windows (every pair in exactly one unit).
const t1 = performance.now();
const primaryBlocks = cutBlocks(Array.from({ length: objects }, (_, i) => i), Math.ceil(objects / Number(o['object-blocks'])));
const screenUnits = [];
for (const [b] of primaryBlocks.entries()) {
  const roles = store.put(rolesFrame(unitRoles(objects, primaryBlocks, b)));
  for (const [w, win] of windows.entries()) {
    const record = { kind: 'ca.screen/1', module: moduleSha, sources: sourcesHash, window: { startJd: win.startJd, durationDays: win.durationDays },
      controls, grid: windowGrids[w].blocks, excluded: windowGrids[w].excluded, roles };
    screenUnits.push({ id: await unitId(record), record, kind: 'screen', window: w, memoryMiB: Math.ceil(windowGrids[w].megabytes * 1.6) + 256,
      estimateS: objects * stepsPerWindow * 0.5e-6 + 5 });
  }
}
log(`screen units: ${screenUnits.length}`);
const screenState = await runAll(screenUnits);
const events = [];
for (const u of screenUnits) events.push(...unitEvents(await store.get(screenState.get(u.id).accepted.hash)));
const excludedKeys = new Set(windowGrids.flatMap((g) => g.excludedRows.map((r) => identity[r])));
const merged = mergeWindowEvents(events, excludedKeys);
const screenS = (performance.now() - t1) / 1000;
for (const w of workers) stopWorker(w);

// Replicas compared byte for byte among trusted workers, and how many crossed runtimes.
const replicas = { compared: 0, identical: 0, crossRuntime: 0 };
for (const st of [gridState, screenState]) for (const s of st.values()) {
  const trusted = s.history.filter((h) => !workers.find((w) => w.id === h.worker).faulty);
  for (let i = 0; i < trusted.length; i++) for (let j = i + 1; j < trusted.length; j++) {
    replicas.compared++;
    if (trusted[i].hash === trusted[j].hash) replicas.identical++;
    if (workers.find((w) => w.id === trusted[i].worker).runtime !== workers.find((w) => w.id === trusted[j].worker).runtime) replicas.crossRuntime++;
  }
}
// Outputs that differ from the accepted one, by worker: what replication had to catch.
const wrong = {};
for (const st of [gridState, screenState]) for (const s of st.values()) for (const h of s.history ?? []) {
  if (h.hash !== s.accepted.hash) (wrong[h.worker] ??= { outputs: 0, units: [] }).outputs++, wrong[h.worker].units.push(s.id.slice(0, 12));
}
const result = {
  catalog: { objects, sourcesSha256: sourcesHash }, module: moduleSha, windows: windows.length, controls,
  host: { cpus: os.cpus().length, model: os.cpus()[0]?.model, load1AtEnd: +os.loadavg()[0].toFixed(1) },
  plan: { rowBlocks: rowBlocks.length, objectBlocks: primaryBlocks.length, gridUnits: gridUnits.length, screenUnits: screenUnits.length, replication: Number(o.replication) },
  workers: workers.map((w) => ({ id: w.id, runtime: w.runtime, threads: w.threads, memoryMiB: w.memoryMiB, behaviour: w.behaviour, units: w.units,
    cpuS: +w.cpuS.toFixed(1), wallS: +w.wallS.toFixed(1), faulty: w.faulty, retired: w.retired, unanswered: w.drops })),
  verification: stats,
  timings: { gridS: +gridS.toFixed(1), screenS: +screenS.toFixed(1), referenceS: reference.wallS },
  events: { distributed: merged.length, reference: reference.events, sha256: digest(merged.map(canonical)), referenceSha256: reference.sha256,
    equal: merged.length === reference.events && digest(merged.map(canonical)) === reference.sha256 },
  wrongOutputs: wrong,
  replicas,
};
fs.writeFileSync(o.out, JSON.stringify(result, null, 1) + '\n');
console.log(JSON.stringify({ equal: result.events.equal, events: result.events.distributed, verification: stats, timings: result.timings }));
process.exit(0);

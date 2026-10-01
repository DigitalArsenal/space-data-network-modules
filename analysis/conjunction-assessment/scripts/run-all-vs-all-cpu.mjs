// The windowed all-vs-all screen with no browser and no GPU: the module finds
// candidates on the CPU (search_candidates), as on an SDN node or in Docker.
//
// usage: node scripts/run-all-vs-all-cpu.mjs --catalog <omm.uint32be.bin>
//          [--runtime wasmedge|docker-wasmedge|node] [--propagator sgp4|hpop]
//          [--start <jd>] [--days 3] [--window-hours 6|2] [--threshold-km 5]
//          [--step-s 60] [--workers N] [--farm-workers N] [--aot] [--wasmedge-runner <path>]
//          [--algorithm FOSTER --uncertainty-model <model.cau1>] [--out summary.json]
// wasmedge runs the module as an SDN node does (WasmEdge, wasi-threads), and
// --aot compiles it ahead of time first as SDN nodes do (wasmedgec; set
// WASMEDGEC or put it on PATH / ~/.wasmedge/bin); node runs it in V8. One
// propagator per run; hpop uses the propagation farm. --wasmedge-runner runs a
// given WasmEdge host build (for example the test runner linked against SDN's
// patched static WasmEdge) instead of the one the tests build. --algorithm with
// --uncertainty-model (scripts/uncertainty-model.mjs) gives element-set events
// the empirical model's covariance probability; the default is ALFANO_MAXIMUM.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { createModuleHarness } from 'space-data-module-sdk/testing';
import { createConjunctionCommandHarness } from '../tests/lib/conjunctionCommandHarness.mjs';
import { eventSummary, screenCatalog, screenWindows, splitCatalog } from '../gpu/catalogScreen.mjs';
import { createHpopFarm } from './lib/hpopFarm.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: o } = parseArgs({ options: {
  catalog: { type: 'string' }, runtime: { type: 'string', default: 'wasmedge' }, propagator: { type: 'string', default: 'sgp4' },
  start: { type: 'string', default: '2461314.5' }, days: { type: 'string', default: '3' }, 'window-hours': { type: 'string' },
  'threshold-km': { type: 'string', default: '5' }, 'step-s': { type: 'string', default: '60' },
  workers: { type: 'string' }, 'farm-workers': { type: 'string' }, aot: { type: 'boolean', default: false }, 'wasmedge-runner': { type: 'string' }, out: { type: 'string' },
  algorithm: { type: 'string', default: 'ALFANO_MAXIMUM' }, 'uncertainty-model': { type: 'string' },
} });
if (!o.catalog) throw new Error('--catalog <omm.uint32be.bin> is required.');
if (!['sgp4', 'hpop'].includes(o.propagator)) throw new Error('--propagator is sgp4 or hpop: one propagator per run.');

const t0 = performance.now();
const catalog = splitCatalog(new Uint8Array(fs.readFileSync(o.catalog)));
const workers = Number(o.workers ?? Math.max(1, os.availableParallelism() - 1));
const windowHours = Number(o['window-hours'] ?? (o.propagator === 'hpop' ? 2 : 6));
const windows = screenWindows(Number(o.start), Number(o.days), windowHours);
const MARGIN_DAYS = 2 / 1440;   // HPOP returns whole intervals; this covers TDB - UTC

// AOT: the module's sections (without the appended signature trailer, which
// wasmedgec does not read), compiled to a universal wasm WasmEdge runs natively.
function aotModule() {
  const bytes = fs.readFileSync(path.join(root, 'dist/isomorphic/module.wasm'));
  let at = 8;
  while (at < bytes.length && bytes[at] <= 13) {
    let p = at + 1, size = 0, shift = 0;
    for (;;) { const x = bytes[p++]; size |= (x & 0x7f) << shift; shift += 7; if (!(x & 0x80)) break; }
    at = p + size;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-aot-'));
  fs.writeFileSync(path.join(dir, 'module.wasm'), bytes.subarray(0, at));
  const compiler = process.env.WASMEDGEC ?? [path.join(os.homedir(), '.wasmedge/bin/wasmedgec')].find((x) => fs.existsSync(x)) ?? 'wasmedgec';
  execFileSync(compiler, ['--enable-threads', path.join(dir, 'module.wasm'), path.join(dir, 'module.aot.wasm')], { stdio: 'ignore' });
  return path.join(dir, 'module.aot.wasm');
}
const tc = performance.now();
const wasmSource = o.aot && o.runtime !== 'node' ? aotModule() : undefined;
const aotCompileMs = wasmSource ? performance.now() - tc : 0;   // once per install on a node; not part of the screen
const harness = o['wasmedge-runner']
  ? await createModuleHarness({ runtime: { kind: 'wasmedge', launchPlan: { command: o['wasmedge-runner'],
    args: [wasmSource ?? path.join(root, 'dist/isomorphic/module.wasm'), '--serve-plugin-invoke'], cwd: root, env: process.env } } })
  : await createConjunctionCommandHarness(o.runtime === 'node'
    ? { runtimeKind: 'browser' } : { runtimeKind: o.runtime, surface: 'direct', wasmSource });
let farm = null;
try {
  if (o.propagator === 'hpop') {
    farm = await createHpopFarm({ catalog, modulesRoot: path.resolve(root, '../..'),
      workers: o['farm-workers'] ? Number(o['farm-workers']) : undefined });
  }
  // The next window exports while this one screens.
  const exports = [];
  const exportWindow = (k) => {
    if (k < windows.length && !exports[k]) {
      const w = windows[k];
      exports[k] = (k ? exportWindow(k - 1) : Promise.resolve()).then(() =>
        farm.window(w.startJd - MARGIN_DAYS, w.durationDays + 2 * MARGIN_DAYS));
    }
    return exports[k];
  };
  const result = await screenCatalog({
    invoke: (methodId, inputs) => harness.invoke({ methodId, inputs }),
    propagator: farm ? 'trajectories' : 'sgp4',
    catalog: farm ? undefined : catalog,
    trajectories: farm ? {
      objects: farm.objects,
      window: async (k, w) => {
        const out = await exportWindow(k);
        exportWindow(k + 1);
        exports[k] = null;
        const dropped = (k === 0 ? [...farm.excluded, ...out.dropped] : out.dropped).map((d) => ({ ...d, jd: d.jd ?? w.startJd }));
        return { frames: out.frames, dropped };
      },
    } : undefined,
    windows,
    controls: { thresholdKm: Number(o['threshold-km']), coarseStepSec: Number(o['step-s']), workers, algorithm: o.algorithm },
    uncertaintyModel: o['uncertainty-model'] ? new Uint8Array(fs.readFileSync(o['uncertainty-model'])) : undefined,
    screener: null,
    onProgress: (stage, done, total) => process.stderr.write(`\r${stage}: ${done} / ${total}   `),
  });
  process.stderr.write('\n');
  const wallMs = performance.now() - t0 - aotCompileMs, t = result.timings, s = (ms) => (ms / 1000).toFixed(1) + ' s';
  const summaries = result.events.map(eventSummary);
  if (o.out) fs.writeFileSync(o.out, JSON.stringify({ catalog: path.basename(o.catalog), runtime: o.runtime, propagator: o.propagator,
    startJd: +o.start, durationDays: +o.days, windowHours, workers, wallMs, aotCompileMs, objects: result.objects, windows: result.windows,
    candidates: result.candidates, excluded: result.excluded, timings: t, algorithm: o.algorithm,
    uncertaintyModel: o['uncertainty-model'] ? path.basename(o['uncertainty-model']) : null,
    events: [...summaries].sort((a, b) => a.missM - b.missM) }, null, 1) + '\n');
  console.log(`${o.propagator} on ${o.runtime}${wasmSource ? ' AOT' : ''} (CPU, ${workers} module threads): ${result.objects} objects, ${o.days} days in ` +
    `${result.windows.length} windows: ${result.candidates} candidates, ${result.events.length} conjunctions, ` +
    `${result.excluded.length} excluded, ${s(wallMs)} end to end (load ${s(t.loadMs)}, window prep/wait ${s(t.prepareMs)}, ` +
    `search ${s(t.gridMs)}, refine ${s(t.refineMs)}${wasmSource ? `; AOT compile ${s(aotCompileMs)} not counted` : ''})` +
    (o['uncertainty-model'] ? `; ${o.algorithm}: ${summaries.filter((e) => e.uncertainty === 'SYNTHESIZED_COVARIANCE').length} ` +
      `covariance probabilities, ${summaries.filter((e) => e.calibration === 'Calibrated').length} calibrated` : ''));
} finally {
  await farm?.close();
  await harness.destroy?.();
}

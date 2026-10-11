// The windowed all-vs-all screen with no browser and no GPU: the module finds
// candidates on the CPU (search_candidates), as on an SDN node or in Docker.
//
// usage: node scripts/run-all-vs-all-cpu.mjs --catalog <omm.uint32be.bin>
//          [--runtime wasmedge|docker-wasmedge|node] [--propagator sgp4|hpop]
//          [--start <jd>] [--days 3] [--window-hours 6|1] [--threshold-km 5]
//          [--step-s 60] [--workers N] [--farm-workers N] [--aot] [--wasmedge-runner <path>]
//          [--hpop-environment <dir>] [--hpop-profile full-force|gravity-only] [--load-ceiling L]
//          [--algorithm FOSTER --uncertainty-model <model.cau1>] [--out summary.json]
// wasmedge runs the module as an SDN node does (WasmEdge, wasi-threads), and
// --aot compiles it ahead of time first as SDN nodes do (wasmedgec; set
// WASMEDGEC or put it on PATH / ~/.wasmedge/bin); node runs it in V8. One
// propagator per run; hpop uses the propagation farm: the full force model
// with --hpop-environment (kernel.prw, earth_orientation.prw and
// space_weather.prw, PRW records), or --hpop-profile gravity-only. --wasmedge-runner runs a
// given WasmEdge host build (for example the test runner linked against SDN's
// patched static WasmEdge) instead of the one the tests build. --algorithm with
// --uncertainty-model (scripts/uncertainty-model.mjs) gives element-set events
// the empirical model's covariance probability; the default is ALFANO_MAXIMUM.
// --load-ceiling pauses the HPOP farm's next chunk of objects while the host's
// 1-minute load average exceeds L. The summary gives the farm's CPU time (each
// worker thread's user and system time) beside the wall-clock stages.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createModuleHarness } from 'space-data-module-sdk/testing';
import { createConjunctionCommandHarness } from '../tests/lib/conjunctionCommandHarness.mjs';
import { eventSummary, screenCatalog, screenWindows, splitCatalog } from '../gpu/catalogScreen.mjs';
import { createHpopFarm } from './lib/hpopFarm.mjs';
import { aotModule } from './lib/aot.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: o } = parseArgs({ options: {
  catalog: { type: 'string' }, runtime: { type: 'string', default: 'wasmedge' }, propagator: { type: 'string', default: 'sgp4' },
  start: { type: 'string', default: '2461314.5' }, days: { type: 'string', default: '3' }, 'window-hours': { type: 'string' },
  'threshold-km': { type: 'string', default: '5' }, 'step-s': { type: 'string', default: '60' },
  workers: { type: 'string' }, 'farm-workers': { type: 'string' }, 'hpop-environment': { type: 'string' }, 'hpop-profile': { type: 'string', default: 'full-force' }, 'load-ceiling': { type: 'string' }, aot: { type: 'boolean', default: false }, 'wasmedge-runner': { type: 'string' }, out: { type: 'string' },
  algorithm: { type: 'string', default: 'ALFANO_MAXIMUM' }, 'uncertainty-model': { type: 'string' },
} });
if (!o.catalog) throw new Error('--catalog <omm.uint32be.bin> is required.');
if (!['sgp4', 'hpop'].includes(o.propagator)) throw new Error('--propagator is sgp4 or hpop: one propagator per run.');

const t0 = performance.now();
const catalog = splitCatalog(new Uint8Array(fs.readFileSync(o.catalog)));
const workers = Number(o.workers ?? Math.max(1, os.availableParallelism() - 1));
// HPOP's 300 s segments: a 1-hour window of the full catalog is about 390 MB of
// trajectories, which the module indexes in about 1.05 of its 2 GiB.
const windowHours = Number(o['window-hours'] ?? (o.propagator === 'hpop' ? 1 : 6));
const windows = screenWindows(Number(o.start), Number(o.days), windowHours);
const MARGIN_DAYS = 2 / 1440;   // HPOP returns whole intervals; this covers TDB - UTC

// AOT: compiled to a universal wasm WasmEdge runs natively, as SDN nodes do.
const compiler = () => process.env.WASMEDGEC ?? [path.join(os.homedir(), '.wasmedge/bin/wasmedgec')].find((x) => fs.existsSync(x)) ?? 'wasmedgec';
const tc = performance.now();
const wasmSource = o.aot && o.runtime !== 'node' ? aotModule(path.join(root, 'dist/isomorphic/module.wasm'), compiler()) : undefined;
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
      workers: o['farm-workers'] ? Number(o['farm-workers']) : undefined,
      profile: o['hpop-profile'], environment: o['hpop-environment'], screenStartJd: Number(o.start),
      loadCeiling: o['load-ceiling'] ? Number(o['load-ceiling']) : undefined });
  }
  // The next window exports while this one screens.
  const exports = [], hpopDropped = [];
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
        hpopDropped.push(...dropped);
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
    processCpuS: (({ user, system }) => (user + system) / 1e6)(process.cpuUsage()),
    ...(farm ? { hpop: { profile: farm.profile, farmWorkers: farm.workers, instances: farm.instances, loadCeiling: o['load-ceiling'] ? Number(o['load-ceiling']) : null,
      cpu: { ingestS: farm.cpu.ingestS, propagationS: farm.cpu.windows.reduce((sum, w) => sum + w.cpuS, 0), windows: farm.cpu.windows },
      dropped: hpopDropped.map(({ norad, objectId, name, reason, jd }) => ({ norad, objectId, name, reason, jd })),
      reentries: farm.reentries.map(({ norad, objectId, name, phase, jd }) => ({ norad, objectId, name, phase, jd })) } } : {}),
    events: [...summaries].sort((a, b) => a.missM - b.missM) }, null, 1) + '\n');
  console.log(`${o.propagator} on ${o.runtime}${wasmSource ? ' AOT' : ''} (CPU, ${workers} module threads): ${result.objects} objects, ${o.days} days in ` +
    `${result.windows.length} windows: ${result.candidates} candidates, ${result.events.length} conjunctions, ` +
    `${result.excluded.length} excluded, ${s(wallMs)} end to end (load ${s(t.loadMs)}, window prep/wait ${s(t.prepareMs)}, ` +
    `search ${s(t.gridMs)}, refine ${s(t.refineMs)}${wasmSource ? `; AOT compile ${s(aotCompileMs)} not counted` : ''})` +
    (farm ? `; HPOP farm CPU ${(farm.cpu.ingestS + farm.cpu.windows.reduce((sum, w) => sum + w.cpuS, 0)).toFixed(0)} s` +
      `; HPOP reentries: ${farm.reentries.filter((x) => x.phase === 'catch-up').length} before the screen, ` +
      `${farm.reentries.filter((x) => x.phase === 'screen').length} during it` : '') +
    (o['uncertainty-model'] ? `; ${o.algorithm}: ${summaries.filter((e) => e.uncertainty === 'SYNTHESIZED_COVARIANCE').length} ` +
      `covariance probabilities, ${summaries.filter((e) => e.calibration === 'Calibrated').length} calibrated` : ''));
} finally {
  await farm?.close();
  await harness.destroy?.();
}

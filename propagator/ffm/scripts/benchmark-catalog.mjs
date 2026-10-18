#!/usr/bin/env node
// Catalog-through-WASM evidence. OMM inputs remain external; only aggregate
// measurements and comparison events are written. JS moves SDS records, selects
// archived metadata strata and times the run; propagation and CA are WASM.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createOmmEncoder } from '../../../analysis/conjunction-assessment/scripts/lib/ommCatalog.mjs';

export const modulesRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const ports = ['kernel', 'earth_orientation', 'space_weather'];
export async function loadFarm(farmModule) {
  return import(pathToFileURL(farmModule ? path.resolve(farmModule) : path.join(modulesRoot, 'analysis/conjunction-assessment/scripts/lib/ffmFarm.mjs')));
}
export function loadCatalog(file) {
  const bytes = fs.readFileSync(file);
  const records = JSON.parse((file.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8'));
  if (!Array.isArray(records) || !records.length) throw new Error('Catalog must contain a nonempty GP JSON array.');
  return { records, sha256: sha256(bytes) };
}
// Classification uses published catalog metadata, never derived orbital math.
export function catalogStratum(record) {
  const perigeeKm = Number(record.PERIAPSIS), eccentricity = Number(record.ECCENTRICITY);
  if (!Number.isFinite(perigeeKm) || !Number.isFinite(eccentricity)) throw new Error('Stratification needs PERIAPSIS and ECCENTRICITY metadata.');
  if (eccentricity > 0.2) return perigeeKm < 2000 ? 'GTO' : 'HEO';
  if (perigeeKm < 450) return 'LEO-low';
  if (perigeeKm < 650) return 'LEO-mid';
  if (perigeeKm < 1000) return 'LEO-high';
  if (perigeeKm < 2000) return 'LEO-upper';
  return perigeeKm < 30000 ? 'MEO' : 'GEO';
}
export function selectCatalog(records, count = records.length) {
  if (!Number.isInteger(count) || count < 1 || count > records.length) throw new Error(`Objects must be 1..${records.length}.`);
  const groups = new Map();
  for (const record of records) {
    const key = catalogStratum(record);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  const names = [...groups.keys()].sort();
  for (const group of groups.values()) group.sort((a, b) => Number(a.NORAD_CAT_ID) - Number(b.NORAD_CAT_ID));
  const sizes = Object.fromEntries(names.map((name) => [name, 0]));
  for (let assigned = 0; assigned < count;) for (const name of names) {
    if (assigned === count) break;
    if (sizes[name] < groups.get(name).length) { ++sizes[name]; ++assigned; }
  }
  const selected = names.flatMap((name) => Array.from({ length: sizes[name] }, (_, i) =>
    groups.get(name)[Math.floor((i + 0.5) * groups.get(name).length / sizes[name])]));
  return { records: selected, strata: sizes, population: Object.fromEntries(names.map((name) => [name, groups.get(name).length])) };
}
export async function encodeCatalog(records) {
  const encode = await createOmmEncoder();
  return records.map((record) => { const bytes = encode(record); if (!bytes) throw new Error(`OMM encoding refused NORAD ${record.NORAD_CAT_ID}.`); return bytes; });
}
export async function runCatalog({ records, catalogSha256, population, strata, implementation = 'ffm', environment,
  workers, startUtc = '2026-10-04T00:00:00Z', days = 3, windowHours = 1, screen = false, screenWorkers = 1,
  thresholdKm = 5, farmModule, artifactRoot, output, phase = 'phase-1', uncertaintyModel, onProgress = console.error }) {
  if (implementation !== 'ffm') throw new Error('The only product implementation is ffm.');
  const startJd = Date.parse(startUtc) / 86400000 + 2440587.5;
  if (!Number.isFinite(startJd) || !Number.isFinite(days) || days <= 0 || !Number.isFinite(windowHours) || windowHours <= 0)
    throw new Error('Provide a valid UTC epoch, positive days and positive window hours.');
  const { createFfmFarm } = await loadFarm(farmModule);
  const moduleRoot = artifactRoot ?? path.join(modulesRoot, 'propagator', 'ffm');
  const manifest = JSON.parse(fs.readFileSync(path.join(moduleRoot, 'plugin-manifest.json'), 'utf8'));
  const environmentSha256 = Object.fromEntries(ports.map((port) => [port, sha256(fs.readFileSync(path.join(environment, `${port}.prw`)))]));
  const result = { phase, implementation, moduleId: manifest.pluginId, version: manifest.version,
    wasmSha256: sha256(fs.readFileSync(path.join(moduleRoot, 'dist/isomorphic/module.wasm'))), catalogSha256,
    selectedIdsSha256: sha256(JSON.stringify(records.map((r) => r.NORAD_CAT_ID))), objects: records.length,
    population, strata, startUtc, days, windowHours, profile: 'full-force', environmentSha256,
    environmentNote: 'Environment files supplied by caller; synthetic weather must be disclosed with results.',
    node: process.version, host: { model: os.cpus()[0]?.model, availableCores: os.availableParallelism() },
    loadAverageStart: os.loadavg(), loadSamples: [], completed: false };
  const started = performance.now(), cpu0 = process.cpuUsage();
  const timer = setInterval(() => {
    const sample = { elapsedSeconds: (performance.now() - started) / 1000, loadAverage: os.loadavg() };
    result.loadSamples.push(sample); onProgress(JSON.stringify({ progress: 'running', implementation, ...sample }));
  }, 30000);
  let farm, harness;
  try {
    const catalog = await encodeCatalog(records);
    farm = await createFfmFarm({ catalog, modulesRoot, implementation, profile: 'full-force', environment, workers, screenStartJd: startJd });
    result.workers = farm.workers; result.workerPolicy = farm.workerPolicy;
    if (farm.implementation !== implementation || farm.moduleId !== manifest.pluginId) throw new Error('Farm did not select the requested implementation. Apply the reviewed farm patch first.');
    onProgress(JSON.stringify({ progress: 'ingested', implementation, objects: records.length, workers: farm.workers, excluded: farm.excluded.length }));
    const { screenWindows, screenCatalog, eventSummary } = await import('../../../analysis/conjunction-assessment/gpu/catalogScreen.mjs');
    const windows = screenWindows(startJd, days, windowHours);
    result.trajectories = 0; result.trajectoryBytes = 0;
    const dropped = [];
    const window = async (k, w) => {
      const margin = screen ? 2 / 1440 : 0;
      const data = await farm.window(w.startJd - margin, w.durationDays + 2 * margin);
      result.trajectories += data.frames.length; result.trajectoryBytes += data.frames.reduce((sum, bytes) => sum + bytes.length, 0);
      dropped.push(...data.dropped);
      if (k === 0) data.dropped.unshift(...farm.excluded.map((d) => ({ ...d, jd: w.startJd })));
      onProgress(JSON.stringify({ progress: 'window', implementation, completed: k + 1, total: windows.length }));
      return data;
    };
    if (screen) {
      const { createConjunctionCommandHarness } = await import('../../../analysis/conjunction-assessment/tests/lib/conjunctionCommandHarness.mjs');
      harness = await createConjunctionCommandHarness({ runtimeKind: 'browser' });
      const screened = await screenCatalog({ invoke: (methodId, inputs) => harness.invoke({ methodId, inputs }), propagator: 'trajectories',
        trajectories: { objects: farm.objects, window }, windows,
        controls: { thresholdKm, coarseStepSec: 60, workers: screenWorkers, algorithm: uncertaintyModel ? 'FOSTER' : 'ALFANO_MAXIMUM' },
        uncertaintyModel: uncertaintyModel ? new Uint8Array(fs.readFileSync(uncertaintyModel)) : undefined, screener: null });
      result.screen = { objects: screened.objects, candidates: screened.candidates, windows: screened.windows.length,
        workers: screenWorkers, thresholdKm, timings: screened.timings, events: screened.events.map(eventSummary),
        uncertaintyModelSha256: uncertaintyModel ? sha256(fs.readFileSync(uncertaintyModel)) : null };
    } else for (const [k, w] of windows.entries()) await window(k, w);
    result.excluded = farm.excluded.length; result.dropped = dropped.length; result.reentries = farm.reentries.length;
    result.exclusionReasons = Object.fromEntries([...farm.excluded, ...dropped].reduce((counts, row) => counts.set(row.reason, (counts.get(row.reason) ?? 0) + 1), new Map()));
    result.farmCpuSeconds = farm.cpu.ingestS + farm.cpu.windows.reduce((sum, w) => sum + w.cpuS, 0);
    result.stages = { deriveMs: farm.deriveMs, ingestMs: farm.ingestMs, cpu: farm.cpu };
    result.completed = true;
  } catch (error) { result.error = String(error.stack ?? error); }
  finally {
    await farm?.close(); await harness?.destroy?.(); clearInterval(timer);
    result.wallSeconds = (performance.now() - started) / 1000;
    const cpu = process.cpuUsage(cpu0); result.cpuSeconds = (cpu.user + cpu.system) / 1e6;
    result.loadAverageEnd = os.loadavg();
    if (output) fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  }
  return result;
}
async function main() {
  const { values: o } = parseArgs({ options: {
    catalog: { type: 'string' }, environment: { type: 'string' }, out: { type: 'string' }, implementation: { type: 'string', default: 'ffm' },
    objects: { type: 'string' }, workers: { type: 'string' }, start: { type: 'string', default: '2026-10-04T00:00:00Z' }, days: { type: 'string', default: '3' },
    'window-hours': { type: 'string', default: '1' }, 'farm-module': { type: 'string' }, phase: { type: 'string', default: 'phase-1' },
    screen: { type: 'boolean', default: false }, 'screen-workers': { type: 'string', default: '1' }, 'threshold-km': { type: 'string', default: '5' }, 'uncertainty-model': { type: 'string' },
  } });
  if (!o.catalog || !o.environment || !o.out) throw new Error('Required: --catalog archive.json[.gz] --environment PRW-directory --out result.json; omit --objects for the full catalog.');
  const catalog = loadCatalog(o.catalog), selected = selectCatalog(catalog.records, o.objects ? Number(o.objects) : undefined);
  const result = await runCatalog({ ...selected, catalogSha256: catalog.sha256, environment: o.environment, implementation: o.implementation,
    workers: o.workers ? Number(o.workers) : undefined, startUtc: o.start, days: Number(o.days), windowHours: Number(o['window-hours']),
    farmModule: o['farm-module'], output: o.out, phase: o.phase, screen: o.screen, screenWorkers: Number(o['screen-workers']),
    thresholdKm: Number(o['threshold-km']), uncertaintyModel: o['uncertainty-model'] });
  console.log(JSON.stringify({ implementation: result.implementation, completed: result.completed, objects: result.objects, startUtc: result.startUtc,
    days: result.days, workers: result.workers, wallSeconds: result.wallSeconds, cpuSeconds: result.cpuSeconds, farmCpuSeconds: result.farmCpuSeconds,
    loadAverageStart: result.loadAverageStart, loadAverageEnd: result.loadAverageEnd, error: result.error, output: o.out }));
  if (!result.completed) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

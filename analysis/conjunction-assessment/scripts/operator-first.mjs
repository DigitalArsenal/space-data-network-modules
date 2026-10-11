#!/usr/bin/env node
// Operator-first screening with real Starlink data. The network keeps the
// catalog index (each window's coarse grid of the current Space-Track
// catalog). The operator's node takes its fresh ephemerides (SpaceX's public
// MEME files, read into memory and never stored), fits each with the OD
// module (analysis/od: SGP4 mean elements over the first two orbits, the
// SupGP practice, so the screen keeps one propagator), screens those objects
// against the index as an incremental update (their rows replaced, search_grid
// with them as primaries, refine_candidates), and publishes the element sets
// and the results together: one screen unit per window (gpu/workUnits.mjs),
// its output, and a PNM signed by the operator's key naming a manifest of
// both. An independent worker process (another runtime) then rebuilds the
// grids from the sources, re-runs every unit and compares bytes.
//
// Measured: the operator's latency, from its ephemerides in memory to the
// signed PNM. Written: aggregates only; the store (scratch) holds the fitted
// element sets and must not be published.
//
// usage: node scripts/operator-first.mjs --gp <spacetrack gp snapshot .json.gz> --gp-history <by-creation dir>
//          --store <dir> --out <summary.json> [--satellites 64] [--supgp <CelesTrak SupGP starlink .json>]
//          [--days 3] [--window-hours 6] [--threshold-km 5] [--workers 6]
//          [--verify-runtime node|wasmedge-aot --aotc <path> --aot-runner <path>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as flatbuffers from 'flatbuffers';
import { PNMT, PNM } from 'spacedatastandards.org/lib/js/PNM/main.js';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';
import { createConjunctionCommandHarness } from '../tests/lib/conjunctionCommandHarness.mjs';
import { prepareIndex, releaseIndex, screenWindows, sgp4Sources, windowRequest } from '../gpu/catalogScreen.mjs';
import { ROLE, cutBlocks, rolesFrame, sampleWindowGrid, spliceGridRows } from '../gpu/continuousScreen.mjs';
import { assembleWindowGrid, exclusionsBytes, packFrames, runUnit, unitEvents, unitId } from '../gpu/workUnits.mjs';
import { createOmmEncoder } from './lib/ommCatalog.mjs';
import { recordsCreated, utcMs } from './lib/gpHistory.mjs';
import { aotModule } from './lib/aot.mjs';
import { cidOf, openStore } from './lib/contentStore.mjs';
import { runOn, signedByWorker, spawnWorker, stopWorker } from './lib/workerProcess.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: o } = parseArgs({ options: {
  gp: { type: 'string' }, 'gp-history': { type: 'string' }, store: { type: 'string' }, out: { type: 'string' },
  satellites: { type: 'string', default: '64' }, supgp: { type: 'string' },
  days: { type: 'string', default: '3' }, 'window-hours': { type: 'string', default: '6' }, 'threshold-km': { type: 'string', default: '5' },
  workers: { type: 'string', default: '6' }, 'verify-runtime': { type: 'string', default: 'node' }, aotc: { type: 'string' }, 'aot-runner': { type: 'string' },
} });
if (!o.gp || !o['gp-history'] || !o.store || !o.out) throw new Error('--gp, --gp-history, --store and --out are required.');
const log = (m) => console.error(`${new Date().toISOString().slice(11, 19)} ${m}`);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const now = Date.now();
const store = openStore(o.store);
const modulePath = path.join(root, 'dist/isomorphic/module.wasm');
const moduleSha = sha(fs.readFileSync(modulePath));
const controls = { thresholdKm: Number(o['threshold-km']), coarseStepSec: 60, algorithm: 'ALFANO_MAXIMUM' };
const threads = Number(o.workers);
const encode = await createOmmEncoder();

// The network's catalog: the latest Space-Track snapshot and every newer element set.
const snapshot = JSON.parse(zlib.gunzipSync(fs.readFileSync(o.gp)));
const records = new Map(snapshot.map((r) => [Number(r.NORAD_CAT_ID), r]));
const snapshotTo = Math.max(...snapshot.map((r) => utcMs(r.CREATION_DATE)));
for (const r of recordsCreated(o['gp-history'], snapshotTo + 1000, now)) {
  const prior = records.get(Number(r.NORAD_CAT_ID));
  if (!prior || utcMs(r.EPOCH) >= utcMs(prior.EPOCH)) records.set(Number(r.NORAD_CAT_ID), r);
}
const catalog = [...records.values()].sort((a, b) => Number(a.NORAD_CAT_ID) - Number(b.NORAD_CAT_ID));
const rowOf = new Map(catalog.map((r, i) => [Number(r.NORAD_CAT_ID), i]));
const catalogFrames = catalog.map(encode);
const createdTo = Math.max(...catalog.map((r) => utcMs(r.CREATION_DATE)));
const startJd = Math.floor(now / 3600e3) * 3600e3 / 86400e3 + 2440587.5;   // this hour
const windows = screenWindows(startJd, Number(o.days), Number(o['window-hours']));
log(`catalog: ${catalog.length} objects, element sets created to ${new Date(createdTo).toISOString()}; screen from ${new Date((startJd - 2440587.5) * 86400e3).toISOString()}`);

const harness = await createConjunctionCommandHarness({ runtimeKind: 'browser' });
const invoke = (methodId, inputs) => harness.invoke({ methodId, inputs });
const measure = async (fn) => { const c = process.cpuUsage(), t = performance.now(); const value = await fn(); const u = process.cpuUsage(c);
  return { value, wallS: +((performance.now() - t) / 1000).toFixed(2), cpuS: +((u.user + u.system) / 1e6).toFixed(1) }; };
const options = { ...controls, workers: threads };

// The network's catalog index: every window's grid (kept by the network, not part of the operator's latency).
const index = await measure(async () => {
  const h = await prepareIndex(invoke, sgp4Sources(catalogFrames));
  const grids = [];
  for (const w of windows) grids.push(await sampleWindowGrid({ invoke, request: windowRequest(h, 'TEME', w, options) }));
  await releaseIndex(invoke, h);
  return grids;
});
log(`network index: ${windows.length} windows in ${index.wallS} s`);

// The operator's fresh ephemerides, in memory: the newest file per satellite, the first two orbits' states.
const BASE = 'https://api.starlink.com/public-files/ephemerides/';
const HEADERS = { 'User-Agent': 'sdn-ca-continuous/1.0' };
const ephemerides = [];
let fetch_ = { files: 0, bytes: 0, wallS: 0, manifest: null };
if (!o.supgp) {
  const t = performance.now();
  const manifest = await (await fetch(`${BASE}MANIFEST.txt`, { headers: HEADERS })).text();
  const names = manifest.split(/\s+/).filter((n) => /^MEME_\d+_STARLINK-\d+_\d+_Operational_\d+_UNCLASSIFIED\.txt$/.test(n));
  fetch_.manifest = names.length;
  // A deterministic sample of satellites in today's catalog.
  const chosen = names.filter((n) => rowOf.has(Number(n.split('_')[1])))
    .map((n) => [sha(`operator-first-20261011:${n}`), n]).sort().slice(0, Number(o.satellites)).map((x) => x[1]);
  const bytes = 400 + (Math.ceil(11520 / 60) + 1 + 3) * 480;
  for (let i = 0; i < chosen.length; i += 4) {
    await Promise.all(chosen.slice(i, i + 4).map(async (name) => {
      const res = await fetch(BASE + name, { headers: { ...HEADERS, Range: `bytes=0-${bytes - 1}` } });
      if (!res.ok) return;
      const text = new Uint8Array(await res.arrayBuffer());
      ephemerides.push({ name, norad: Number(name.split('_')[1]), text });
      fetch_.bytes += text.length;
    }));
  }
  fetch_ = { ...fetch_, files: ephemerides.length, wallS: +((performance.now() - t) / 1000).toFixed(1) };
  log(`fetched ${ephemerides.length} ephemerides (${(fetch_.bytes / 1e6).toFixed(1)} MB) in ${fetch_.wallS} s`);
}

// ---- The operator's node, from its fresh data in memory to the signed PNM. ----
const operator = generateKeyPairSync('ed25519');
const t0 = performance.now(), c0 = process.cpuUsage();
const stage = {};
// 1. Element sets: the OD module's fit of each ephemeris, or CelesTrak's SupGP fits (--supgp).
let fitted = [];
stage.fit = await measure(async () => {
  if (o.supgp) {
    fitted = JSON.parse(fs.readFileSync(o.supgp, 'utf8')).filter((r) => rowOf.has(Number(r.NORAD_CAT_ID)));
    return;
  }
  const od = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(path.join(root, '../od/dist/isomorphic/module.wasm')), surface: 'direct' });
  try {
    for (const e of ephemerides) {
      const name = e.name.split('_')[2];
      const response = await od.invoke({ methodId: 'fit', inputs: [{ portId: 'meme', payload: e.text },
        { portId: 'options', payload: new TextEncoder().encode(JSON.stringify({ inputFormat: 'meme', dataSource: 'SpaceX-E', noradCatId: e.norad, objectName: name })) }] });
      if (response.statusCode !== 0) continue;
      const fit = JSON.parse(new TextDecoder().decode(response.outputs.find((x) => x.portId === 'result').payload));
      const prior = catalog[rowOf.get(e.norad)];
      fitted.push({ ...fit, EPOCH: String(fit.EPOCH).replace(/Z$/, ''), NORAD_CAT_ID: e.norad, OBJECT_NAME: prior.OBJECT_NAME, OBJECT_ID: prior.OBJECT_ID });
    }
  } finally { await od.destroy(); }
});
const fits = fitted.map((r) => ({ row: rowOf.get(Number(r.NORAD_CAT_ID)), frame: encode(r), rms: Number(r.RMS) }))
  .filter((x) => x.frame).sort((a, b) => a.row - b.row);
const rows = fits.map((x) => x.row);
// 2. The operator's rows on the index: coarse_grid on an index of its objects, spliced in.
const operatorFrames = catalogFrames.slice();
for (const f of fits) operatorFrames[f.row] = f.frame;
const grids = index.value.map((g) => ({ blocks: g.blocks.map((b) => b.slice()), excluded: new Map(g.excluded), objects: g.objects }));
stage.rows = await measure(async () => {
  const h = await prepareIndex(invoke, sgp4Sources(fits.map((f) => f.frame)));
  for (const [w, win] of windows.entries()) spliceGridRows(grids[w], await sampleWindowGrid({ invoke, request: windowRequest(h, 'TEME', win, options) }), rows);
  await releaseIndex(invoke, h);
});
// 3. One screen unit per window, the operator's objects the primaries; run on the operator's node.
const roles = new Uint8Array(operatorFrames.length);
for (const r of rows) roles[r] = ROLE.PRIMARY;
const units = [];
stage.units = await measure(async () => {
  const sources = store.put(packFrames(operatorFrames)), rolesHash = store.put(rolesFrame(roles));
  for (const [w, win] of windows.entries()) {
    // The grid blocks are named by hash; the operator serves them from memory (the verifier rebuilds them).
    const blocks = new Map(grids[w].blocks.map((b) => [sha(b), b]));
    const record = { kind: 'ca.screen/1', module: moduleSha, sources, window: { startJd: win.startJd, durationDays: win.durationDays }, controls,
      grid: [...blocks.keys()], excluded: store.put(exclusionsBytes(grids[w].excluded)), roles: rolesHash };
    const id = await unitId(record);
    const output = await runUnit(record, { invoke, fetch: async (x) => blocks.get(x) ?? store.get(x), threads });
    units.push({ id, record: store.put(new TextEncoder().encode(JSON.stringify(record))), recordValue: record, output: store.put(output) });
  }
});
// 4. Data and results together: a manifest of the element sets and every unit, announced by a signed PNM.
let pnmBytes, manifestHash;
stage.publish = await measure(async () => {
  const manifest = { kind: 'ca.operator-screen/1', provider: 'operator-key:ed25519:' + operator.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    data: { kind: 'OMM', count: fits.length, cid: cidOf(store.put(packFrames(fits.map((f) => f.frame)))) },
    units: units.map((u) => ({ unit: u.id, record: cidOf(u.record), output: cidOf(u.output) })) };
  manifestHash = store.put(new TextEncoder().encode(JSON.stringify(manifest)));
  const record = new PNMT();
  record.MULTIFORMAT_ADDRESS = `/ipfs/${cidOf(manifestHash)}`;
  record.PUBLISH_TIMESTAMP = new Date().toISOString();
  record.CID = cidOf(manifestHash);
  record.FILE_NAME = 'operator-screen';
  record.FILE_ID = `ca.operator-screen:${manifestHash}`;
  record.SIGNATURE = sign(null, Buffer.from(`${record.FILE_ID}\n${record.CID}`), operator.privateKey).toString('base64');
  record.SIGNATURE_TYPE = 'ed25519';
  const b = new flatbuffers.Builder(1024);
  PNM.finishPNMBuffer(b, record.pack(b));
  pnmBytes = b.asUint8Array().slice();
});
const latencyS = (performance.now() - t0) / 1000, latencyCpu = process.cpuUsage(c0);
const events = (await Promise.all(units.map(async (u) => unitEvents(await store.get(u.output))))).flat();
log(`operator: ${fits.length} element sets, ${events.length} conjunctions, published in ${latencyS.toFixed(1)} s`);
await harness.destroy?.();

// ---- An independent verifier: rebuilds the grids from the sources and re-runs every unit. ----
const aot = o['verify-runtime'] === 'wasmedge-aot' ? aotModule(modulePath, o.aotc, []) : null;
const verifier = await spawnWorker({ id: 'verifier', runtime: o['verify-runtime'], threads, memoryMiB: 8192, storeDir: o.store, modulePath,
  aotModule: aot, aotRunner: o['aot-runner'] });
const verification = { runtime: o['verify-runtime'], gridsMatch: 0, outputsMatch: 0, units: units.length, signedPnm: false };
const tv = performance.now();
{
  const pnm = PNM.getRootAsPNM(new flatbuffers.ByteBuffer(pnmBytes));
  verification.signedPnm = pnm.CID() === cidOf(manifestHash) &&
    verify(null, Buffer.from(`${pnm.FILE_ID()}\n${pnm.CID()}`), operator.publicKey, Buffer.from(pnm.SIGNATURE(), 'base64'));
  const rowBlocks = cutBlocks(Array.from({ length: operatorFrames.length }, (_, i) => i), Math.ceil(operatorFrames.length / 4));
  for (const [w, u] of units.entries()) {
    const rec = u.recordValue;
    // The window's grid, from the sources the unit names.
    const parts = [];
    for (const blockRows of rowBlocks) {
      const g = { kind: 'ca.grid/1', module: moduleSha, sources: rec.sources, window: rec.window, controls, rows: [blockRows[0], blockRows.length], blockSteps: 32 };
      const id = await unitId(g), m = await runOn(verifier, g, id);
      if (m.type !== 'result' || !signedByWorker(verifier, id, m, store)) throw new Error(`verifier grid unit: ${m.message ?? 'unsigned'}`);
      parts.push({ output: await store.get(m.hash), rows: blockRows });
    }
    const grid = assembleWindowGrid(parts);
    if (grid.blocks.every((b, i) => store.put(b) === rec.grid[i]) && sha(exclusionsBytes(grid.excluded)) === rec.excluded) verification.gridsMatch++;
    const m = await runOn(verifier, rec, u.id);
    if (m.type === 'result' && signedByWorker(verifier, u.id, m, store) && m.hash === u.output) verification.outputsMatch++;
    log(`verified window ${w + 1}/${units.length}: grid ${verification.gridsMatch}, output ${verification.outputsMatch}`);
  }
}
verification.wallS = +((performance.now() - tv) / 1000).toFixed(1);
stopWorker(verifier);

const miss = events.map((e) => e.MISS_DISTANCE_M).sort((a, b) => a - b);
const rms = fits.map((f) => f.rms).filter(Number.isFinite).sort((a, b) => a - b);
const result = {
  source: o.supgp ? 'CelesTrak SupGP (fits to SpaceX ephemerides), latest snapshot' : 'SpaceX Starlink MEME ephemerides, read in memory; fitted by analysis/od',
  catalog: { objects: catalog.length, elementSetsCreatedTo: new Date(createdTo).toISOString() },
  screen: { startUtc: new Date((startJd - 2440587.5) * 86400e3).toISOString(), days: Number(o.days), windows: windows.length, ...controls },
  operatorData: { satellitesInManifest: fetch_.manifest, fetched: fetch_.files, fetchMB: +(fetch_.bytes / 1e6).toFixed(1), fetchWallS: fetch_.wallS,
    elementSets: fits.length, fitRmsKm: rms.length ? { median: rms[rms.length >> 1], max: rms.at(-1) } : null },
  networkIndex: { wallS: index.wallS, cpuS: index.cpuS },
  operatorLatency: { wallS: +latencyS.toFixed(2), cpuS: +((latencyCpu.user + latencyCpu.system) / 1e6).toFixed(1), threads,
    stages: Object.fromEntries(Object.entries(stage).map(([k, v]) => [k, { wallS: v.wallS, cpuS: v.cpuS }])) },
  results: { conjunctions: events.length, minMissM: miss[0] ?? null, under1kmM: miss.filter((x) => x < 1000).length },
  publication: { pnmBytes: pnmBytes.length, units: units.length, manifestCid: cidOf(manifestHash) },
  verification,
  host: { cpus: os.cpus().length, model: os.cpus()[0]?.model, load1: +os.loadavg()[0].toFixed(1) },
};
fs.writeFileSync(o.out, JSON.stringify(result, null, 1) + '\n');
console.log(JSON.stringify({ latency: result.operatorLatency, results: result.results, verification }));
process.exit(0);

// Serves examples/all-vs-all-gpu with cross-origin isolation and runs it in
// headless Chrome with WebGPU, or leaves it up for a browser (--serve).
//
// usage: node scripts/run-all-vs-all-gpu.mjs --catalog <omm.uint32be.bin>
//          [--propagator sgp4|hpop] [--start <jd>] [--days 3] [--window-hours 6]
//          [--threshold-km 5] [--step-s 60] [--farm-workers N] [--cpu]
//          [--out summary.json] [--serve] [--port 0] [--timeout-s 7200]
// The catalog is $OMM records, each prefixed by its u32 big-endian length.
// One propagator per run. With --propagator hpop the runner hosts the HPOP
// propagation farm (scripts/lib/hpopFarm.mjs) and serves each window's
// trajectories to the page, exporting the next window while the page screens
// the current one. --cpu screens without WebGPU (the module's own search), as
// a browser without a GPU does; scripts/run-all-vs-all-cpu.mjs runs the same
// screen with no browser (Node or WasmEdge, as an SDN node runs modules).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';
import { createHpopFarm } from './lib/hpopFarm.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const example = path.join(root, 'examples/all-vs-all-gpu');
const sdkTesting = path.dirname(fileURLToPath(import.meta.resolve('space-data-module-sdk/testing')));
const sdkSource = path.resolve(sdkTesting, '..');
const { resolveChromeBinary } = await import(path.join(sdkTesting, 'parityLanes.js'));

const { values: o } = parseArgs({ options: {
  catalog: { type: 'string' }, propagator: { type: 'string', default: 'sgp4' }, start: { type: 'string', default: '2461314.5' },
  days: { type: 'string', default: '3' }, 'window-hours': { type: 'string' }, 'threshold-km': { type: 'string', default: '5' },
  'step-s': { type: 'string', default: '60' }, 'farm-workers': { type: 'string' }, cpu: { type: 'boolean', default: false },
  out: { type: 'string' }, serve: { type: 'boolean', default: false }, port: { type: 'string', default: '0' },
  'timeout-s': { type: 'string', default: '7200' },
} });
if (!o.catalog) throw new Error('--catalog <omm.uint32be.bin> is required.');
if (!['sgp4', 'hpop'].includes(o.propagator)) throw new Error('--propagator is sgp4 or hpop: one propagator per run.');
const t0 = performance.now();
const catalogBytes = fs.readFileSync(o.catalog);
// HPOP windows hold every object's trajectory (~12 KB per object per 2 h).
const windowHours = Number(o['window-hours'] ?? (o.propagator === 'hpop' ? 2 : 6));
const windows = Array.from({ length: Math.ceil((Number(o.days) * 24) / windowHours - 1e-9) }, (_, k) => ({
  startJd: Number(o.start) + (k * windowHours) / 24, durationDays: Math.min(windowHours, Number(o.days) * 24 - k * windowHours) / 24 }));

// HPOP: the farm, and each window's export as the page's window file (u32 JSON
// length, JSON, then each $PRW record as u32 length + bytes, all 8-padded).
let farm = null, farmInfo = null;
const exports = [];
// HPOP returns whole intervals covering the request; the margin covers
// TDB - UTC (69 s) so the UTC window is inside them.
const MARGIN_DAYS = 2 / 1440;
if (o.propagator === 'hpop') {
  const catalog = [];
  for (let at = 0; at < catalogBytes.length;) {
    const n = catalogBytes.readUInt32BE(at);
    catalog.push(new Uint8Array(catalogBytes.subarray(at + 4, at + 4 + n)));
    at += 4 + n;
  }
  farm = await createHpopFarm({ catalog, modulesRoot: path.resolve(root, '../..'),
    workers: o['farm-workers'] ? Number(o['farm-workers']) : undefined });
  farmInfo = { workers: farm.workers, instances: farm.instances, deriveMs: farm.deriveMs, ingestMs: farm.ingestMs,
    epochStateExcluded: farm.excluded.length, windowExportMs: [] };
  process.stderr.write(`farm: ${farm.objects.length} objects, ${farm.workers} workers, ${farm.instances} HPOP instances\n`);
}
const pad = (n) => n + ((8 - (n % 8)) % 8);
async function windowFile(k) {
  const w = windows[k], t = performance.now();
  const { frames, dropped } = await farm.window(w.startJd - MARGIN_DAYS, w.durationDays + 2 * MARGIN_DAYS);
  farmInfo.windowExportMs[k] = performance.now() - t;
  const json = Buffer.from(JSON.stringify({ dropped: k === 0 ? [...farm.excluded.map((x) => ({ ...x, jd: w.startJd })), ...dropped] : dropped }));
  const out = Buffer.alloc(pad(4 + json.length) + frames.reduce((a, f) => a + pad(4 + f.length), 0));
  out.writeUInt32LE(json.length, 0); json.copy(out, 4);
  let at = pad(4 + json.length);
  for (const f of frames) { out.writeUInt32LE(f.length, at); out.set(f, at + 4); at = pad(at + 4 + f.length); }
  return out;
}
// Windows export in order, one ahead of the page.
function exportWindow(k) {
  if (k < windows.length && !exports[k]) exports[k] = (k ? exportWindow(k - 1) : Promise.resolve()).then(() => windowFile(k));
  return exports[k];
}
if (farm) exportWindow(0);

const bundle = await build({
  entryPoints: [path.join(example, 'worker.mjs')], bundle: true, write: false, format: 'esm', platform: 'browser',
  target: 'chrome120', external: ['node:*'], loader: { '.wgsl': 'text' }, logLevel: 'silent',
});
const files = {
  '/': [fs.readFileSync(path.join(example, 'index.html')), 'text/html'],
  '/worker.js': [bundle.outputFiles[0].contents, 'text/javascript'],
  '/module.wasm': [fs.readFileSync(path.join(root, 'dist/isomorphic/module.wasm')), 'application/wasm'],
  '/catalog.bin': [catalogBytes, 'application/octet-stream'],
  ...(farm ? { '/objects': [JSON.stringify(farm.objects), 'application/json'] } : {}),
};
const headers = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cache-Control': 'no-store' };

let resolveDone, rejectDone;
const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'POST' && url.pathname === '/progress') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { process.stderr.write(`\r${Buffer.concat(chunks)}   `); res.writeHead(200, headers); res.end(); });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/done') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, headers); res.end();
      try { const body = JSON.parse(Buffer.concat(chunks)); body.fatal ? rejectDone(new Error(body.fatal)) : resolveDone(body); }
      catch (error) { rejectDone(error); }
    });
    return;
  }
  const windowMatch = /^\/window\/(\d+)$/.exec(url.pathname);
  if (farm && windowMatch) {
    const k = Number(windowMatch[1]);
    exportWindow(k).then((bytes) => {
      exportWindow(k + 1);
      exports[k] = null;   // served: let it go
      res.writeHead(200, { ...headers, 'Content-Type': 'application/octet-stream' }); res.end(bytes);
    }, (error) => { res.writeHead(500, headers); res.end(String(error)); rejectDone(error); });
    return;
  }
  let file = files[url.pathname];
  if (!file && url.pathname.startsWith('/sdk/')) {
    const resource = path.resolve(sdkSource, url.pathname.slice(5));
    if (resource.startsWith(sdkSource + path.sep) && fs.existsSync(resource) && fs.statSync(resource).isFile()) {
      file = [fs.readFileSync(resource), 'text/javascript'];
    }
  }
  if (!file) { res.writeHead(404, headers); res.end(); return; }
  res.writeHead(200, { ...headers, 'Content-Type': file[1] });
  res.end(file[0]);
});
await new Promise((resolve) => server.listen(Number(o.port), '127.0.0.1', resolve));
const query = new URLSearchParams({ propagator: o.propagator, startJd: o.start, durationDays: o.days, windowHours,
  thresholdKm: o['threshold-km'], coarseStepSec: o['step-s'], ...(o.cpu ? { cpu: '1' } : {}) });
const pageUrl = `http://127.0.0.1:${server.address().port}/?${query}`;

if (o.serve) {
  console.log(`Open ${pageUrl} in a WebGPU browser. Ctrl-C stops the server.`);
} else {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-gpu-chrome-'));
  const chrome = spawn(await resolveChromeBinary(), ['--headless=new', '--enable-unsafe-webgpu', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--disable-sync',
    `--user-data-dir=${profile}`, `${pageUrl}&auto&report`], { stdio: ['ignore', 'ignore', 'pipe'] });
  const diagnostics = [];
  chrome.stderr.on('data', (bytes) => diagnostics.push(bytes));
  chrome.on('error', rejectDone);
  chrome.on('exit', (code, signal) => rejectDone(new Error(`Chrome exited ${code}/${signal}: ${Buffer.concat(diagnostics).toString().slice(-2000)}`)));
  const timeout = setTimeout(() => rejectDone(new Error(`No result after ${o['timeout-s']} s.`)), Number(o['timeout-s']) * 1000);
  try {
    const result = await done;
    process.stderr.write('\n');
    const wallMs = performance.now() - t0;
    const summary = { catalog: path.basename(o.catalog), startJd: +o.start, durationDays: +o.days, windowHours, thresholdKm: +o['threshold-km'],
      coarseStepSec: +o['step-s'], wallMs, farm: farmInfo, ...result };
    if (o.out) fs.writeFileSync(o.out, JSON.stringify(summary, null, 1) + '\n');
    const t = result.timings, s = (ms) => (ms / 1000).toFixed(1) + ' s';
    console.log(`${result.propagator}: ${result.objects} objects, ${o.days} days in ${result.windows.length} windows: ` +
      `${result.candidates} candidates, ${result.events.length} conjunctions, ${result.excluded.length} excluded, ${s(wallMs)} end to end ` +
      `(page ${s(t.totalMs)}: load ${s(t.loadMs)}, window prep/wait ${s(t.prepareMs)}, grid ${s(t.gridMs)}, GPU ${s(t.gpuMs)}, refine ${s(t.refineMs)}` +
      (farmInfo ? `; farm: derive ${s(farmInfo.deriveMs)}, ingest ${s(farmInfo.ingestMs)}, exports ${s(farmInfo.windowExportMs.reduce((a, b) => a + (b ?? 0), 0))}` : '') +
      `; ${result.adapter})`);
  } finally {
    clearTimeout(timeout);
    chrome.removeAllListeners('exit');
    if (chrome.exitCode === null && chrome.signalCode === null) await new Promise((r) => { chrome.once('exit', r); chrome.kill('SIGKILL'); });
    server.close();
    await farm?.close();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

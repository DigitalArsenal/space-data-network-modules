// Serves examples/all-vs-all-gpu with cross-origin isolation and runs it in
// headless Chrome with WebGPU, or leaves it up for a browser (--serve).
//
// usage: node scripts/run-all-vs-all-gpu.mjs --catalog <omm.uint32be.bin>
//          [--start <jd>] [--days 1] [--threshold-km 5] [--step-s 60]
//          [--out summary.json] [--serve] [--port 0] [--timeout-s 3600]
// The catalog is $OMM records, each prefixed by its u32 big-endian length.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const example = path.join(root, 'examples/all-vs-all-gpu');
const sdkTesting = path.dirname(fileURLToPath(import.meta.resolve('space-data-module-sdk/testing')));
const sdkSource = path.resolve(sdkTesting, '..');
const { resolveChromeBinary } = await import(path.join(sdkTesting, 'parityLanes.js'));

const { values: o } = parseArgs({ options: {
  catalog: { type: 'string' }, start: { type: 'string', default: '2461314.5' }, days: { type: 'string', default: '1' },
  'threshold-km': { type: 'string', default: '5' }, 'step-s': { type: 'string', default: '60' },
  out: { type: 'string' }, serve: { type: 'boolean', default: false }, port: { type: 'string', default: '0' },
  'timeout-s': { type: 'string', default: '3600' },
} });
if (!o.catalog) throw new Error('--catalog <omm.uint32be.bin> is required.');

const bundle = await build({
  entryPoints: [path.join(example, 'worker.mjs')], bundle: true, write: false, format: 'esm', platform: 'browser',
  target: 'chrome120', external: ['node:*'], loader: { '.wgsl': 'text' }, logLevel: 'silent',
});
const files = {
  '/': [fs.readFileSync(path.join(example, 'index.html')), 'text/html'],
  '/worker.js': [bundle.outputFiles[0].contents, 'text/javascript'],
  '/module.wasm': [fs.readFileSync(path.join(root, 'dist/isomorphic/module.wasm')), 'application/wasm'],
  '/catalog.bin': [fs.readFileSync(o.catalog), 'application/octet-stream'],
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
const query = new URLSearchParams({ startJd: o.start, durationDays: o.days, thresholdKm: o['threshold-km'], coarseStepSec: o['step-s'] });
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
    const summary = { catalog: path.basename(o.catalog), startJd: +o.start, durationDays: +o.days, thresholdKm: +o['threshold-km'],
      coarseStepSec: +o['step-s'], ...result };
    if (o.out) fs.writeFileSync(o.out, JSON.stringify(summary, null, 1) + '\n');
    const t = result.timings, s = (ms) => (ms / 1000).toFixed(1) + ' s';
    console.log(`${result.objects} objects x ${result.coarseSteps} steps: ${result.candidates} GPU candidates, ` +
      `${result.events.length} conjunctions in ${s(t.totalMs)} (grid ${s(t.gridMs)}, GPU ${s(t.gpuMs)}, refine ${s(t.refineMs)}; ${result.adapter})`);
  } finally {
    clearTimeout(timeout);
    chrome.removeAllListeners('exit');
    if (chrome.exitCode === null && chrome.signalCode === null) await new Promise((r) => { chrome.once('exit', r); chrome.kill('SIGKILL'); });
    server.close();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

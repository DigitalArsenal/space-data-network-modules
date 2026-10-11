#!/usr/bin/env node
// Three-runtime parity of continuous screening's resident calls, on one
// persistent instance per runtime: real Chrome (V8, wasi-threads in a
// Worker), native WasmEdge and Docker WasmEdge (the standard wasi-threads
// host), plus Node's V8, which derives the dependent inputs. The sequence:
// an index of invented element sets (tests/lib/syntheticCatalog.mjs), the
// window's coarse grid, search_grid all-vs-all and with roles (1 and 4
// module threads), search_candidates on the same block, a one-source grid
// (one updated object's rows), a sub-index of the objects the candidates
// name, refine_candidates on it, and two refused requests. Every response
// must be byte-identical across the runtimes; search_grid's candidates must
// contain search_candidates' on the same block (its f32 slack proposes a
// superset); roles must not depend on the thread count. With
// CA_WASMEDGE_AOTC and CA_WASMEDGE_AOT_RUNNER (an AOT compiler taking
// (in, out) and the wasi-threads runner, both linked against SDN's patched
// WasmEdge), a fifth lane runs the module ahead-of-time compiled, as SDN
// nodes do. Writes docs/continuous-screening-parity.json.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import * as flatbuffers from 'flatbuffers';
import { CQR } from 'spacedatastandards.org/lib/js/CQR/main.js';
import { encodePluginInvokeRequest, decodePluginInvokeResponse } from 'space-data-module-sdk/invoke';
import { createModuleHarness } from 'space-data-module-sdk/testing';
import { createConjunctionCommandHarness } from '../tests/lib/conjunctionCommandHarness.mjs';
import { aotModule } from './lib/aot.mjs';
import { syntheticGp } from '../tests/lib/syntheticCatalog.mjs';
import { createOmmEncoder } from './lib/ommCatalog.mjs';
import { indexInputs, sgp4Sources, windowRequest, screenWindows } from '../gpu/catalogScreen.mjs';
import { blockFrame, candidatesFrame, control, excludedFrame, sds, sortTriples } from '../gpu/allVsAll.mjs';
import { ROLE, rolesFrame } from '../gpu/continuousScreen.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wasmPath = path.join(root, 'dist/isomorphic/module.wasm');
const wasm = fs.readFileSync(wasmPath);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sdkTesting = path.dirname(fileURLToPath(import.meta.resolve('space-data-module-sdk/testing')));
const sdkSource = path.resolve(sdkTesting, '..');

// The plan: each step a request, built from earlier responses where it needs them.
const encode = await createOmmEncoder();
const frames = syntheticGp().map(encode);
const sources = sgp4Sources(frames);
const [window] = screenWindows(2461314.5, 1 / 24, 1);
const controls = (workers) => ({ thresholdKm: 20, coarseStepSec: 60, workers });
const request = (handle, workers = 1) => sds('request', 'CQR', windowRequest(handle, 'TEME', window, controls(workers)));
const grid = (bytes) => control('grid', 'application/vnd.sdn.ca-coarse-grid', bytes);
const block = (first, count) => control('block', 'application/vnd.sdn.ca-grid-block', blockFrame(first, count));
const roles = new Uint8Array(frames.length);
for (let i = 0; i < roles.length; i++) roles[i] = i % 9 === 0 ? ROLE.PRIMARY : i % 13 === 0 ? ROLE.SKIP : ROLE.SECONDARY;
const scope = control('roles', 'application/vnd.sdn.ca-roles', rolesFrame(roles));
const port = (response, id) => response.outputs.find((x) => x.portId === id)?.payload;
const triples = (frame) => { const n = new DataView(frame.buffer, frame.byteOffset).getUint32(4, true); return new Uint32Array(frame.slice(8, 8 + n * 12).buffer); };

const node = await createConjunctionCommandHarness({ runtimeKind: 'browser' });
const steps = [], responses = [];
async function step(label, methodId, inputs, expectError = null) {
  const bytes = encodePluginInvokeRequest({ methodId, inputs });
  const response = decodePluginInvokeResponse(await node.invokeRaw(bytes));
  steps.push({ label, bytes, expectError });
  responses.push(response);
  return response;
}
await step('prepare-catalog', 'prepare_screening_index', indexInputs(sources));          // handle 1
const first = await step('grid-step-0', 'coarse_grid', [request(1), block(0, 1)]);
const last = JSON.parse(new TextDecoder().decode(port(first, 'report'))).last_step;
const grids = [port(first, 'grid')];
for (let at = 1; at <= last; at += 32) grids.push(port(await step(`grid-steps-${at}`, 'coarse_grid', [request(1), block(at, Math.min(32, last - at + 1))]), 'grid'));
const all = [], scoped = [];
for (const [b, g] of grids.entries()) all.push(triples(port(await step(`search-grid-all-${b}`, 'search_grid', [request(1), grid(g)]), 'candidates')));
for (const [b, g] of grids.entries()) scoped.push(triples(port(await step(`search-grid-roles-${b}`, 'search_grid', [request(1), grid(g), scope]), 'candidates')));
for (const [b, g] of grids.entries()) await step(`search-grid-roles-4-threads-${b}`, 'search_grid', [request(1, 4), grid(g), scope]);
const fresh = triples(port(await step('search-candidates-steps-1', 'search_candidates', [request(1), block(1, Math.min(32, last))]), 'candidates'));
await step('prepare-one-source', 'prepare_screening_index', indexInputs([sources[9]]));  // handle 2
await step('grid-one-source', 'coarse_grid', [request(2), block(0, 1)]);
// A sub-index of the rows the scoped candidates name, in grid order.
const scopedAll = new Uint32Array(scoped.reduce((s, t) => s + t.length, 0));
scoped.reduce((at, t) => (scopedAll.set(t, at), at + t.length), 0);
const position = new Int32Array(frames.length).fill(-1), rows = [];
for (let q = 0; q < scopedAll.length; q += 3) { position[scopedAll[q]] = 0; position[scopedAll[q + 1]] = 0; }
for (let r = 0; r < frames.length; r++) if (position[r] === 0) { position[r] = rows.length; rows.push(r); }
for (let q = 0; q < scopedAll.length; q += 3) { scopedAll[q] = position[scopedAll[q]]; scopedAll[q + 1] = position[scopedAll[q + 1]]; }
const excluded = new Map();
const report = JSON.parse(new TextDecoder().decode(port(first, 'report')));
for (const x of report.excluded) if (position[x.index] >= 0) excluded.set(position[x.index], x.first_failure_jd);
const sorted = sortTriples(scopedAll, rows.length);
await step('prepare-sub-index', 'prepare_screening_index', indexInputs(rows.map((r) => sources[r])));   // handle 3
const refine = [request(3), control('candidates', 'application/vnd.sdn.ca-candidates', candidatesFrame(sorted, 0, sorted.length)),
  control('excluded', 'application/vnd.sdn.ca-excluded', excludedFrame(excluded))];
for (let chunk = 0; ; chunk++) {
  const response = await step(`refine-sub-index-${chunk}`, 'refine_candidates', refine);
  assert.equal(response.statusCode, 0, response.errorMessage);
  if (!port(response, 'result') || chunk > 64) break;
  if (CQR.getRootAsCQR(new flatbuffers.ByteBuffer(port(response, 'result'))).CATALOG_RESULT().FINAL_CHUNK()) break;
}
await step('refuse-roles-count', 'search_grid', [request(1), grid(grids[1]), control('roles', 'application/vnd.sdn.ca-roles', rolesFrame(roles.subarray(1)))], 'invalid-roles');
await step('refuse-truncated-grid', 'search_grid', [request(1), grid(grids[1].subarray(0, grids[1].length - 4))], 'invalid-grid');
await node.destroy?.();

// Physical outcomes on the Node run.
for (const [i, s] of steps.entries()) {
  const r = responses[i];
  if (s.expectError) assert.equal(r.errorCode, s.expectError, s.label);
  else assert.equal(r.statusCode, 0, `${s.label}: ${r.errorCode} ${r.errorMessage}`);
}
const key = (t, q) => `${t[q]}:${t[q + 1]}:${t[q + 2]}`;
// The same steps (grids[1] holds steps 1..32): search_grid proposes every candidate search_candidates finds.
const allSet = new Set(Array.from({ length: all[1].length / 3 }, (_, q) => key(all[1], 3 * q)));
const freshSet = new Set(Array.from({ length: fresh.length / 3 }, (_, q) => key(fresh, 3 * q)));
const missing = [...freshSet].filter((k) => !allSet.has(k));
assert.equal(missing.length, 0, `search_grid misses ${missing.length} of search_candidates' candidates`);
for (const [b] of grids.entries()) {
  const a = steps.findIndex((s) => s.label === `search-grid-roles-${b}`), c = steps.findIndex((s) => s.label === `search-grid-roles-4-threads-${b}`);
  assert.deepEqual(Buffer.from(port(responses[a], 'candidates')), Buffer.from(port(responses[c], 'candidates')), `roles block ${b}: 1 vs 4 threads`);
}
console.log(`node: ${steps.length} requests; on steps 1..32 search_grid proposes ${allSet.size} candidates, search_candidates ${freshSet.size}, none missing; ` +
  `scoped refine on ${rows.length} of ${frames.length} objects`);

// The same request bytes on one persistent instance per runtime.
async function persistent(runtimeKind) {
  const h = runtimeKind === 'wasmedge-aot'
    ? await createModuleHarness({ runtime: { kind: 'wasmedge', launchPlan: { command: process.env.CA_WASMEDGE_AOT_RUNNER,
      args: [aotModule(wasmPath, process.env.CA_WASMEDGE_AOTC, []), '--serve-plugin-invoke'], cwd: root, env: process.env } } })
    : await createConjunctionCommandHarness({ runtimeKind, surface: 'direct' });
  try { const out = []; for (const s of steps) out.push(new Uint8Array(await h.invokeRaw(s.bytes))); return out; }
  finally { await h.destroy?.(); }
}
async function chrome() {
  const chromeBinary = process.env.SDM_CHROME_BINARY ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium']
    .find((p) => fs.existsSync(p));
  if (!chromeBinary) throw new Error('Real Chrome required; set SDM_CHROME_BINARY.');
  const worker = `import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
    import { setBrowserWasiThreadWorkerBase } from ${JSON.stringify(path.join(sdkSource, 'host/wasiThreadHost.js'))};
    setBrowserWasiThreadWorkerBase('/sdk/host/');
    self.onmessage = async ({ data }) => {
      try {
        const h = await createBrowserModuleHarness({ wasmSource: data.wasm, surface: 'direct', wasiThreadWorkerBaseUrl: '/sdk/host/',
          enableBrowserWasiThreads: true, maxThreads: 16 });
        const out = [];
        try { for (const bytes of data.requests) out.push(await h.invokeRaw(bytes)); } finally { h.destroy(); }
        self.postMessage({ out });
      } catch (error) { self.postMessage({ error: String(error?.stack ?? error) }); }
    };`;
  const bundle = await build({ stdin: { contents: worker, resolveDir: root, sourcefile: 'continuous-parity-worker.mjs' }, bundle: true, write: false,
    format: 'esm', platform: 'browser', target: 'chrome110', external: ['node:*'], logLevel: 'silent' });
  const page = `<!doctype html><script type="module">
    const b64 = (x) => Uint8Array.from(atob(x), (c) => c.charCodeAt(0));
    const out = (x) => { let s = ''; for (const n of x) s += String.fromCharCode(n); return btoa(s); };
    try {
      if (!crossOriginIsolated) throw Error('COOP/COEP isolation missing');
      const requests = (await (await fetch('/plan')).json()).map(b64);
      const wasm = new Uint8Array(await (await fetch('/module.wasm')).arrayBuffer());
      const w = new Worker('/worker.js', { type: 'module' });
      const result = await new Promise((resolve, reject) => { w.onmessage = (e) => resolve(e.data); w.onerror = (e) => reject(Error(e.message)); w.postMessage({ wasm, requests }); });
      await fetch('/done', { method: 'POST', body: JSON.stringify(result.error ? { error: result.error } : { out: result.out.map(out) }) });
    } catch (error) { await fetch('/done', { method: 'POST', body: JSON.stringify({ error: String(error) }) }); }
  </script>`;
  let resolve, reject;
  const done = new Promise((a, b) => { resolve = a; reject = b; });
  const headers = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cache-Control': 'no-store' };
  const plan = JSON.stringify(steps.map((s) => Buffer.from(s.bytes).toString('base64')));
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'POST' && url.pathname === '/done') {
      const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
        res.writeHead(200, headers); res.end('ok');
        try { const body = JSON.parse(Buffer.concat(chunks)); body.error ? reject(Error(body.error)) : resolve(body.out.map((x) => new Uint8Array(Buffer.from(x, 'base64')))); }
        catch (error) { reject(error); }
      }); return;
    }
    let body, mime = 'text/javascript';
    if (url.pathname === '/') { body = page; mime = 'text/html'; }
    else if (url.pathname === '/worker.js') body = bundle.outputFiles[0].text;
    else if (url.pathname === '/plan') { body = plan; mime = 'application/json'; }
    else if (url.pathname === '/module.wasm') { body = wasm; mime = 'application/wasm'; }
    else if (url.pathname.startsWith('/sdk/')) {
      const file = path.resolve(sdkSource, url.pathname.slice(5));
      if (file.startsWith(sdkSource + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) body = fs.readFileSync(file);
    }
    if (body === undefined) { res.writeHead(404, headers); res.end(); return; }
    res.writeHead(200, { ...headers, 'Content-Type': mime }); res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-continuous-parity-'));
  const child = spawn(chromeBinary, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    `--user-data-dir=${profile}`, `http://127.0.0.1:${server.address().port}/`], { stdio: ['ignore', 'ignore', 'pipe'] });
  const diagnostics = []; child.stderr.on('data', (x) => diagnostics.push(x)); child.on('error', reject);
  const timeout = setTimeout(() => reject(Error(`Chrome timed out: ${Buffer.concat(diagnostics).toString().slice(-1000)}`)), 300000);
  try { return await done; }
  finally {
    clearTimeout(timeout);
    await new Promise((r) => { child.once('exit', r); child.kill('SIGKILL'); });
    server.closeAllConnections(); await new Promise((r) => server.close(r));
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

const nodeBytes = [];
{ const h = await createConjunctionCommandHarness({ runtimeKind: 'browser' });
  try { for (const s of steps) nodeBytes.push(new Uint8Array(await h.invokeRaw(s.bytes))); } finally { await h.destroy?.(); } }
const lanes = { 'node-v8': nodeBytes, chrome: await chrome(), wasmedge: await persistent('wasmedge'), 'docker-wasmedge': await persistent('docker-wasmedge'),
  ...(process.env.CA_WASMEDGE_AOTC && process.env.CA_WASMEDGE_AOT_RUNNER ? { 'wasmedge-aot-sdn-patched': await persistent('wasmedge-aot') } : {}) };
for (const [name, out] of Object.entries(lanes)) {
  assert.equal(out.length, steps.length, name);
  for (let i = 0; i < steps.length; i++) assert.deepEqual(Buffer.from(out[i]), Buffer.from(nodeBytes[i]), `${name}: ${steps[i].label}`);
  console.log(`${name}: ${out.length} responses byte-identical`);
}
const evidence = { wasmSha256: sha(wasm), wasmBytes: wasm.length, runtimes: Object.keys(lanes), instance: 'one persistent direct instance per runtime',
  catalog: 'tests/lib/syntheticCatalog.mjs (invented)', objects: frames.length, window: { startJd: window.startJd, hours: 1 },
  steps: steps.map((s, i) => ({ label: s.label, requestSha256: sha(s.bytes), responseSha256: sha(nodeBytes[i]), errorCode: responses[i].errorCode || null })),
  outcomes: { steps: '1..32', searchGridCandidates: allSet.size, searchCandidatesCandidates: freshSet.size, searchCandidatesMissing: 0,
    rolesThreadIndependent: true, subIndexObjects: rows.length } };
fs.writeFileSync(path.join(root, 'docs/continuous-screening-parity.json'), JSON.stringify(evidence, null, 1) + '\n');
console.log(`PASS continuous screening parity: ${steps.length} requests x ${Object.keys(lanes).length} runtimes; module ${evidence.wasmSha256}`);

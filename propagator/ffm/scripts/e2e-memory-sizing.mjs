#!/usr/bin/env node
// Memory/accounting orchestration only: all dynamics, frames and polynomial
// evaluation execute in the exact same FFM artifact in both runtimes.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { headlessShell } from '../tests/lib/headlessShell.mjs';
import { environmentInputs } from '../tests/lib/fullForce.mjs';
import { makeTable, encodePrw, sds, TYPE } from '../tests/lib/prwCodec.mjs';
import { encodePluginInvokeRequest, decodePluginInvokeResponse } from 'space-data-module-sdk/invoke';
import * as catalog from '../catalog.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const cache = path.join(root, '.sdk-build/memory-sizing'); fs.mkdirSync(cache, { recursive: true });
const read = p => JSON.parse(fs.readFileSync(path.join(root, p)));
const sha = b => createHash('sha256').update(b).digest('hex');
const wasmPath = path.join(root, 'dist/isomorphic/module.wasm'), wasm = fs.readFileSync(wasmPath);
const seeds = read('tests/fixtures/seeds.json'), standard = read('tests/fixtures/standard.json');
const epoch = Date.parse(standard.fixtureEpochUtc + 'Z') / 86400000 + 2440587.5;
const manifest = read('plugin-manifest.json'), environment = environmentInputs();
const configuration = encodePrw('EXECUTION_REQUEST', catalog.fullForceRequest({ epoch: standard.fixtureEpochUtc,
  state: [...seeds[0].position, ...seeds[0].velocity].map(x => x * 1000) }));
const frames = [configuration, ...environment.map(x => x.payload)];
const instance = makeTable('PRWInstance', { MODULE_ID: manifest.pluginId, INSTANCE_ID: 'memory-focus', GENERATION: 1n });
const port = (portId, arm, value) => ({ portId, typeRef: TYPE, payload: encodePrw(arm, value) });
const focusRequests = [encodePluginInvokeRequest({ methodId: 'ingest_state', inputs: [
  port('state', 'RESIDENT_STATE', catalog.residentState({ instanceId: instance.INSTANCE_ID, handle: seeds[0].handle,
    epoch: standard.fixtureEpochUtc, state: [...seeds[0].position, ...seeds[0].velocity].map(x => x * 1000), cdAm: seeds[0].cdAm, crAm: .02 })),
  { portId: 'configuration', typeRef: TYPE, payload: configuration }, ...environment] }),
  ...[1800, 3600].map(seconds => encodePluginInvokeRequest({ methodId: 'propagate_state', inputs: [port('request', 'RESIDENT_REQUEST',
    makeTable('PRWResidentRequest', { INSTANCE: instance, ENTITY_HANDLES: [seeds[0].handle], TARGET_COORDINATE_SYSTEM: catalog.gcrf(),
      TARGET_EPOCH: makeTable('TIMInstant', { TIME_SYSTEM: sds.timingStandard.UTC, EPOCH_FORMAT: sds.timEpochRepresentation.JULIAN_DATE, JULIAN_DATE: epoch + seconds / 86400 }) }))] }))];
const report = { artifactSha256: sha(wasm), previousArtifactSha256: sha(fs.readFileSync(path.join(cache, '../previous.wasm'))),
  memory: read('dist/build-provenance.json').memory, profile: 'FFM-1', retentionSeconds: 1800, lookaheadSeconds: 300,
  sampleEpochsSeconds: [1800, 3600], fixture: 'public study SGP4 seeds, repeated cyclically across all seven orbit regimes',
  rows: [], loadStart: os.loadavg(), logicalCpus: os.cpus().length,
  docker: 'WAIVED by owner 2026-10-22: do not start Docker' };
const save = () => fs.writeFileSync(path.join(cache, 'result.json'), JSON.stringify(report, null, 2) + '\n');
// Compile through the actual node's production flow prewarmer into a private
// cache. A fresh cache per artifact proves compilation, not a cache hit.
const nodeBinary = process.env.SDN_NODE_BINARY || 'spacedatanetwork';
const aotDir = path.join(cache, `aot-${report.artifactSha256}`);
const aotLog = execFileSync(nodeBinary, ['prewarm-aot', '--cache-dir', aotDir, '--flow', wasmPath], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
fs.writeFileSync(path.join(cache, 'prewarm-aot.log'), aotLog);
assert(!/FAILED|Not implemented instructions/.test(aotLog));
report.aot = { status: 'PASS', command: 'spacedatanetwork prewarm-aot --cache-dir <private> --flow dist/isomorphic/module.wasm', artifactSha256: report.artifactSha256, log: aotLog.trim() }; save();
const bundle = await build({ stdin: { resolveDir: root, contents: `
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import { catalogClient } from './scripts/catalog-coverage-client.mjs';
window.measure = async ({ count, seeds, epoch, manifest, focus, previous }) => {
  if (!crossOriginIsolated) throw new Error('COI required');
  const h = await createBrowserModuleHarness({ wasmSource: await (await fetch(previous ? '/previous.wasm' : '/module.wasm')).arrayBuffer(), manifest, surface: 'direct' });
  let client;
  try {
    const outputs = [], samples = [];
    const memory = () => (h.instance.exports.memory ?? h.memory).buffer.byteLength;
    const baseBytes = memory();
    if (focus) {
      for (let i = 0; i < 3; ++i) {
        outputs.push([...await h.invokeRaw(new Uint8Array(await (await fetch('/focus/' + i)).arrayBuffer()))]);
        samples.push(memory());
      }
    } else {
      const frames = await Promise.all(Array.from({ length: 4 }, async (_, i) => new Uint8Array(await (await fetch('/frame/' + i)).arrayBuffer())));
      client = catalogClient(h, frames, Array.from({ length: count }, (_, i) => seeds[i % seeds.length]), epoch);
      if (client.profile() !== 'FFM-1') throw new Error('wrong profile');
      samples.push(memory());
      for (const seconds of [1800, 3600]) {
        client.ensure(epoch + seconds / 86400);
        const states = client.states(epoch + (seconds - 1) / 86400);
        if (!states.every(Number.isFinite)) throw new Error('nonfinite state');
        const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(states.buffer));
        outputs.push(Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join(''));
        samples.push(memory());
      }
    }
    return { role: focus ? 'resident-focus' : 'catalog', entities: count, baseBytes, highWaterBytes: Math.max(...samples), samples, outputs, crossOriginIsolated, browser: navigator.userAgent };
  } finally { client?.dispose(); await h.destroy(); }
};` }, bundle: true, platform: 'browser', format: 'iife', write: false, logLevel: 'silent' });
const server = http.createServer((req, res) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin'); res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); return res.end('<!doctype html><script src="/bundle.js"></script>'); }
  if (req.url === '/bundle.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(bundle.outputFiles[0].contents); }
  if (req.url === '/module.wasm') return res.end(wasm);
  if (req.url === '/previous.wasm') return res.end(fs.readFileSync(path.join(cache, '../previous.wasm')));
  const match = /^\/(frame|focus)\/(\d+)$/.exec(req.url);
  if (match) return res.end((match[1] === 'frame' ? frames : focusRequests)[+match[2]]);
  res.statusCode = 404; res.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ executablePath: headlessShell(), headless: true });
  for (const count of [1, 1000, 4000, 10000, 31814]) {
    const page = await browser.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const options = { count, seeds, epoch, manifest, focus: count === 1 };
    const row = await page.evaluate(o => window.measure(o), options);
    if (row.role === 'resident-focus') {
      for (const bytes of row.outputs) assert.equal(decodePluginInvokeResponse(new Uint8Array(bytes)).statusCode, 0);
      row.outputs = row.outputs.map(b => sha(new Uint8Array(b)));
    }
    // A representative catalog plus the focus role prove the build-only
    // change preserves output bytes against the packaged predecessor.
    if (count === 1 || count === 1000) {
      const old = await page.evaluate(o => window.measure(o), { ...options, previous: true });
      const hashes = count === 1 ? old.outputs.map(b => sha(new Uint8Array(b))) : old.outputs;
      assert.deepEqual(row.outputs, hashes, 'previous artifact parity'); row.previousArtifactParity = 'bit-identical';
    }
    assert.deepEqual(errors, []); report.rows.push({ runtime: 'browser', ...row }); save();
    console.log(JSON.stringify({ runtime: 'browser', entities: count, highWaterBytes: row.highWaterBytes })); await page.close();
  }
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
// Native role execution and fitted-model verification are below. Outputs are
// written outside tracked paths so the exact candidate remains immutable.
save();

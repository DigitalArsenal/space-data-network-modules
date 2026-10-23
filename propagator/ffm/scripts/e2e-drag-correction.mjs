#!/usr/bin/env node
// End-to-end published DCL -> configured FFM -> catalog/resident trajectory.
// Closed-form reference: exp(ln 2)=2, exp(ln 8)=8, midpoint exp(ln 4)=4.
// GCRF SI; UTC input; ratio tolerance 1e-12 covers binary64 rounding only.
// JS marshals and scores output; every force, frame and trajectory runs in WASM.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
import { build } from 'esbuild';
import { chromium } from 'playwright';
import * as flatbuffers from 'flatbuffers';
import * as D from 'spacedatastandards.org/lib/js/DCL/main.js';
import { encodePluginInvokeRequest, decodePluginInvokeResponse } from 'space-data-module-sdk/invoke';
import { headlessShell } from '../tests/lib/headlessShell.mjs';
import { residentHarness } from '../tests/lib/residentRuntime.mjs';
import { environmentInputs } from '../tests/lib/fullForce.mjs';
import { makeTable, encodePrw, decodePrw, sds, TYPE } from '../tests/lib/prwCodec.mjs';
import * as catalog from '../catalog.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const read = file => JSON.parse(fs.readFileSync(path.join(root, file)));
const wasmPath = path.join(root, 'dist/isomorphic/module.wasm');
const wasm = fs.readFileSync(wasmPath), manifest = read('plugin-manifest.json');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const cache = path.join(root, '.sdk-build/drag-correction'); fs.mkdirSync(cache, { recursive: true });
const aotDir = path.join(root, '.sdk-build/memory-sizing/aot');
const seed = read('tests/fixtures/seeds.json')[0], standard = read('tests/fixtures/standard.json');
const epochMs = Date.parse(standard.fixtureEpochUtc + 'Z'), epoch = epochMs / 86400000 + 2440587.5;
const offsets = [0, 675, 1012.5, 1350, 1687.5, 2025, 2700]; // exact binary Julian-day fractions
const epochs = offsets.map(s => epoch + s / 86400);
const environment = environmentInputs();
const configuration = encodePrw('EXECUTION_REQUEST', catalog.fullForceRequest({ epoch: standard.fixtureEpochUtc,
  state: [...seed.position, ...seed.velocity].map(x => x * 1000) }));
const frames = [configuration, ...environment.map(x => x.payload)];
const table = (name, fields) => Object.assign(new D[`${name}T`](), fields);
const times = [675, 1350, 2025].map(s => BigInt(epochMs + s * 1000));
const ln2 = 0.6931471805599453, ln8 = 2.0794415416798357;
function dcl(values, changes = {}, prefixed = false) {
  const b = new flatbuffers.Builder(512);
  const correction = table('dclCorrection', { FORM: D.dclCorrectionForm.LogDensityNodes, NODE_TIMES_MS: times,
    NODE_LOG_DENSITY_SCALE_DIMENSIONLESS: values, ...changes });
  const value = table('DCL', { STATUS: D.dclStatus.Solved, ATMOSPHERE: table('ATM', { MODEL: D.AtmosphericModelFamily.NRLMSIS00E }), CORRECTION: correction });
  if (prefixed) D.DCL.finishSizePrefixedDCLBuffer(b, value.pack(b)); else D.DCL.finishDCLBuffer(b, value.pack(b));
  return b.asUint8Array().slice();
}
const cases = [
  { name: 'absent', factors: offsets.map(() => 1) },
  { name: 'zero', values: [0, 0, 0], factors: offsets.map(() => 1) },
  { name: 'constant', values: [ln2, ln2, ln2], factors: offsets.map(() => 2) },
  { name: 'nodes', values: [ln2, ln8, ln2], factors: [2, 2, 4, 8, 4, 2, 2] },
];
const correctionType = { schemaName: 'DCL.fbs', fileIdentifier: '$DCL', rootTypeName: 'DCL', wireFormat: 'flatbuffer' };
const instance = makeTable('PRWInstance', { MODULE_ID: manifest.pluginId, INSTANCE_ID: 'drag-correction', GENERATION: 1n });
const port = (portId, arm, value) => ({ portId, typeRef: TYPE, payload: encodePrw(arm, value) });
// Same ballistic coefficient as the public seed; the module derives it below.
const ingestion = cdAm => [port('state', 'RESIDENT_STATE', catalog.residentState({ instanceId: instance.INSTANCE_ID, handle: seed.handle,
  epoch: standard.fixtureEpochUtc, state: [...seed.position, ...seed.velocity].map(x => x * 1000), cdAm, crAm: .02 })),
  { portId: 'configuration', typeRef: TYPE, payload: configuration }, ...environment];
const propagation = epochs.map(jd => encodePluginInvokeRequest({ methodId: 'propagate_state', inputs: [port('request', 'RESIDENT_REQUEST',
  makeTable('PRWResidentRequest', { INSTANCE: instance, ENTITY_HANDLES: [seed.handle], TARGET_COORDINATE_SYSTEM: catalog.gcrf(),
    TARGET_EPOCH: makeTable('TIMInstant', { TIME_SYSTEM: sds.timingStandard.UTC, EPOCH_FORMAT: sds.timEpochRepresentation.JULIAN_DATE, JULIAN_DATE: jd }) }))] }));
const bundle = await build({ stdin: { resolveDir: root, contents: `
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import { catalogClient } from './scripts/catalog-coverage-client.mjs';
const host = async manifest => createBrowserModuleHarness({ wasmSource: await (await fetch('/module.wasm')).arrayBuffer(), manifest, surface: 'direct' });
window.catalogCase = async ({manifest, frames, seed, epoch, epochs, states}) => {
 if (!crossOriginIsolated) throw new Error('COI required');
 const h = await host(manifest); let client;
 try {
  client = catalogClient(h, frames.map(f => new Uint8Array(f)), [seed], epoch);
  const x = h.instance.exports, p = x.plugin_alloc(48), out = x.plugin_alloc(24), memory = x.memory ?? h.memory;
  const rows = [];
  try {
   for (let i=0;i<epochs.length;i++) {
    client.ensure(epochs[i]); const actual = [...client.states(epochs[i])];
    new Float64Array(memory.buffer,p,6).set(states ? states[i] : actual);
    if (x.plugin_catalog_drag_acceleration(epochs[i],0,p,out)!==0) throw new Error('drag diagnosis failed');
    rows.push({state:actual,drag:[...new Float64Array(memory.buffer,out,3)]});
   }
   return {rows,cdAm:x.plugin_drag_area_over_mass_from_bstar(seed.bstar,.01)};
  } finally {x.plugin_free(p);x.plugin_free(out);}
 } finally {client?.dispose();await h.destroy();}
};
window.residentCase = async ({manifest,requests}) => {
 const h=await host(manifest);
 try {const out=[];for(const req of requests)out.push([...await h.invokeRaw(new Uint8Array(req))]);return out;}
 finally {await h.destroy();}
};
` }, bundle: true, platform: 'browser', format: 'iife', write: false, logLevel: 'silent' });
const server = http.createServer((req, res) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin'); res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><script src="/bundle.js"></script>'); }
  else if (req.url === '/bundle.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundle.outputFiles[0].contents); }
  else if (req.url === '/module.wasm') { res.setHeader('Content-Type', 'application/wasm'); res.end(wasm); }
  else { res.statusCode = 404; res.end(); }
});
const report = { artifactSha256: sha(wasm), memory: read('dist/build-provenance.json').memory, cases: [],
  reference: 'SDS 1.259.0 DCL LogDensityNodes; closed-form factors 1, 2, 4, 8; GCRF SI, UTC; relative acceleration tolerance 1e-12',
  docker: 'WAIVED by owner 2026-10-22' };
const regressionController = new AbortController();
const regressionWork = process.argv.includes('--correction-only') ? null : Promise.all(
  ['e2e-ffm.mjs', 'e2e-catalog-coverage.mjs'].map(async script => {
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [path.join(root, 'scripts', script)],
        { cwd: root, maxBuffer: 32 * 1024 * 1024, signal: regressionController.signal });
      fs.writeFileSync(path.join(cache, script + '.log'), stdout + stderr);
      return script;
    } catch (error) {
      fs.writeFileSync(path.join(cache, script + '.log'), (error.stdout || '') + (error.stderr || ''));
      throw error;
    }
  })).then(scripts => ({ scripts }), error => ({ error }));
let browser;
try {
  const aot = execFileSync(process.env.SDN_NODE_BINARY || path.join(root, '.sdk-build/spacedatanetwork'),
    ['prewarm-aot', '--cache-dir', aotDir, '--flow', wasmPath], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  assert(!/FAILED|Not implemented instructions/.test(aot));
  fs.writeFileSync(path.join(cache, 'prewarm-aot.log'), aot);
  report.aot = { status: 'PASS', runtime: 'WasmEdge 0.16.4', artifactSha256: sha(wasm) };
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ executablePath: headlessShell(), headless: true });
  const page = await browser.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  let baseline, baselineResident, initialInputs;
  for (const test of cases) {
    const caseFrames = test.values ? [...frames, dcl(test.values, {}, true)] : frames;
    const actual = await page.evaluate(o => window.catalogCase(o), { manifest, frames: caseFrames.map(b => [...b]), seed, epoch, epochs,
      states: baseline?.rows.map(r => r.state) });
    if (!baseline) baseline = actual;
    let maximumRelativeAccelerationError = 0;
    for (let i = 0; i < epochs.length; i++) for (let k = 0; k < 3; k++) {
      const expected = baseline.rows[i].drag[k] * test.factors[i];
      assert(Math.abs(expected) > 1e-30, 'fixture must exercise each drag component');
      maximumRelativeAccelerationError = Math.max(maximumRelativeAccelerationError, Math.abs(actual.rows[i].drag[k] / expected - 1));
    }
    assert(maximumRelativeAccelerationError <= 1e-12, `${test.name}: acceleration ratio ${maximumRelativeAccelerationError}`);
    initialInputs = ingestion(actual.cdAm);
    const requests = [encodePluginInvokeRequest({ methodId: 'ingest_state', inputs: [...initialInputs,
      ...(test.values ? [{ portId: 'density_correction', typeRef: correctionType, payload: dcl(test.values) }] : [])] }), ...propagation];
    const outputs = (await page.evaluate(o => window.residentCase(o), { manifest, requests: requests.map(b => [...b]) })).map(b => new Uint8Array(b));
    outputs.forEach(b => assert.equal(decodePluginInvokeResponse(b).statusCode, 0, decodePluginInvokeResponse(b).errorMessage));
    const native = await residentHarness('wasmedge');
    try { for (let i = 0; i < requests.length; i++) assert.equal(sha(await native.invokeRaw(requests[i])), sha(outputs[i]), `${test.name}: native/browser output ${i}`); }
    finally { await native.destroy(); }
    let maximumCatalogResidentErrorM = 0;
    for (let i = 0; i < epochs.length; i++) {
      const state = decodePrw(decodePluginInvokeResponse(outputs[i + 1]).outputs[0].payload).RESIDENT_STATE.STATE;
      const xyz = [state.POSITION.X, state.POSITION.Y, state.POSITION.Z];
      maximumCatalogResidentErrorM = Math.max(maximumCatalogResidentErrorM, ...xyz.map((v,k) => Math.abs(v-actual.rows[i].state[k])));
    }
    assert(maximumCatalogResidentErrorM < .01, `${test.name}: catalog/resident fit ${maximumCatalogResidentErrorM}`);
    if (test.name === 'absent') baselineResident = outputs.map(sha);
    if (test.name === 'zero') { assert.deepEqual(actual.rows, baseline.rows, 'zero catalog differs'); assert.deepEqual(outputs.map(sha), baselineResident, 'zero resident differs'); }
    if (test.name === 'constant' || test.name === 'nodes') assert.notDeepEqual(actual.rows.at(-1).state, baseline.rows.at(-1).state, 'correction did not affect trajectory');
    const row = { name: test.name, maximumRelativeAccelerationError, maximumCatalogResidentErrorM, nativeBrowserParity: 'byte-identical', residentHashes: outputs.map(sha) };
    report.cases.push(row); console.log(JSON.stringify(row));
  }
  const invalid = [
    dcl([0, 0]), dcl([0, NaN, 0]), dcl([0, 1000, 0]),
    dcl([0, 0, 0], { NODE_TIMES_MS: [times[0], times[0], times[2]] }),
    dcl([0, 0, 0], { FORM: D.dclCorrectionForm.Nodes }),
    dcl([0, 0, 0], { NODE_VALUES_K: [1] }),
  ];
  const requests = invalid.map(payload => encodePluginInvokeRequest({ methodId: 'ingest_state', inputs: [...initialInputs,
    { portId: 'density_correction', typeRef: correctionType, payload }] }));
  const refused = await page.evaluate(o => window.residentCase(o), { manifest, requests: requests.map(b => [...b]) });
  for (const bytes of refused) { const response = decodePluginInvokeResponse(new Uint8Array(bytes)); assert.notEqual(response.statusCode, 0); assert.equal(response.outputs.length, 0); }
  const native = await residentHarness('wasmedge');
  try { for (let i = 0; i < requests.length; i++) assert.equal(sha(await native.invokeRaw(requests[i])), sha(new Uint8Array(refused[i])), 'invalid input parity'); }
  finally { await native.destroy(); }
  report.invalidRecordsRefused = invalid.length;
  assert.deepEqual(errors, []);
  if (regressionWork) {
    // Memory is measured once by e2e-memory-sizing on this exact artifact;
    // bind that committed evidence here without repeating the full catalog run.
    const sizing = read('tests/evidence/memory-sizing.json');
    assert.equal(sizing.artifactSha256, report.artifactSha256, 'memory evidence must name this artifact');
    assert.equal(sizing.memory.initialBytes, report.memory.initialBytes);
    assert.equal(sizing.memory.maximumBytes, report.memory.maximumBytes);
    assert.equal(sizing.rows.length, 10);
    for (const row of sizing.rows) assert(row.highWaterBytes * 1.5 <= report.memory.maximumBytes);
    const regressions = await regressionWork;
    if (regressions.error) throw regressions.error;
    report.regressions = Object.fromEntries(regressions.scripts.map(name => [name, 'PASS']));
    report.memoryEvidence = 'Exact-artifact measured browser/native roles; tests/evidence/memory-sizing.json';
  }
  report.status = 'PASS';
} catch (error) { report.failure = error.stack; throw error; }
finally {
  await browser?.close(); if (server.listening) await new Promise(resolve => server.close(resolve));
  fs.writeFileSync(path.join(cache, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  if (report.failure) regressionController.abort();
  if (regressionWork) await regressionWork;
  fs.rmSync(aotDir, { recursive: true, force: true });
}
console.log('PASS drag correction: closed-form force ratios, zero identity, catalog/resident trajectories, browser/native byte parity and exact-artifact AOT.');

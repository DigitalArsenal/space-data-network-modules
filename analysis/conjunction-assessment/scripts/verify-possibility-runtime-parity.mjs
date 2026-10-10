#!/usr/bin/env node
// Three-runtime parity of possibility_of_collision (Chrome/V8 with WASI
// threads, native WasmEdge, Docker WasmEdge) on the shipped artifact, at
// worker widths 1, 2, 4 and 8: byte-identical responses, and the values the
// end-to-end test derives from the definitions (tests/possibilityScreening.test.mjs).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { normalizeParityFixture, runParityHarness, formatParityReport } from 'space-data-module-sdk/testing';
import { decodePluginInvokeResponse } from 'space-data-module-sdk/invoke';
import { runThreadedBrowserLane } from './cqr-browser-parity-lane.mjs';
import { wasmedgeParityLane } from './cqr-wasmedge-parity-lane.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const typeRef = { wireFormat: 'flatbuffer', mediaType: 'application/vnd.sdn.ca-possibility-request' };
function frame({ radius, window = 600, mode, a, b, alpha = [] }) {
  const doubles = mode === 0 ? [...a.flat(), ...b.flat()] : [...a.center, ...a.shape, ...b.center, ...b.shape];
  const bytes = new ArrayBuffer(4 + 16 + 16 + 8 * alpha.length + 8 * doubles.length);
  const v = new DataView(bytes);
  new Uint8Array(bytes, 0, 4).set([0x43, 0x50, 0x51, 0x31]);
  let at = 4;
  const f64 = (x) => { v.setFloat64(at, x, true); at += 8; };
  const u32 = (x) => { v.setUint32(at, x, true); at += 4; };
  f64(radius); f64(window); u32(mode); u32(mode === 0 ? a.length : 1); u32(mode === 0 ? b.length : 1); u32(alpha.length);
  alpha.forEach(f64); doubles.forEach(f64);
  return new Uint8Array(bytes);
}
const iso = (s) => [s * s, 0, 0, 0, 0, 0, 0, s * s, 0, 0, 0, 0, 0, 0, s * s, 0, 0, 0, 0, 0, 0, 1e-12, 0, 0, 0, 0, 0, 0, 1e-12, 0, 0, 0, 0, 0, 0, 1e-12];
const requests = {
  'support-four-pairs': frame({ radius: 20, mode: 0, alpha: [0.5, 0.35],
    a: [[1000, 0, 0, 0, 0, 0, 1.0], [300, 5, 0, 0, 0, 0, 0.4]], b: [[0, 0, 0, 0, 0, 7000, 1.0], [300, 0, 0, 0, 0, 7000, 0.7]] }),
  'kernel-isotropic-outside': frame({ radius: 20, mode: 1, alpha: [0.5], a: { center: [100, 0, 0, 0, 0, 7000], shape: iso(10) }, b: { center: [0, 0, 0, 0, 0, 0], shape: iso(10) } }),
  'kernel-isotropic-inside': frame({ radius: 20, mode: 1, a: { center: [5, 0, 0, 0, 0, 7000], shape: iso(10) }, b: { center: [0, 0, 0, 0, 0, 0], shape: iso(10) } }),
  'invalid-radius': frame({ radius: 0, mode: 0, a: [[0, 0, 0, 0, 0, 0, 1]], b: [[1, 0, 0, 0, 0, 1, 1]] }),
};
const cases = Object.entries(requests).map(([id, payload]) => ({
  id, threadCounts: [1, 2, 4, 8], expect: 'ok',
  request: { methodId: 'possibility_of_collision', inputs: [{ portId: 'request', payload, typeRef }] },
}));
const plan = await normalizeParityFixture({ name: 'possibility_of_collision', cases });
const observed = [];
const laneRunners = {};
for (const [name, runner] of Object.entries({ browser: runThreadedBrowserLane, wasmedge: wasmedgeParityLane('wasmedge'), 'docker-wasmedge': wasmedgeParityLane('docker-wasmedge') }))
  laneRunners[name] = async (c) => { const runs = await runner(c); observed.push(...runs.map((r) => ({ ...r, lane: name }))); return runs; };
const report = await runParityHarness({ wasmPath: path.join(root, 'dist/isomorphic/module.wasm'), plan, laneRunners, timeoutMs: 300000, log: console.log });
const values = [];
for (const run of observed) {
  if (run.exitClass !== 'ok') continue;
  const response = decodePluginInvokeResponse(run.stdout);
  if (run.caseId === 'invalid-radius') { if (response.statusCode === 0) report.failures.push({ kind: 'acceptance', message: `${run.lane}: invalid request accepted` }); continue; }
  const out = response.outputs[0].payload, v = new DataView(out.buffer, out.byteOffset, out.byteLength);
  values.push({ lane: run.lane, workers: run.threadCount, caseId: run.caseId, possibility: v.getFloat64(4, true), necessity: v.getFloat64(12, true), sha256: createHash('sha256').update(run.stdout).digest('hex') });
}
for (const id of ['support-four-pairs', 'kernel-isotropic-outside', 'kernel-isotropic-inside']) {
  const rows = values.filter((r) => r.caseId === id);
  try {
    assert.equal(rows.length, 12, `${id}: 12 runs`);
    assert.equal(new Set(rows.map((r) => r.sha256)).size, 1, `${id}: identical bytes`);
    if (id === 'support-four-pairs') assert.deepEqual([rows[0].possibility, rows[0].necessity], [0.4, 0]);
    if (id === 'kernel-isotropic-outside') assert.ok(Math.abs(rows[0].possibility - Math.exp(-8)) <= 1e-15);
    if (id === 'kernel-isotropic-inside') assert.ok(Math.abs(rows[0].necessity - (1 - Math.exp(-0.5 * 0.75 ** 2))) <= 1e-12);
  } catch (error) { report.failures.push({ kind: 'acceptance', message: error.message }); }
}
report.ok &&= report.failures.length === 0;
report.values = values;
fs.writeFileSync(path.join(root, 'docs/possibility-runtime-parity.json'), JSON.stringify(report, null, 2) + '\n');
console.log(formatParityReport(report));
assert.equal(report.ok, true, JSON.stringify(report.failures));

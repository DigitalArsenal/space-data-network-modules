// The SDK compares the same WASM bytes and binary requests in actual Chrome/V8,
// native WasmEdge, and its pinned WasmEdge container. Missing runtimes fail.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { normalizeParityFixture, runParityHarness, formatParityReport } from 'space-data-module-sdk/testing';
import { de440Cases } from './de440-fixture.mjs';

const plan = await normalizeParityFixture({
  name: 'TMPL lane01 orbit-products DE440',
  cases: de440Cases().map(([id, request]) => ({ id, request: {
    ...request,
    inputs: request.inputs.map(({ payload, ...rest }) => ({
      ...rest, payloadHex: Buffer.from(payload).toString('hex'),
    })),
  } })),
});
const report = await runParityHarness({
  wasmPath: fileURLToPath(new URL('../dist/isomorphic/module.wasm', import.meta.url)),
  plan, timeoutMs: 60000, log: console.log,
});
console.log(formatParityReport(report));
assert.equal(report.ok, true, JSON.stringify(report.failures));

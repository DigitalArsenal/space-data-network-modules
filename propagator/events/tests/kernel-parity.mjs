// Executes one byte-identical request per case through Chrome/V8, native
// WasmEdge and container WasmEdge using the SDK's pinned three-lane harness.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { normalizeParityFixture, runParityHarness, formatParityReport } from 'space-data-module-sdk/testing';
import { eclipseRequest, kernelFrame } from './kernel-fixture.mjs';

const requests = [
  ['de440-eclipse', eclipseRequest({kernel: kernelFrame()})],
  ['analytical-eclipse', eclipseRequest()],
  ['de440-out-of-coverage', eclipseRequest({kernel: kernelFrame(), start: '2030-01-02T00:00:00Z'})],
  ['bad-kernel-hash', eclipseRequest({kernel: kernelFrame(undefined, '0'.repeat(64))})],
];
const plan = await normalizeParityFixture({ name: 'TMPL lane01 events', cases: requests.map(([id, request]) => ({
  id, request: { ...request, inputs: request.inputs.map(({payload, ...rest}) => ({...rest, payloadHex: Buffer.from(payload).toString('hex')})) },
})) });
const report = await runParityHarness({ wasmPath: fileURLToPath(new URL('../dist/isomorphic/module.wasm', import.meta.url)),
  plan, timeoutMs: 60000, log: console.log });
console.log(formatParityReport(report));
assert.equal(report.ok, true, JSON.stringify(report.failures));

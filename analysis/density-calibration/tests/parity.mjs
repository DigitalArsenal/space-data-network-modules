// Tri-runtime parity (browser, WasmEdge, Docker WasmEdge) of every method of analysis/density-calibration 0.5.0 ($DCL in,
// $DCL out): evaluate and drag_work under JB2008 and NRLMSISE-00, calibrate, decay, calibrate_decay and energy, on the
// requests of tests/cases.mjs (the inputs of the tests, plus the requests they expect to be refused): identical request
// bytes must give byte-identical outputs, and the same exit class, in every lane.
//   PATH=$HOME/.wasmedge/bin:$PATH node tests/parity.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { formatParityReport, normalizeParityFixture, runParityHarness } from 'space-data-module-sdk/testing';
import { DCL_TYPE, encodeDcl, encodeRequest } from './dcl.mjs';
import { cases as requests } from './cases.mjs';

const wasmPath = fileURLToPath(new URL('../dist/isomorphic/module.wasm', import.meta.url));
const frame = (methodId, body) => ({ methodId, inputs: [{ portId: 'request', payload: encodeDcl(encodeRequest(methodId, body).dcl), typeRef: DCL_TYPE }] });
const cases = requests.map((c) => ({ id: c.id, request: frame(c.method, c.request) }));
const plan = await normalizeParityFixture({ name: 'analysis/density-calibration 0.5.0 methods', cases: cases.map((c) => ({ ...c, expect: 'ok', request: { ...c.request,
  inputs: c.request.inputs.map(({ payload, ...p }) => ({ ...p, payloadHex: Buffer.from(payload).toString('hex') })) } })) });
const report = await runParityHarness({ wasmPath, plan, timeoutMs: 600000, log: console.log });
console.log(formatParityReport(report));
fs.mkdirSync(new URL('../conformance/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('../conformance/parity.json', import.meta.url), `${JSON.stringify({ ...report, wasmPath: 'dist/isomorphic/module.wasm' }, null, 2)}\n`);
assert.equal(report.ok, true, JSON.stringify(report.failures));

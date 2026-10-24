// Parity (browser and native WasmEdge; the owner waived the Docker leg on 2026-10-22, it is never started) of every
// method of analysis/density-calibration ($DCL in, $DCL out): evaluate and drag_work under JB2008 and NRLMSISE-00,
// calibrate, decay, calibrate_decay and energy, on the requests of tests/cases.mjs (the inputs of the tests, plus the
// requests they expect to be refused): identical request bytes must give byte-identical outputs, and the same exit
// class, in every lane. A failed run leaves the committed receipt untouched: assert, then write.
//   PATH=$HOME/.wasmedge/bin:$PATH node tests/parity.mjs   (through headless-run: the browser lane)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { formatParityReport, normalizeParityFixture, runParityHarness } from 'space-data-module-sdk/testing';
import { DCL_TYPE, encodeDcl, encodeRequest } from './dcl.mjs';
import { cases as requests } from './cases.mjs';

const wasmPath = fileURLToPath(new URL('../dist/isomorphic/module.wasm', import.meta.url));
const { version } = JSON.parse(fs.readFileSync(new URL('../plugin-manifest.json', import.meta.url), 'utf8'));
const frame = (methodId, body) => ({ methodId, inputs: [{ portId: 'request', payload: encodeDcl(encodeRequest(methodId, body).dcl), typeRef: DCL_TYPE }] });
const cases = requests.map((c) => ({ id: c.id, request: frame(c.method, c.request) }));
const plan = await normalizeParityFixture({ name: `analysis/density-calibration ${version} methods`, cases: cases.map((c) => ({ ...c, expect: 'ok', request: { ...c.request,
  inputs: c.request.inputs.map(({ payload, ...p }) => ({ ...p, payloadHex: Buffer.from(payload).toString('hex') })) } })) });
const report = await runParityHarness({ wasmPath, plan, lanes: ['browser', 'wasmedge'], timeoutMs: 600000, log: console.log });
console.log(formatParityReport(report));
assert.equal(report.ok, true, JSON.stringify(report.failures));
fs.mkdirSync(new URL('../conformance/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('../conformance/parity.json', import.meta.url), `${JSON.stringify({ ...report, wasmPath: 'dist/isomorphic/module.wasm', dockerLane: 'waived by the owner 2026-10-22 (no Docker)' }, null, 2)}\n`);

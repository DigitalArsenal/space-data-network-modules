// Tri-runtime parity (browser, WasmEdge, Docker WasmEdge) of the OD fit's two-line output: the same fixture fitted
// for catalog numbers on both sides of the five-digit limit and at the Alpha-5 ends, plus the one it must refuse.
// Identical request bytes must give byte-identical outputs and the same exit class in every lane.
//   PATH=$HOME/.wasmedge/bin:$PATH node tests/parity_alpha5.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { formatParityReport, normalizeParityFixture, runParityHarness } from 'space-data-module-sdk/testing';
import { FIL_TYPE, filFrame } from './fit_harness.mjs';

const wasmPath = fileURLToPath(new URL('../dist/isomorphic/module.wasm', import.meta.url));
const fixture = fs.readFileSync(new URL('./fixtures/request.fit.meme', import.meta.url));
// The text ephemeris goes in as an SDS $FIL; the options are node CONFIG (plugin.getConfig), carried per case as
// `config` - each lane's host must answer plugin.getConfig with it.
const fit = (noradCatId) => ({
  methodId: 'fit',
  inputs: [{ portId: 'meme', typeRef: FIL_TYPE, payloadHex: Buffer.from(filFrame(fixture).payload).toString('hex') }],
  config: { dataSource: 'SpaceX-E', noradCatId, objectId: '2026-034A', emitTle: true },
});
const cases = [99999, 100000, 123456, 339999, 340000].map((norad) => ({ id: `fit-tle-${norad}`, request: fit(norad), expect: 'ok' }));
const plan = await normalizeParityFixture({ name: 'analysis/od fit emitTle, Alpha-5 catalog numbers', cases });
const report = await runParityHarness({ wasmPath, plan, timeoutMs: 600000, log: console.log });
console.log(formatParityReport(report));
fs.mkdirSync(new URL('../conformance/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('../conformance/parity-alpha5.json', import.meta.url), `${JSON.stringify({ ...report, wasmPath: 'dist/isomorphic/module.wasm' }, null, 2)}\n`);
assert.equal(report.ok, true, JSON.stringify(report.failures));

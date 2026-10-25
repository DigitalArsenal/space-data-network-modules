// Parity (browser and native WasmEdge; the owner waived the Docker leg on 2026-10-22, it is never started) of the OD fit's
// two-line output: the same fixture fitted for catalog numbers on both sides of the five-digit limit and at the Alpha-5 ends,
// plus the one it must refuse. Identical request bytes must give byte-identical outputs and the same exit class in every lane.
// A failed run leaves the committed receipt untouched: assert, then write.
//   PATH=$HOME/.wasmedge/bin:$PATH node tests/parity_alpha5.mjs   (through headless-run: the browser lane)
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
const report = await runParityHarness({ wasmPath, plan, lanes: ['browser', 'wasmedge'], timeoutMs: 600000, log: console.log });
console.log(formatParityReport(report));
assert.equal(report.ok, true, JSON.stringify(report.failures));
fs.mkdirSync(new URL('../conformance/', import.meta.url), { recursive: true });
// Run times (durationMs) stay out of the receipt: it is a function of the artifact and the cases, so a rerun on the
// same artifact writes the same bytes (the console report above keeps them).
fs.writeFileSync(new URL('../conformance/parity-alpha5.json', import.meta.url), `${JSON.stringify({ ...report, wasmPath: 'dist/isomorphic/module.wasm', dockerLane: 'waived by the owner 2026-10-22 (no Docker)' }, (key, value) => (key === 'durationMs' ? undefined : value), 2)}\n`);

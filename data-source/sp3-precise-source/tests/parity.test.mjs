// The same artifact in headless Chromium, native WasmEdge and Docker WasmEdge: byte-identical outputs for the two real IGS
// products, a synthetic file with velocity records and an absent position, and a damaged file. Needs the SDK's three lanes
// (Chrome, ~/.wasmedge, Docker): `npm run test:parity`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { formatParityReport, normalizeParityFixture, runParityHarness } from 'space-data-module-sdk/testing';
import { sp3File } from './fixtures/sp3-format.mjs';

const fixture = (name) => fs.readFileSync(fileURLToPath(new URL(`../../../files/orbit-products/fixtures/${name}`, import.meta.url)), 'utf8');
const request = (text) => ({ methodId: 'read_sp3', inputs: [{ portId: 'source', payloadUtf8: text, typeRef: { wireFormat: 'aligned-binary', requiredAlignment: 1, byteLength: new TextEncoder().encode(text).length } }] });

test('the same parser artifact agrees in Chromium, native WasmEdge and Docker WasmEdge', { skip: process.env.SDN_RUN_SP3_PARITY !== '1' }, async () => {
  const state = (k) => [6871 + k, 100 * k, -200 * k, 0.1 * k, 7.123456, 1.5];
  const leo = sp3File({ flag: 'V', interval: 30, timeSystem: 'GLO', coordinateSystem: 'IGb14', sats: [{ id: 'L51', epochs: [0, 1, 2, 3, 4].map((k) => (k === 2 ? null : state(k))) }] });
  const plan = await normalizeParityFixture({
    name: 'sp3-precise-source',
    threadCounts: [1],
    cases: [
      { id: 'igs-final-sp3c', request: request(fixture('igs15000.3ep.sp3')), expect: 'ok' },
      { id: 'code-mgex-sp3d', request: request(fixture('COD0MGXFIN_20250190000_01D_05M_ORB.3ep.sp3')), expect: 'ok' },
      { id: 'velocity-and-gap', request: request(leo), expect: 'ok' },
      { id: 'damaged', request: request(leo.slice(0, 120)), expect: 'ok' },
    ],
  });
  const report = await runParityHarness({ wasmPath: fileURLToPath(new URL('../dist/isomorphic/module.wasm', import.meta.url)), plan, autoBuildDockerImage: false, timeoutMs: 60000, log: (message) => console.log(message) });
  console.log(formatParityReport(report));
  assert.equal(report.ok, true, formatParityReport(report));
  assert.equal(report.lanes.length, 3);
});

// The same artifact in headless Chromium, native WasmEdge and Docker WasmEdge: byte-identical outputs for the orbit
// table, a rectangular ephemeris, the datefirst crosswalk and a damaged table. Needs the SDK's three lanes
// (Chrome, ~/.wasmedge, Docker): `npm run test:parity`.
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { formatParityReport, normalizeParityFixture, runParityHarness } from 'space-data-module-sdk/testing';
import { datefirst, ephemerisFile, objects, orbitTable } from './fixtures/vimpel-format.mjs';

const input = (portId, payloadUtf8) => ({ portId, payloadUtf8, typeRef: { wireFormat: 'aligned-binary', requiredAlignment: 1, byteLength: new TextEncoder().encode(payloadUtf8).length } });
const request = (methodId, ...inputs) => ({ methodId, inputs });

test('the same parser artifact agrees in Chromium, native WasmEdge and Docker WasmEdge', { skip: process.env.SDN_RUN_VIMPEL_PARITY !== '1' }, async () => {
  const circle = [0, 1, 2, 3, 4, 5].map((k) => [7000 * Math.cos(k * Math.PI / 5), 7000 * Math.sin(k * Math.PI / 5), 10.1 * k]);
  const plan = await normalizeParityFixture({
    name: 'vimpel-source',
    threadCounts: [1],
    cases: [
      { id: 'orbit-table', request: request('normalize_orbits', input('source', orbitTable(Object.values(objects)))), expect: 'ok' },
      { id: 'ephemeris', request: request('read_ephemeris', input('name', '000123_20260921_000000'), input('source', ephemerisFile(circle))), expect: 'ok' },
      { id: 'datefirst', request: request('read_datefirst', input('source', datefirst([['10201', '20200716', 45952, '20200727'], ['10400', '20200524', 45932, '20200722'], ['10400', '20200524', 45933, '20200723'], ['11100', '20209511', 40002, '20200629']]))), expect: 'ok' },
      { id: 'damaged-table', request: request('normalize_orbits', input('source', orbitTable([{ ...objects.geo, e: 1 }]))), expect: 'ok' },
    ],
  });
  const report = await runParityHarness({ wasmPath: fileURLToPath(new URL('../dist/isomorphic/module.wasm', import.meta.url)), plan, autoBuildDockerImage: false, timeoutMs: 60000, log: (message) => console.log(message) });
  console.log(formatParityReport(report));
  assert.equal(report.ok, true, formatParityReport(report));
  assert.equal(report.lanes.length, 3);
});

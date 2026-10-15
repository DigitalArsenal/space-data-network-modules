// The same artifact in headless Chromium, native WasmEdge and Docker WasmEdge: byte-identical outputs for the orbit
// table, a rectangular ephemeris, the datefirst crosswalk and a damaged table. Needs the SDK's three lanes
// (Chrome, ~/.wasmedge, Docker): `npm run test:parity`.
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { encodeHttpResponse } from 'space-data-module-sdk/runtime-contracts';
import { formatParityReport, normalizeParityFixture, runParityHarness } from 'space-data-module-sdk/testing';
import { datefirst, ephemerisFile, objects, orbitTable } from './fixtures/vimpel-format.mjs';

// Each file as the BODY of one HttpResponse (HRSP), as the host flow hands it over; an ephemeris is named by its URL.
const request = (methodId, text, url = 'https://spacedata.vimpel.ru/data/file') => ({ methodId, inputs: [{ portId: 'response',
  payload: encodeHttpResponse({ url, status: 200, body: new TextEncoder().encode(text) }),
  typeRef: { schemaName: 'HttpResponse.fbs', fileIdentifier: 'HRSP', rootTypeName: 'HttpResponse', wireFormat: 'flatbuffer' } }] });

test('the same parser artifact agrees in Chromium, native WasmEdge and Docker WasmEdge', { skip: process.env.SDN_RUN_VIMPEL_PARITY !== '1' }, async () => {
  const circle = [0, 1, 2, 3, 4, 5].map((k) => [7000 * Math.cos(k * Math.PI / 5), 7000 * Math.sin(k * Math.PI / 5), 10.1 * k]);
  const plan = await normalizeParityFixture({
    name: 'vimpel-source',
    threadCounts: [1],
    cases: [
      { id: 'orbit-table', request: request('normalize_orbits', orbitTable(Object.values(objects))), expect: 'ok' },
      { id: 'ephemeris', request: request('read_ephemeris', ephemerisFile(circle), 'https://spacedata.vimpel.ru/data/000123_20260921_000000'), expect: 'ok' },
      { id: 'datefirst', request: request('read_datefirst', datefirst([['10201', '20200716', 45952, '20200727'], ['10400', '20200524', 45932, '20200722'], ['10400', '20200524', 45933, '20200723'], ['11100', '20209511', 40002, '20200629']])), expect: 'ok' },
      { id: 'damaged-table', request: request('normalize_orbits', orbitTable([{ ...objects.geo, e: 1 }])), expect: 'ok' },
    ],
  });
  const report = await runParityHarness({ wasmPath: fileURLToPath(new URL('../dist/isomorphic/module.wasm', import.meta.url)), plan, autoBuildDockerImage: false, timeoutMs: 60000, log: (message) => console.log(message) });
  console.log(formatParityReport(report));
  assert.equal(report.ok, true, formatParityReport(report));
  assert.equal(report.lanes.length, 3);
});

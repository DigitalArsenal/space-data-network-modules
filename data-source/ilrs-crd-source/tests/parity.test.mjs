// The same artifact in headless Chromium, native WasmEdge and Docker WasmEdge: byte-identical outputs for the real ILRS file,
// synthetic passes (a pass across midnight, two configurations, skipped sessions) and a truncated file. Needs the SDK's three
// lanes (Chrome, ~/.wasmedge, Docker): `npm run test:parity`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { encodeHttpResponse } from 'space-data-module-sdk/runtime-contracts';
import { formatParityReport, normalizeParityFixture, runParityHarness } from 'space-data-module-sdk/testing';
import { crdFile, pass } from './fixtures/crd-format.mjs';

const real = fs.readFileSync(fileURLToPath(new URL('./fixtures/lageos1_20261008.first-two-passes.np2', import.meta.url)), 'utf8');
// Each file as the HttpResponse (HRSP) hostcap/http-request answers, BODY the text verbatim.
const HRSP = { schemaName: 'HttpResponse.fbs', fileIdentifier: 'HRSP', rootTypeName: 'HttpResponse', wireFormat: 'flatbuffer' };
const request = (text) => ({ methodId: 'read_crd', inputs: [{ portId: 'source', typeRef: HRSP,
  payload: encodeHttpResponse({ url: 'https://edc.dgfi.tum.de/lageos1.np2', status: 200, body: new TextEncoder().encode(text), retrievedMs: Date.UTC(2026, 9, 14) }) }] });

test('the same parser artifact agrees in Chromium, native WasmEdge and Docker WasmEdge', { skip: process.env.SDN_RUN_CRD_PARITY !== '1' }, async () => {
  const synthetic = crdFile([
    pass({ start: [2026, 10, 11, 23, 58, 0], points: [{ sod: '86300.5', tof: '0.04' }, { sod: '30.25', tof: '0.04' }], meteo: [{ sod: '86300.0', p: '1013.25', t: '288.15', h: '50' }] }),
    pass({ station: { name: 'TWO1' }, configs: [{ id: 'g532', nm: '532.000' }, { id: 'ir', nm: '1064.000' }], points: [{ sod: '200.5', tof: '0.04', cfg: 'g532' }, { sod: '201.5', tof: '0.04', cfg: 'ir' }] }),
    pass({ station: { name: 'FULL' }, dataType: 0, points: [{ sod: '10.0', tof: '0.04' }] }),
  ]);
  const plan = await normalizeParityFixture({
    name: 'ilrs-crd-source',
    threadCounts: [1],
    cases: [
      { id: 'real-two-passes', request: request(real), expect: 'ok' },
      { id: 'synthetic', request: request(synthetic), expect: 'ok' },
      { id: 'truncated', request: request(synthetic.slice(0, -3)), expect: 'ok' },
    ],
  });
  const report = await runParityHarness({ wasmPath: fileURLToPath(new URL('../dist/isomorphic/module.wasm', import.meta.url)), plan, autoBuildDockerImage: false, timeoutMs: 60000, log: (message) => console.log(message) });
  console.log(formatParityReport(report));
  assert.equal(report.ok, true, formatParityReport(report));
  assert.equal(report.lanes.length, 3);
});

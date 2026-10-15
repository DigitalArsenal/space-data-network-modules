// The same artifact in headless Chromium, native WasmEdge and Docker WasmEdge: byte-identical outputs for AOE records
// (Alpha-5, an object with no NORAD number, a duplicate, a damaged record) and for a damaged input. Needs the SDK's three
// lanes (Chrome, ~/.wasmedge, Docker): `npm run test:parity`.
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { encodeHttpResponse } from 'space-data-module-sdk/runtime-contracts';
import { formatParityReport, normalizeParityFixture, runParityHarness } from 'space-data-module-sdk/testing';
import { synthetic } from '../../spacetrack-source/tests/fixtures/spacetrack-format.mjs';
import { aoeRecord } from './fixtures/aoe-format.mjs';

// The records as the BODY of one HttpResponse (HRSP), as the host flow hands them over.
const request = (text) => ({ methodId: 'parse_aoe', inputs: [{ portId: 'response', payload: encodeHttpResponse({ status: 200, body: new TextEncoder().encode(text) }),
  typeRef: { schemaName: 'HttpResponse.fbs', fileIdentifier: 'HRSP', rootTypeName: 'HttpResponse', wireFormat: 'flatbuffer' } }] });
const base = (over = {}) => synthetic({ epoch: '2026-10-10T10:00:00.000000', recordId: 5001, ...over });

test('the same parser artifact agrees in Chromium, native WasmEdge and Docker WasmEdge', { skip: process.env.SDN_RUN_AOE_PARITY !== '1' }, async () => {
  const records = [
    aoeRecord(base()),
    aoeRecord(base({ name: 'SYNTH 2', objectId: '2026-902A', norad: 100123, cell: 'A0123', recordId: 5002, epoch: '2026-10-10T11:30:00.000000' })),
    aoeRecord(base({ name: 'SYNTH 3', objectId: '2026-903A', norad: 55555, recordId: 5003, catId: 777001, satId: null }), { noradId: null }),
    aoeRecord(base()),
    aoeRecord(base({ recordId: 5010 }), { inclination: 12.0 }),
  ];
  const plan = await normalizeParityFixture({
    name: 'spacemapper-aoe-source',
    threadCounts: [1],
    cases: [
      { id: 'jsonl', request: request(records.map((r) => JSON.stringify(r)).join('\n')), expect: 'ok' },
      { id: 'array', request: request(JSON.stringify(records.slice(0, 3))), expect: 'ok' },
      { id: 'damaged', request: request(JSON.stringify(records).slice(0, -3)), expect: 'ok' },
      { id: 'not-modified', request: { methodId: 'parse_aoe', inputs: [{ ...request('').inputs[0], payload: encodeHttpResponse({ status: 304 }) }] }, expect: 'ok' },
    ],
  });
  const report = await runParityHarness({ wasmPath: fileURLToPath(new URL('../dist/isomorphic/module.wasm', import.meta.url)), plan, autoBuildDockerImage: false, timeoutMs: 60000, log: (message) => console.log(message) });
  console.log(formatParityReport(report));
  assert.equal(report.ok, true, formatParityReport(report));
  assert.equal(report.lanes.length, 3);
});

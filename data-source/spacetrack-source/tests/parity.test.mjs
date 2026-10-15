// The same artifact in headless Chromium, native WasmEdge and Docker WasmEdge: byte-identical outputs for a mixed
// gp history (Alpha-5, duplicate, damaged sets), a satcat and a damaged input. Needs the SDK's three lanes
// (Chrome, ~/.wasmedge, Docker): `npm run test:parity`.
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { formatParityReport, normalizeParityFixture, runParityHarness } from 'space-data-module-sdk/testing';
import { encodeHttpResponse } from 'space-data-module-sdk/runtime-contracts';
import { gpRecord, satcatRecord, synthetic } from './fixtures/spacetrack-format.mjs';

const HRSP = { schemaName: 'HttpResponse.fbs', fileIdentifier: 'HRSP', rootTypeName: 'HttpResponse', wireFormat: 'flatbuffer' };
const request = (methodId, text) => ({ methodId, inputs: [{ portId: 'response', typeRef: HRSP,
  payload: encodeHttpResponse({ url: 'https://www.space-track.org/', status: 200, body: new TextEncoder().encode(text), retrievedMs: Date.UTC(2026, 9, 10, 18) }) }] });

test('the same parser artifact agrees in Chromium, native WasmEdge and Docker WasmEdge', { skip: process.env.SDN_RUN_SPACETRACK_PARITY !== '1' }, async () => {
  const a = synthetic();
  const history = JSON.stringify([
    gpRecord(a),
    gpRecord(synthetic({ gpId: 900000002, norad: 100123, cell: 'A0123', epoch: '2026-10-10T12:00:00.000001', objectId: '2026-902A' })),
    gpRecord(a),
    gpRecord(synthetic({ gpId: 900000003 }), { MEAN_ELEMENT_THEORY: 'DSST' }),
  ]);
  const satcat = JSON.stringify([satcatRecord(), satcatRecord({ NORAD_CAT_ID: '99002', INTLDES: '2026-902B', OBJECT_ID: '2026-902B', DECAY: '2026-05-06', COUNTRY: 'XX' })]);
  const plan = await normalizeParityFixture({
    name: 'spacetrack-source',
    threadCounts: [1],
    cases: [
      { id: 'gp-history', request: request('parse_gp', history), expect: 'ok' },
      { id: 'satcat', request: request('parse_satcat', satcat), expect: 'ok' },
      { id: 'damaged-history', request: request('parse_gp', history.slice(0, -3)), expect: 'ok' },
    ],
  });
  const report = await runParityHarness({ wasmPath: fileURLToPath(new URL('../dist/isomorphic/module.wasm', import.meta.url)), plan, autoBuildDockerImage: false, timeoutMs: 60000, log: (message) => console.log(message) });
  console.log(formatParityReport(report));
  assert.equal(report.ok, true, formatParityReport(report));
  assert.equal(report.lanes.length, 3);
});

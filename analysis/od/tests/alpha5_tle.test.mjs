// The two-line element set of an OD fit, for catalog numbers across the Alpha-5 range (Space-Track,
// https://www.space-track.org/documentation#/tle-alpha5: A=10, J=18, Z=33, no I or O; 100000 is A0000, 339999 is Z9999).
// The fit runs in both runtime lanes of the standalone harness; the lines it writes are checked against the fitted
// elements it reports, and read back by data-source/catalog-source, the module that reads TLE catalogs, which must
// report the catalog number that was asked for. Tri-runtime parity of the same cases: tests/parity_alpha5.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ByteBuffer } from 'flatbuffers';
import { CAT } from 'spacedatastandards.org/lib/js/CAT/CAT.js';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import { encodeHttpResponse } from 'space-data-module-sdk/runtime-contracts';
import { STANDALONE_RUNTIME_KINDS } from 'space-data-module-sdk/testing/isomorphic';
import { createFitPoolOrSkip, createFitRequest, fitRecordFromResponse } from './fit_harness.mjs';

const WASM_PATH = new URL('../dist/isomorphic/module.wasm', import.meta.url);
const FIXTURE = fs.readFileSync(fileURLToPath(new URL('./fixtures/request.fit.meme', import.meta.url)));
const CATALOG_SOURCE = new URL('../../../data-source/catalog-source/', import.meta.url);

// catalog number, the five characters the field must hold
const CASES = [[99999, '99999'], [100000, 'A0000'], [123456, 'C3456'], [270086, 'T0086'], [339999, 'Z9999']];

// The check digit of a two-line set: the digits of the first 68 columns, each '-' counting one, modulo ten.
const checkDigit = (line) => [...line.slice(0, 68)].reduce((sum, c) => sum + (/[0-9]/.test(c) ? Number(c) : c === '-' ? 1 : 0), 0) % 10;

async function fit(harness, noradCatId) {
  return harness.invoke(createFitRequest(FIXTURE, { dataSource: 'SpaceX-E', noradCatId, objectId: '2026-034A', emitTle: true }));
}

async function catalogSource(t) {
  const host = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(new URL('dist/isomorphic/module.wasm', CATALOG_SOURCE)),
    manifest: JSON.parse(fs.readFileSync(new URL('plugin-manifest.json', CATALOG_SOURCE), 'utf8')),
    surface: 'direct',
  });
  t.after(() => host.destroy());
  return host;
}

async function readBack(host, line1, line2) {
  const payload = new TextEncoder().encode(`${line1}\n${line2}\n`);
  // catalog-source reads an edition as the HttpResponse (HRSP) hostcap/http-request answers with.
  const response = encodeHttpResponse({ url: 'https://example.invalid/od-fit.tle', status: 200, body: payload, retrievedMs: Date.UTC(2026, 9, 14) });
  const result = await host.invoke({ methodId: 'parse_mccants_tle_catalog', inputs: [{ portId: 'response', payload: response, typeRef: { schemaName: 'HttpResponse.fbs', fileIdentifier: 'HRSP', rootTypeName: 'HttpResponse', wireFormat: 'flatbuffer' } }] });
  assert.equal(result.statusCode, 0, result.errorMessage);
  const bytes = result.outputs.find((frame) => frame.portId === 'catalog').payload;
  const length = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true) + 4;
  return CAT.getSizePrefixedRootAsCAT(new ByteBuffer(bytes.slice(0, length))).unpack();
}

for (const runtimeKind of STANDALONE_RUNTIME_KINDS) {
  test(`the OD fit writes Alpha-5 two-line sets that catalog-source reads back, on ${runtimeKind}`, async (t) => {
    const harness = await createFitPoolOrSkip(runtimeKind, WASM_PATH, t, { enableThreads: true });
    if (!harness) return;
    t.after(() => harness.destroy());
    const reader = await catalogSource(t);

    for (const [norad, field] of CASES) {
      const fitted = fitRecordFromResponse(await fit(harness, norad));
      const { TLE_LINE1: line1, TLE_LINE2: line2 } = fitted;
      assert.equal(fitted.TLE_NAME, `${norad}.tle`);
      assert.equal(line1.length, 69, `line 1 of ${norad}`);
      assert.equal(line2.length, 69, `line 2 of ${norad}`);
      assert.equal(line1.slice(0, 2), '1 ');
      assert.equal(line2.slice(0, 2), '2 ');
      assert.equal(line1.slice(2, 7), field, `line 1 catalog field of ${norad}`);
      assert.equal(line2.slice(2, 7), field, `line 2 catalog field of ${norad}`);
      assert.equal(Number(line1[68]), checkDigit(line1), `line 1 check digit of ${norad}`);
      assert.equal(Number(line2[68]), checkDigit(line2), `line 2 check digit of ${norad}`);
      assert.equal(line1.slice(9, 17), '26034A  ', 'international designator of 2026-034A');

      // the lines ($FIL on "tle") carry the fitted $OMM elements at the precision a two-line set prints them
      const columns = (a, b) => Number(line2.slice(a, b));
      assert.ok(Math.abs(columns(8, 16) - fitted.INCLINATION) < 5.1e-5);
      assert.ok(Math.abs(columns(17, 25) - fitted.RA_OF_ASC_NODE) < 5.1e-5);
      assert.ok(Math.abs(Number(`0.${line2.slice(26, 33)}`) - fitted.ECCENTRICITY) < 5.1e-8);
      assert.ok(Math.abs(columns(34, 42) - fitted.ARG_OF_PERICENTER) < 5.1e-5);
      assert.ok(Math.abs(columns(43, 51) - fitted.MEAN_ANOMALY) < 5.1e-5);
      assert.ok(Math.abs(columns(52, 63) - fitted.MEAN_MOTION) < 5.1e-9);

      // catalog-source keeps 90000..99999 (SeeSat-L's analyst numbers) out of the catalog-number field by design
      const row = await readBack(reader, line1, line2);
      assert.equal(row.NORAD_CAT_ID, norad >= 90000 && norad <= 99999 ? 0 : norad, `catalog-source reads ${field}`);
    }
  });

  test(`the OD fit refuses a catalog number no two-line set can hold, on ${runtimeKind}`, async (t) => {
    const harness = await createFitPoolOrSkip(runtimeKind, WASM_PATH, t, { enableThreads: true });
    if (!harness) return;
    t.after(() => harness.destroy());
    const result = await fit(harness, 340000);
    assert.notEqual(result.statusCode, 0);
    assert.equal(result.errorCode, 'unrepresentable-catalog-number');
  });
}

// The module through the SDK's browser harness. Expected values are the numbers the synthetic sets are made of, the
// published two-line element conventions (epoch = year and day of year, implied decimal points, Alpha-5 catalog numbers)
// and arithmetic worked by hand: an epoch of 10:00:00 is day fraction 0.41666667 in the two-line set's eight digits, which
// is 36000.000288 s (0.41666667 x 86400); a China Standard Time clock is eight hours ahead of UTC.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { fileURLToPath as toPath, pathToFileURL } from 'node:url';
import { validateArtifactWithStandards } from 'space-data-module-sdk/compliance';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import { decodeFlowNotice, decodeIngestRequest, encodeHttpResponse } from 'space-data-module-sdk/runtime-contracts';
import { synthetic } from '../../spacetrack-source/tests/fixtures/spacetrack-format.mjs';
import { aoeRecord } from './fixtures/aoe-format.mjs';

const wasmPath = fileURLToPath(new URL('../dist/isomorphic/module.wasm', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(new URL('../plugin-manifest.json', import.meta.url), 'utf8'));
// SDS JS (and its flatbuffers) from the spacedatastandards checkout the module is built against.
const standardsRoot = process.env.SPACE_DATA_STANDARDS_ROOT ?? toPath(new URL('../../../../spacedatastandards.org/', import.meta.url));
const lib = (code) => pathToFileURL(path.join(standardsRoot, `lib/js/${code}/main.js`));
const { ByteBuffer } = createRequire(lib('OMM'))('flatbuffers');
const { OMM } = await import(lib('OMM').href);
const { CAT } = await import(lib('CAT').href);
const HRSP = { schemaName: 'HttpResponse.fbs', fileIdentifier: 'HRSP', rootTypeName: 'HttpResponse', wireFormat: 'flatbuffer' };
const URL_AOE = 'https://www.spacemapper.cn/aoe/records';
// The records travel verbatim as the BODY of the HttpResponse hostcap/http-request (or the host's page decoder) gives.
const request = (text, { status = 200 } = {}) => ({
  methodId: 'parse_aoe',
  inputs: [{ portId: 'response', typeRef: HRSP, payload: encodeHttpResponse({ url: URL_AOE, status, body: new TextEncoder().encode(text), retrievedMs: 1760000000000 }) }],
});
async function harness(t) {
  const host = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(wasmPath), manifest, surface: 'direct' });
  t.after(() => host.destroy());
  return host;
}
function* sizePrefixed(bytes) {
  for (let at = 0; at < bytes.length;) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + at, 4).getUint32(0, true) + 4;
    yield bytes.slice(at, at + length);
    at += length;
  }
}
const frame = (result, port) => {
  assert.equal(result.statusCode, 0, result.errorMessage);
  return result.outputs.find((f) => f.portId === port).payload;
};
const records = (result, port, id, T) => [...sizePrefixed(frame(result, port))].map((rec) => {
  assert.equal(Buffer.from(rec.subarray(8, 12)).toString(), id);
  return T[`getSizePrefixedRootAs${T.name}`](new ByteBuffer(rec)).unpack();
});
const omms = (result) => records(result, 'omm', '$OMM', OMM);
const cats = (result) => records(result, 'crosswalk', '$CAT', CAT);
const meta = (result) => decodeIngestRequest(frame(result, 'meta'));
// The report's counts, from the IngestRequest's PROVENANCE.ATTRIBUTES.
const counts = (result) => {
  const attrs = meta(result).provenance.attributes;
  assert.deepEqual(attrs.map((h) => h.name), attrs.map((h) => h.name).sort(), 'ATTRIBUTES sorted by their key');
  return Object.fromEntries(attrs.map((h) => [h.name, Number(h.value)]));
};
const params = (omm) => Object.fromEntries(omm.USER_DEFINED_PARAMETERS.map((p) => [p.PARAM_NAME, p.PARAM_VALUE]));

// whole-second epochs, as AOE's are
const base = (over = {}) => synthetic({ epoch: '2026-10-10T10:00:00.000000', recordId: 5001, ...over });

test('the SDK artifact validates against the canonical standards', async () => {
  const result = await validateArtifactWithStandards({ wasmPath, manifest, standardsRoot });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
});

test('parse_aoe: the two-line set becomes the OMM, the NORAD number AOE gives is kept and one it gives none of is named aoe:<id>', async (t) => {
  const host = await harness(t);
  const lines = [
    aoeRecord(base()),
    // A catalog number above 99999, written in Alpha-5 in the two-line set (A0123 = 100123) and as a number in the record.
    aoeRecord(base({ name: 'SYNTH 2', objectId: '2026-902A', norad: 100123, cell: 'A0123', recordId: 5002, epoch: '2026-10-10T11:30:00.000000' })),
    // An object AOE gives no NORAD number for: its own id is all it has.
    aoeRecord(base({ name: 'SYNTH 3', objectId: '2026-903A', norad: 55555, recordId: 5003, catId: 777001, satId: null }), { noradId: null }),
    aoeRecord(base()), // the same record id again (the listing shifts while it is paged): dropped, counted
  ].map((r) => JSON.stringify(r)).join('\n');
  const result = await host.invoke(request(lines));
  const [a, b, c] = omms(result);
  assert.equal(omms(result).length, 3);
  assert.equal(a.NORAD_CAT_ID, 99001);
  assert.equal(a.OBJECT_NAME, 'SYNTH 1');
  assert.equal(a.OBJECT_ID, '2026-901A');
  assert.equal(a.ORIGINATOR, 'SpaceMapper AOE');
  // 10:00:00 on day 283 of 2026 is the two-line set's 26283.41666667: day fraction 0.41666667 x 86400 s = 36000.000288 s.
  assert.equal(a.EPOCH, '2026-10-10T10:00:00.000288');
  // ctime 2026-10-11T18:04:12+0800 is 10:04:12 UTC.
  assert.equal(a.CREATION_DATE, '2026-10-11T10:04:12');
  assert.equal(a.MEAN_MOTION, 15.49512345);
  assert.equal(a.ECCENTRICITY, 0.0006789);
  assert.equal(a.INCLINATION, 51.6123);
  assert.equal(a.RA_OF_ASC_NODE, 123.4567);
  assert.equal(a.ARG_OF_PERICENTER, 87.6543);
  assert.equal(a.MEAN_ANOMALY, 272.5432);
  assert.equal(a.BSTAR, 0.00034567); // the two-line set's " 34567-3": 0.34567e-3
  assert.equal(a.MEAN_MOTION_DOT, 0.00001234);
  assert.equal(a.MEAN_MOTION_DDOT, 0);
  assert.equal(a.ELEMENT_SET_NO, 0);
  assert.equal(a.MEAN_ELEMENT_THEORY, 0);
  assert.equal(a.REFERENCE_FRAME.REFERENCE_FRAME.frame, 5); // TEME of date
  assert.deepEqual(params(a), { AOE_CHANNEL: 'KY', AOE_RECORD_ID: '5001', AOE_CAT_ID: '99001', AOE_SAT_ID: '99001', AOE_LAST_UPDATE_ID: '2026test5001', AOE_OBJECT_TYPE: 'PAYLOAD' });
  assert.equal(a.USER_DEFINED_OBJECT_DESIGNATOR, null, 'a number AOE gives is the key; no native name is needed');
  assert.equal(b.NORAD_CAT_ID, 100123);
  assert.equal(b.EPOCH, '2026-10-10T11:30:00.000288'); // 0.47916667 d = 41400.000288 s
  // No NORAD number given: none is invented, and the native name is the key.
  assert.equal(c.NORAD_CAT_ID, 0);
  assert.equal(c.USER_DEFINED_OBJECT_DESIGNATOR, 'aoe:777001');
  assert.equal(params(c).AOE_CAT_ID, '777001');
  assert.equal(params(c).AOE_SAT_ID, undefined);
  assert.deepEqual(counts(result), { records: 4, emitted: 3, duplicateRecordIds: 1, rejected: 0, alpha5CatalogNumbers: 1, checksumMismatches: 3, withoutNoradNumber: 1, objects: 3 });
  const m = meta(result);
  assert.equal(m.schema, 'OMM.fbs');
  assert.equal(m.tags.sourceName, 'spacemapper-aoe');
  assert.equal(m.tags.sourceUrl, URL_AOE);
  assert.match(m.tags.batchId, /^[0-9a-f]{64}$/);
  assert.equal(m.provenance.sourceSha256, m.tags.batchId);
  assert.equal(Number(m.provenance.normalizedCount), 3);
  assert.deepEqual(m.provenance.schemaCounts, { 'OMM.fbs': 3, 'CAT.fbs': 3 });
  // The crosswalk: one $CAT candidate per AOE object, in AOE id order, in AOE's own namespace.
  assert.deepEqual(cats(result).map((c) => [c.CATALOG_URI, c.CATALOG_OBJECT_ID, c.NORAD_CAT_ID, c.OBJECT_ID, c.OBJECT_NAME, c.OBJECT_TYPE]), [
    ['urn:sdn:spacemapper-aoe', 'aoe:99001', 99001, '2026-901A', 'SYNTH 1', 0],
    ['urn:sdn:spacemapper-aoe', 'aoe:100123', 100123, '2026-902A', 'SYNTH 2', 0],
    ['urn:sdn:spacemapper-aoe', 'aoe:777001', 0, '2026-903A', 'SYNTH 3', 0],
  ]);
});

test('parse_aoe drops what its own fields contradict, and counts it', async (t) => {
  const host = await harness(t);
  const rows = [
    aoeRecord(base()),
    aoeRecord(base({ recordId: 5010 }), { inclination: 12.0 }), // the rounded elements disagree with the two-line set
    aoeRecord(base({ recordId: 5011 }), { epoch: '2026-10-10T19:00:00+0800' }), // the ISO epoch is an hour off the set's
    aoeRecord(base({ recordId: 5012 }), { noradId: 99002 }), // the NORAD number is not the set's
    aoeRecord(base({ recordId: 5013 }), { line1: `${aoeRecord(base()).line1.slice(0, 62)}4${aoeRecord(base()).line1.slice(63)}` }), // an ephemeris type that is not SGP4
    aoeRecord(base({ recordId: 5014 }), { line2: 'short' }),
    aoeRecord(base({ recordId: 5015 }), { catId: null, satId: null, noradId: null }), // names no object
  ];
  const result = await host.invoke(request(JSON.stringify(rows)));
  assert.equal(omms(result).length, 1);
  const c = counts(result);
  assert.equal(c.rejected, 6);
  assert.deepEqual(Object.fromEntries(Object.entries(c).filter(([k]) => k.startsWith('rejection:')).map(([k, v]) => [k.slice(10), v])), {
    'inclination disagrees with the two-line set': 1,
    'the epoch disagrees with the two-line set': 1,
    'the NORAD number disagrees with the two-line set': 1,
    'the two-line set is not an SGP4 set (ephemeris type 4)': 1,
    'the two-line set is not two lines of 69 columns': 1,
    'the record names no object: no noradId, catId or satId': 1,
  });
  assert.deepEqual(meta(result).provenance.warnings, [
    'record 1: inclination disagrees with the two-line set',
    'record 2: the epoch disagrees with the two-line set',
    'record 3: the NORAD number disagrees with the two-line set',
    'record 4: the two-line set is not an SGP4 set (ephemeris type 4)',
    'record 5: the two-line set is not two lines of 69 columns',
    'record 6: the record names no object: no noradId, catId or satId',
  ]);
  for (const [name, text] of [['truncated JSON', JSON.stringify(rows).slice(0, -2)], ['not records', '[1,2]'], ['empty', ' '], ['nothing readable', JSON.stringify([rows[1]])]]) {
    const refused = await host.invoke(request(text));
    assert.notEqual(refused.statusCode, 0, name);
    assert.equal(refused.outputs?.length ?? 0, 0, `${name}: partial output`);
  }
  // A non-200 response fails whole.
  const failed = await host.invoke(request(JSON.stringify(rows), { status: 500 }));
  assert.notEqual(failed.statusCode, 0);
  assert.equal(failed.outputs?.length ?? 0, 0);
});

test('parse_aoe: a 304 is one FlowNotice Unchanged and nothing else', async (t) => {
  const host = await harness(t);
  const result = await host.invoke(request('', { status: 304 }));
  assert.equal(result.statusCode, 0, result.errorMessage);
  assert.deepEqual(result.outputs.map((o) => o.portId), ['unchanged']);
  const n = decodeFlowNotice(result.outputs[0].payload);
  assert.equal(n.schema, 'OMM.fbs');
  assert.equal(n.reason, 'not-modified');
  assert.deepEqual(n.items, [URL_AOE]);
});

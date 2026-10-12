// The module through the SDK's browser harness: the artifact validates against the standards, Space-Track's JSON
// becomes $OMM and $CAT records whose fields are the values the synthetic fixtures were built from, a damaged
// input gives no partial output, and the records feed the source-products flow (flows/source-products
// tests/source-chain.test.mjs). Expected values come from the numbers the fixtures are made of and from the
// published Alpha-5 rule (Space-Track's two-line elements: A0000 = 100000 ... Z9999 = 339999, I and O omitted),
// never from the module's own output.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ByteBuffer } from 'flatbuffers';
import { CAT } from 'spacedatastandards.org/lib/js/CAT/CAT.js';
import { legacyCountryCode } from 'spacedatastandards.org/lib/js/CAT/legacyCountryCode.js';
import { OMM } from 'spacedatastandards.org/lib/js/OMM/OMM.js';
import { validateArtifactWithStandards } from 'space-data-module-sdk/compliance';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import { gpRecord, satcatRecord, synthetic } from './fixtures/spacetrack-format.mjs';

const wasmPath = fileURLToPath(new URL('../dist/isomorphic/module.wasm', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(new URL('../plugin-manifest.json', import.meta.url), 'utf8'));
const standardsRoot = path.dirname(createRequire(import.meta.url).resolve('spacedatastandards.org/package.json'));

const request = (methodId, text) => {
  const payload = new TextEncoder().encode(text);
  return { methodId, inputs: [{ portId: 'source', payload, typeRef: { wireFormat: 'aligned-binary', requiredAlignment: 1, byteLength: payload.length } }] };
};
async function harness(t) {
  const host = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(wasmPath), manifest, surface: 'direct' });
  t.after(() => host.destroy());
  return host;
}
function* sizePrefixed(bytes) {
  for (let at = 0; at < bytes.length;) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + at, 4).getUint32(0, true) + 4;
    assert.ok(length > 8 && at + length <= bytes.length, 'a record runs past the stream');
    yield bytes.slice(at, at + length);
    at += length;
  }
}
const output = (result, port) => {
  assert.equal(result.statusCode, 0, result.errorMessage);
  return result.outputs.find((frame) => frame.portId === port).payload;
};
const records = (result, port, type, identifier) => [...sizePrefixed(output(result, port))].map((rec) => {
  assert.equal(Buffer.from(rec.subarray(8, 12)).toString(), identifier);
  return type[`getSizePrefixedRootAs${identifier.slice(1)}`](new ByteBuffer(rec)).unpack();
});
const report = (result) => JSON.parse(new TextDecoder().decode(output(result, 'report')));
const params = (omm) => Object.fromEntries(omm.USER_DEFINED_PARAMETERS.map((p) => [p.PARAM_NAME, p.PARAM_VALUE]));

test('the SDK artifact validates against the canonical standards', async () => {
  const result = await validateArtifactWithStandards({ wasmPath, manifest, standardsRoot });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
});

test('parse_gp: the fields of a Space-Track set, a catalog number above 99999 read from text or from the two-line set, duplicates and unreadable sets counted', async (t) => {
  const host = await harness(t);
  const a = synthetic();
  // Catalog cells written as the published Alpha-5 rule gives them: A0123 is 100123 (A = 10), J0000 is 180000 (I is skipped).
  const b = synthetic({ name: 'SYNTH 2', objectId: '2026-902A', norad: 100123, cell: 'A0123', gpId: 900000002, epoch: '2026-10-10T12:00:00.000001', meanMotion: 14.2, inc: 97.5 });
  const c = synthetic({ name: 'SYNTH 3', objectId: '2026-903A', norad: 180000, cell: 'J0000', gpId: 900000003 });
  const rows = [
    gpRecord(a),
    gpRecord(b),
    // No NORAD_CAT_ID in the JSON: the number is the one in the first line, written in Alpha-5.
    gpRecord(c, { NORAD_CAT_ID: undefined }),
    // The same GP_ID again (a window boundary read twice): dropped, counted.
    gpRecord(a),
    // The number in the JSON and the one in the two-line set disagree.
    gpRecord(synthetic({ gpId: 900000004 }), { NORAD_CAT_ID: '99002' }),
    // A theory this module does not read, an epoch that is not a time, an eccentricity outside its range.
    gpRecord(synthetic({ gpId: 900000005 }), { MEAN_ELEMENT_THEORY: 'DSST' }),
    gpRecord(synthetic({ gpId: 900000006 }), { EPOCH: '2026-13-40T00:00:00' }),
    gpRecord(synthetic({ gpId: 900000007 }), { ECCENTRICITY: '1.5' }),
  ];
  const result = await host.invoke(request('parse_gp', JSON.stringify(rows)));
  const omms = records(result, 'omm', OMM, '$OMM');
  assert.equal(omms.length, 3);
  const [first, second, third] = omms;
  // Fields are the text of the fixture, parsed: units and conventions are Space-Track's (rev/day, degrees, 1/Earth radii).
  assert.equal(first.OBJECT_NAME, 'SYNTH 1');
  assert.equal(first.OBJECT_ID, '2026-901A');
  assert.equal(first.NORAD_CAT_ID, 99001);
  assert.equal(first.EPOCH, '2026-10-10T10:16:55.343712');
  assert.equal(first.CREATION_DATE, '2026-10-10T17:33:11');
  assert.equal(first.ORIGINATOR, '18 SPCS');
  assert.equal(first.MEAN_MOTION, 15.49512345);
  assert.equal(first.ECCENTRICITY, 0.0006789);
  assert.equal(first.INCLINATION, 51.6123);
  assert.equal(first.RA_OF_ASC_NODE, 123.4567);
  assert.equal(first.ARG_OF_PERICENTER, 87.6543);
  assert.equal(first.MEAN_ANOMALY, 272.5432);
  assert.equal(first.BSTAR, 0.00034567);
  assert.equal(first.MEAN_MOTION_DOT, 0.00001234);
  assert.equal(first.MEAN_MOTION_DDOT, 0);
  assert.equal(first.ELEMENT_SET_NO, 999);
  assert.equal(first.REV_AT_EPOCH, 12345);
  assert.equal(first.CCSDS_OMM_VERS, 3);
  assert.equal(first.CENTER_NAME, 'EARTH');
  assert.equal(first.MEAN_ELEMENT_THEORY, 0); // SGP4
  assert.equal(first.REFERENCE_FRAME.REFERENCE_FRAME.frame, 5); // TEMEOFDATE
  assert.equal(params(first).GP_ID, '900000001');
  assert.equal(second.NORAD_CAT_ID, 100123);
  assert.equal(second.EPOCH, '2026-10-10T12:00:00.000001');
  assert.equal(second.MEAN_MOTION, 14.2);
  assert.equal(third.NORAD_CAT_ID, 180000);
  const r = report(result);
  assert.deepEqual({ records: r.records, emitted: r.emitted, duplicateGpIds: r.duplicateGpIds, rejected: r.rejected, alpha5: r.alpha5CatalogNumbers },
    { records: 8, emitted: 3, duplicateGpIds: 1, rejected: 4, alpha5: 2 });
  assert.deepEqual(r.rejections, {
    'the catalog number disagrees with TLE_LINE1': 1,
    'MEAN_ELEMENT_THEORY DSST is not SGP4 or SGP4-XP': 1,
    'EPOCH is missing or not an ISO 8601 UTC time': 1,
    'an element is outside its range': 1,
  });
  assert.deepEqual(r.epochRange, ['2026-10-10T10:16:55.343712', '2026-10-10T12:00:00.000001']);
});

test('parse_gp reads JSON lines and an SGP4-XP set, and keeps the order of the input', async (t) => {
  const host = await harness(t);
  const sets = [0, 1, 2].map((k) => synthetic({ gpId: 900000010 + k, epoch: `2026-10-10T0${k}:00:00.000000`, norad: 99010 + k, objectId: `2026-91${k}A` }));
  const lines = sets.map((s, k) => JSON.stringify(gpRecord(s, k === 2 ? { MEAN_ELEMENT_THEORY: 'SGP4-XP' } : {}))).join('\n');
  const omms = records(await host.invoke(request('parse_gp', lines)), 'omm', OMM, '$OMM');
  assert.deepEqual(omms.map((o) => o.NORAD_CAT_ID), [99010, 99011, 99012]);
  assert.deepEqual(omms.map((o) => o.MEAN_ELEMENT_THEORY), [0, 0, 1]);
});

test('parse_satcat: type, owner, dates, altitudes; a decayed object is DECAYED, a zero RCSVALUE is no cross-section, a superseded entry is not an object', async (t) => {
  const host = await harness(t);
  const rows = [
    satcatRecord(),
    satcatRecord({ INTLDES: '2026-902B', OBJECT_ID: '2026-902B', NORAD_CAT_ID: '99002', OBJECT_NUMBER: '99002', SATNAME: 'SYNTH 2 R/B', OBJECT_NAME: 'SYNTH 2 R/B', OBJECT_TYPE: 'ROCKET BODY', COUNTRY: 'CIS',
      DECAY: '2026-05-06', RCSVALUE: '4.25', PERIOD: '88.0', INCLINATION: '65.1', APOGEE: '300', PERIGEE: '120' }),
    satcatRecord({ NORAD_CAT_ID: '100001', OBJECT_NUMBER: '100001', INTLDES: 'TBA - TO BE ASSIGNED', OBJECT_ID: 'TBA - TO BE ASSIGNED', OBJECT_TYPE: 'DEBRIS', COUNTRY: 'XX', SATNAME: 'TBA', OBJECT_NAME: 'TBA' }),
    satcatRecord({ NORAD_CAT_ID: '99001', CURRENT: 'N' }),
    satcatRecord({ NORAD_CAT_ID: '99003', OBJECT_NUMBER: '99003', INTLDES: '2026-903A', OBJECT_ID: '2026-903A', SATNAME: 'SYNTH 3', OBJECT_NAME: 'SYNTH 3', COUNTRY: 'AGO' }),
  ];
  const result = await host.invoke(request('parse_satcat', JSON.stringify(rows)));
  const cats = records(result, 'catalog', CAT, '$CAT');
  assert.equal(cats.length, 4);
  assert.equal(cats[0].NORAD_CAT_ID, 99001);
  assert.equal(cats[0].OBJECT_ID, '2026-901A');
  assert.equal(cats[0].OBJECT_NAME, 'SYNTH 1');
  assert.equal(cats[0].OBJECT_TYPE, 0); // PAYLOAD
  assert.equal(cats[0].LAUNCH_DATE, '2026-01-02');
  assert.equal(cats[0].LAUNCH_SITE, 'AFETR');
  assert.equal(cats[0].PERIOD, 92.1);
  assert.equal(cats[0].INCLINATION, 51.6);
  assert.equal(cats[0].APOGEE, 430);
  assert.equal(cats[0].PERIGEE, 420);
  assert.equal(cats[0].RCS, 0);
  assert.equal(cats[0].OPS_STATUS_CODE, 7); // UNKNOWN: the satellite catalog does not say it is operating
  assert.equal(cats[1].OBJECT_TYPE, 1); // ROCKET_BODY
  assert.equal(cats[1].OPS_STATUS_CODE, 6); // DECAYED
  assert.equal(cats[1].DECAY_DATE, '2026-05-06');
  assert.equal(cats[1].RCS, 4.25);
  assert.equal(cats[2].NORAD_CAT_ID, 100001);
  assert.equal(cats[2].OBJECT_TYPE, 2); // DEBRIS
  assert.equal(cats[2].OBJECT_ID, null); // not an international designator: no join key is made of it
  assert.equal(cats[1].OWNER, legacyCountryCode.CIS);
  assert.equal(cats[2].OWNER, legacyCountryCode.UNK, 'a code the standard does not list is UNK, never the unset first value (AB)');
  assert.equal(cats[3].OWNER, legacyCountryCode.AGO, 'one of the codes SDS 1.246.0 added');
  const r = report(result);
  assert.deepEqual({ records: r.records, emitted: r.emitted, superseded: r.supersededEntries, designators: r.unrepresentedDesignators, countries: r.unrepresentedCountries, decayed: r.decayed },
    { records: 5, emitted: 4, superseded: 1, designators: 1, countries: 1, decayed: 1 });
  assert.deepEqual(r.unrepresentedCountryCodes, { XX: 1 });
});

test('a damaged input is refused whole: no partial output, a code and a message', async (t) => {
  const host = await harness(t);
  const good = JSON.stringify([gpRecord(synthetic())]);
  for (const [name, text] of [['truncated JSON', good.slice(0, -2)], ['not an array of objects', '{"a":1}\n[1,2]'], ['an array of numbers', '[1,2,3]'], ['empty', '  '], ['nothing readable', JSON.stringify([gpRecord(synthetic(), { EPOCH: 'x' })])]]) {
    const result = await host.invoke(request('parse_gp', text));
    assert.notEqual(result.statusCode, 0, name);
    assert.equal(result.outputs?.length ?? 0, 0, `${name}: partial output`);
    assert.ok(result.errorMessage, name);
  }
  assert.equal(records(await host.invoke(request('parse_gp', good)), 'omm', OMM, '$OMM').length, 1);
});

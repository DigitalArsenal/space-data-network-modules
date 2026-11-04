// pvn-labels E2E (modules-source-labels-pvn-20261103): the built module on the recorded input (tests/fixtures/pvn-labels.mjs)
// writes the AOE record id as MESSAGE_ID and AOE's other ids as the $OIL crosswalk on links, never a USER_DEFINED list;
// every label the recorded output carried in the list (pvn-labels.before.json, from the dist before the change) is found
// in its typed home, and every other field and frame equals the recorded output.
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { ByteBuffer } from 'flatbuffers';
import { OMM } from 'spacedatastandards.org/lib/js/OMM/OMM.js';
import { CAT } from 'spacedatastandards.org/lib/js/CAT/CAT.js';
import { OIL } from 'spacedatastandards.org/lib/js/OIL/OIL.js';
import { assertNoUserDefined } from '../../../common/tests/no-user-defined.mjs';
import { BEFORE, RECORDS, drive } from './fixtures/pvn-labels.mjs';

const here = (p) => new URL(p, import.meta.url).pathname;
const manifest = JSON.parse(fs.readFileSync(here('../plugin-manifest.json'), 'utf8'));
function* records(stream) {
  const view = Buffer.from(stream);
  for (let at = 0; at < view.length;) {
    const n = view.readUInt32LE(at);
    yield new Uint8Array(view.subarray(at, at + 4 + n));
    at += 4 + n;
  }
}
const omm = (rec) => OMM.getSizePrefixedRootAsOMM(new ByteBuffer(rec)).unpack();
const CLASS = { PAYLOAD: 0, 'ROCKET BODY': 1, DEBRIS: 2 };

const after = await drive(here('../dist/isomorphic/module.wasm'), here('../plugin-manifest.json'));
const before = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(BEFORE, 'utf8'))).map(([k, v]) => [k, Buffer.from(v, 'base64')]));
assert.deepEqual(Object.keys(after).sort(), ['crosswalk', 'links', 'meta', 'omm']);
assert.deepEqual(Buffer.from(after.crosswalk), before.crosswalk, 'the $CAT crosswalk is unchanged');
assert.deepEqual(Buffer.from(after.meta), before.meta, 'the IngestRequest is unchanged');

const now = [...records(after.omm)];
const then = [...records(before.omm)];
assert.equal(now.length, 5);
assert.equal(then.length, now.length);
let userDefined = 0, differing = 0;
const labels = []; // the recorded output's list, per set
now.forEach((rec, i) => {
  assertNoUserDefined(rec);
  const o = omm(rec);
  const old = omm(then[i]);
  userDefined += o.USER_DEFINED_PARAMETERS.length;
  const p = Object.fromEntries(old.USER_DEFINED_PARAMETERS.map((x) => [x.PARAM_NAME, x.PARAM_VALUE]));
  labels.push({ ...p, NORAD: old.NORAD_CAT_ID, EPOCH: old.EPOCH });
  assert.equal(o.MESSAGE_ID, p.AOE_RECORD_ID, `set ${i}: MESSAGE_ID is AOE_RECORD_ID`);
  for (const x of [o, old]) { delete x.USER_DEFINED_PARAMETERS; delete x.MESSAGE_ID; }
  try { assert.deepEqual(o, old); } catch { differing++; }
});
assert.equal(userDefined, 0);
assert.equal(differing, 0, 'fields outside the labels differ from the recorded output');

// The $OIL: the newest recorded set of each AOE object, its ids as identifiers and links.
const oil = OIL.getRootAsOIL(new ByteBuffer(new Uint8Array(after.links))).unpack();
assert.equal(new TextDecoder().decode(after.links.subarray(4, 8)), '$OIL');
const newest = new Map();
for (const l of labels) {
  const key = l.AOE_CAT_ID ?? l.AOE_SAT_ID;
  if (!newest.has(key) || l.EPOCH >= newest.get(key).EPOCH) newest.set(key, l);
}
const expected = [];
for (const l of [...newest.values()].sort((a, b) => Number(a.AOE_CAT_ID ?? a.AOE_SAT_ID) - Number(b.AOE_CAT_ID ?? b.AOE_SAT_ID))) {
  const left = { NAMESPACE: l.AOE_CAT_ID ? 'aoe-cat' : 'aoe-sat', ID: l.AOE_CAT_ID ?? l.AOE_SAT_ID, TRAJECTORY_ID: l.AOE_RECORD_ID };
  const evidence = { SOURCE: `aoe/${l.AOE_CHANNEL}`, RECORD_ID: l.AOE_LAST_UPDATE_ID };
  if (l.NORAD) expected.push([left, { NAMESPACE: 'NORAD', ID: String(l.NORAD), NORAD_CAT_ID: l.NORAD }, evidence]);
  if (l.AOE_CAT_ID && l.AOE_SAT_ID) expected.push([left, { NAMESPACE: 'aoe-sat', ID: l.AOE_SAT_ID }, evidence]);
}
const got = oil.LINKS.map((k) => [
  { NAMESPACE: k.LEFT.NAMESPACE, ID: k.LEFT.ID, TRAJECTORY_ID: k.LEFT.TRAJECTORY_ID },
  k.RIGHT.NAMESPACE === 'NORAD' ? { NAMESPACE: 'NORAD', ID: k.RIGHT.ID, NORAD_CAT_ID: k.RIGHT.NORAD_CAT_ID } : { NAMESPACE: k.RIGHT.NAMESPACE, ID: k.RIGHT.ID },
  { SOURCE: k.EVIDENCE.SOURCE, RECORD_ID: k.EVIDENCE.RECORD_ID },
]);
assert.deepEqual(got, expected);
assert.equal(oil.LINK_COUNT, expected.length);
assert.equal(oil.LINKS.find((k) => k.LEFT.ID === '99001').EVIDENCE.DECLARATIONS, 2, 'object 99001 is declared by two sets');
assert.equal(oil.PROVIDER, 'spacemapper-aoe');
assert.equal(oil.ROWS, RECORDS.length);
assert.equal(oil.DUPLICATE_LINES, 1);
// AOE_OBJECT_TYPE: the $CAT crosswalk's OBJECT_TYPE.
const cats = [...records(after.crosswalk)].map((rec) => CAT.getSizePrefixedRootAsCAT(new ByteBuffer(rec)).unpack());
for (const l of newest.values()) {
  const cat = cats.find((c) => c.CATALOG_OBJECT_ID === `aoe:${l.AOE_CAT_ID ?? l.AOE_SAT_ID}`);
  assert.equal(cat.OBJECT_TYPE, CLASS[l.AOE_OBJECT_TYPE] ?? 3, `aoe:${l.AOE_CAT_ID}: OBJECT_TYPE`);
}
console.log(`PVN-LABELS spacemapper-aoe-source ${manifest.version}: ${now.length} $OMM, ${userDefined} USER_DEFINED_PARAMETERS, MESSAGE_ID = AOE record id on ${now.length}; $OIL ${oil.LINKS.length} links over ${newest.size} AOE objects (AOE_CAT_ID, AOE_SAT_ID as identifiers, AOE_CHANNEL as EVIDENCE.SOURCE, AOE_LAST_UPDATE_ID as EVIDENCE.RECORD_ID, AOE_RECORD_ID as TRAJECTORY_ID) equal to the recorded labels; ${newest.size} $CAT OBJECT_TYPE equal to AOE_OBJECT_TYPE; ${differing} sets differ outside the labels; $CAT and IngestRequest byte-identical`);

// pvn-labels E2E (modules-source-labels-pvn-20261103): the built module on the recorded input (tests/fixtures/pvn-labels.mjs)
// writes GP_ID as MESSAGE_ID, never a USER_DEFINED list, and dedupes on it; an EPHEMERIS_TYPE 4 set is an SGP4-XP set with
// BTERM in BSTAR and AGOM in MEAN_MOTION_DDOT; every other field equals the output recorded from the dist before the
// change (pvn-labels.before.json).
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { ByteBuffer } from 'flatbuffers';
import { OMM } from 'spacedatastandards.org/lib/js/OMM/OMM.js';
import { meanElementSource } from 'spacedatastandards.org/lib/js/OMM/meanElementSource.js';
import { decodeFlowNotice } from 'space-data-module-sdk/runtime-contracts';
import { assertNoUserDefined } from '../../../common/tests/no-user-defined.mjs';
import { BEFORE, SETS, TYPE4, drive } from './fixtures/pvn-labels.mjs';

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
const unpack = (rec) => OMM.getSizePrefixedRootAsOMM(new ByteBuffer(rec)).unpack();

const after = await drive(here('../dist/isomorphic/module.wasm'), here('../plugin-manifest.json'));
const before = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(BEFORE, 'utf8'))).map(([k, v]) => [k, Buffer.from(v, 'base64')]));
const now = [...records(after.omm)];
const then = [...records(before.omm)];
const expected = [SETS[0], SETS[1]]; // SETS[2] repeats SETS[0]'s GP_ID: dropped
assert.equal(now.length, expected.length);
assert.equal(then.length, expected.length);

let userDefined = 0, xp = 0, differing = 0;
now.forEach((rec, i) => {
  assertNoUserDefined(rec);
  const o = unpack(rec);
  userDefined += o.USER_DEFINED_PARAMETERS.length;
  assert.equal(o.MESSAGE_ID, expected[i].GP_ID);
  if (expected[i].EPHEMERIS_TYPE === '4') {
    xp++;
    assert.equal(o.MEAN_ELEMENT_THEORY, meanElementSource.SGP4XP);
    assert.equal(o.BSTAR, Number(TYPE4.BSTAR), 'BTERM lands in BSTAR');
    assert.equal(o.MEAN_MOTION_DDOT, Number(TYPE4.MEAN_MOTION_DDOT), 'AGOM lands in MEAN_MOTION_DDOT');
  } else {
    assert.equal(o.MEAN_ELEMENT_THEORY, meanElementSource.SGP4);
  }
  const old = unpack(then[i]);
  assert.deepEqual(old.USER_DEFINED_PARAMETERS.map((p) => [p.PARAM_NAME, p.PARAM_VALUE]), [['GP_ID', expected[i].GP_ID]], 'the recorded output carried GP_ID in the list');
  for (const x of [o, old]) { delete x.USER_DEFINED_PARAMETERS; delete x.MESSAGE_ID; delete x.MEAN_ELEMENT_THEORY; }
  try { assert.deepEqual(o, old); } catch { differing++; }
});
assert.equal(userDefined, 0);
assert.equal(xp, 1);
assert.equal(differing, 0, 'fields outside the labels differ from the recorded output');
const items = (n) => Object.fromEntries(decodeFlowNotice(n).items.map((s) => s.split('=')));
const report = items(after.report);
assert.equal(report.duplicateGpIds, '1');
assert.equal(report['meanElementTheories.SGP4'], '1');
assert.equal(report['meanElementTheories.SGP4XP'], '1');
console.log(`PVN-LABELS spacetrack-source ${manifest.version}: ${now.length} $OMM of ${SETS.length} sets (1 duplicate MESSAGE_ID dropped), ${userDefined} USER_DEFINED_PARAMETERS, MESSAGE_ID = GP_ID on ${now.length}; ${xp} EPHEMERIS_TYPE 4 set SGP4XP with BTERM ${TYPE4.BSTAR} in BSTAR and AGOM ${TYPE4.MEAN_MOTION_DDOT} in MEAN_MOTION_DDOT; ${differing} records differ from the recorded output outside the labels`);

// pvn-labels E2E (modules-source-labels-pvn-20261103): the built module on the recorded input (test/fixtures/pvn-labels.mjs)
// labels its $OMM records with typed PROVENANCE, never a USER_DEFINED list or a COMMENT copy; an EPHEMERIS_TYPE 4 row is
// an SGP4-XP set with BTERM in BSTAR and AGOM in MEAN_MOTION_DDOT; every other field equals the output recorded from
// the dist before the change (pvn-labels.before.json).
import assert from "node:assert/strict";
import fs from "node:fs";

import { ByteBuffer } from "flatbuffers";
import { OMM, meanElementSource } from "spacedatastandards.org/lib/js/OMM/main.js";
import { assertNoUserDefined } from "../../../common/tests/no-user-defined.mjs";
import { BEFORE, TYPE4, body, drive } from "./fixtures/pvn-labels.mjs";

const here = (p) => new URL(p, import.meta.url).pathname;
const manifest = JSON.parse(fs.readFileSync(here("../plugin-manifest.json"), "utf8"));
function* records(stream) {
  const view = Buffer.from(stream);
  for (let at = 0; at < view.length;) {
    const n = view.readUInt32LE(at);
    yield new Uint8Array(view.subarray(at, at + 4 + n));
    at += 4 + n;
  }
}
const unpack = (rec) => OMM.getSizePrefixedRootAsOMM(new ByteBuffer(rec)).unpack();

const after = await drive(here("../dist/isomorphic/module.wasm"), here("../plugin-manifest.json"));
const before = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(BEFORE, "utf8"))).map(([k, v]) => [k, Buffer.from(v, "base64")]));
const feed = JSON.parse(new TextDecoder().decode(body()));
const now = [...records(after.omm_records)];
const then = [...records(before.omm_records)];
assert.equal(now.length, then.length);
assert.ok(now.length > 1);

let userDefined = 0, xp = 0, differing = 0;
now.forEach((rec, i) => {
  assertNoUserDefined(rec);
  const o = unpack(rec);
  const f = feed[i];
  userDefined += o.USER_DEFINED_PARAMETERS.length;
  const p = o.PROVENANCE;
  assert.ok(p, `record ${i}: no PROVENANCE`);
  assert.equal(p.SOURCE_ID, "ses");
  assert.equal(p.ORIGINATOR, "CelesTrak SupGP");
  assert.equal(p.PROVIDER_ID, manifest.pluginId);
  assert.equal(p.PRODUCER, `${manifest.pluginId} ${manifest.version}`);
  assert.equal(p.LINEAGE, f.DATA_SOURCE);
  const sourceLines = o.COMMENT.split("\n").filter((line) => /SOURCE/i.test(line));
  assert.deepEqual(sourceLines, [], `record ${i}: COMMENT has a SOURCE line`);
  if (f.EPHEMERIS_TYPE === 4) {
    xp++;
    assert.equal(o.MEAN_ELEMENT_THEORY, meanElementSource.SGP4XP);
    assert.equal(o.BSTAR, TYPE4.BSTAR, "BTERM lands in BSTAR");
    assert.equal(o.MEAN_MOTION_DDOT, TYPE4.MEAN_MOTION_DDOT, "AGOM lands in MEAN_MOTION_DDOT");
  } else {
    assert.equal(o.MEAN_ELEMENT_THEORY, meanElementSource.SGP4);
  }
  const old = unpack(then[i]);
  for (const x of [o, old]) { delete x.COMMENT; delete x.USER_DEFINED_PARAMETERS; delete x.PROVENANCE; delete x.MEAN_ELEMENT_THEORY; }
  try { assert.deepEqual(o, old); } catch { differing++; }
});
assert.equal(userDefined, 0);
assert.equal(xp, 1);
assert.equal(differing, 0, "fields outside the labels differ from the recorded output");
assert.deepEqual(Object.keys(after), ["omm_meta", "omm_records", "raw"]);
assert.deepEqual(Buffer.from(after.raw), before.raw, "the raw response is unchanged");
console.log(`PVN-LABELS celestrak-supgp ${manifest.version}: ${now.length} $OMM, ${userDefined} USER_DEFINED_PARAMETERS, PVN SOURCE_ID ses ORIGINATOR "CelesTrak SupGP" PROVIDER_ID ${manifest.pluginId} LINEAGE ${feed[0].DATA_SOURCE}; ${xp} EPHEMERIS_TYPE 4 row SGP4XP with BTERM ${TYPE4.BSTAR} in BSTAR and AGOM ${TYPE4.MEAN_MOTION_DDOT} in MEAN_MOTION_DDOT; 0 COMMENT SOURCE lines; ${differing} records differ from the recorded output outside the labels`);

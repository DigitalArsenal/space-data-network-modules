// pvn-labels E2E (modules-source-labels-pvn-20261103): the built module on the recorded input (test/fixtures/pvn-labels.mjs)
// emits each winner as the stored $OMM byte for byte, never with a USER_DEFINED list, and its decision as one $CAT per
// object (consult sds-ocm-record-consult-20261103 section 2.5, owner decision D7): the winner found through
// CATProduct.RECORD_CID equals the stored record's CID, and every label the recorded output (pvn-labels.before.json, from
// the dist before the change) carried in the list is found in its typed home or is one the consult dropped.
import assert from "node:assert/strict";
import fs from "node:fs";

import { ByteBuffer } from "flatbuffers";
import { OMM } from "spacedatastandards.org/lib/js/OMM/OMM.js";
import { CAT } from "spacedatastandards.org/lib/js/CAT/CAT.js";
import { catalogProductKind } from "spacedatastandards.org/lib/js/CAT/catalogProductKind.js";
import { meanElementSource } from "spacedatastandards.org/lib/js/OMM/meanElementSource.js";
import { assertNoUserDefined } from "../../../common/tests/no-user-defined.mjs";
import { BEFORE, RECORDS, WINNERS, drive } from "./fixtures/pvn-labels.mjs";

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

const after = await drive(here("../dist/isomorphic/module.wasm"), here("../plugin-manifest.json"));
const before = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(BEFORE, "utf8"))).map(([k, v]) => [k, v.map((x) => Buffer.from(x, "base64"))]));
assert.deepEqual(Object.keys(after), ["omm_meta", "omm_records", "catalog", "status"]);
assert.deepEqual(after.status.map((x) => Buffer.from(x)), before.status, "the FlowNotices are unchanged");

const omms = [...records(after.omm_records[0])];
const cats = [...records(after.catalog[0])].map((rec) => CAT.getSizePrefixedRootAsCAT(new ByteBuffer(rec)).unpack());
const old = [...records(before.omm_records[0])].map((rec) => {
  const o = OMM.getSizePrefixedRootAsOMM(new ByteBuffer(rec)).unpack();
  return { norad: o.NORAD_CAT_ID, params: Object.fromEntries(o.USER_DEFINED_PARAMETERS.map((p) => [p.PARAM_NAME, p.PARAM_VALUE])) };
});
const norads = Object.keys(WINNERS).map(Number);
assert.equal(omms.length, norads.length);
assert.equal(cats.length, norads.length);
assert.equal(old.length, norads.length);

let userDefined = 0, byteEqual = 0, xp = 0;
omms.forEach((rec, i) => {
  assertNoUserDefined(rec);
  const o = OMM.getSizePrefixedRootAsOMM(new ByteBuffer(rec));
  userDefined += o.userDefinedParametersLength();
  const norad = o.NORAD_CAT_ID();
  assert.equal(norad, norads[i]);
  const cat = cats[i];
  assert.equal(cat.NORAD_CAT_ID, norad);
  assert.equal(cat.PRODUCTS.length, 1);
  const [product] = cat.PRODUCTS;
  const [cid, rule] = WINNERS[norad];
  // The winner through the typed home: RECORD_CID names the stored record, and the emitted $OMM is that record.
  assert.equal(product.RECORD_CID, cid);
  const stored = RECORDS.find((r) => r.CID === product.RECORD_CID);
  assert.deepEqual(Buffer.from(rec.subarray(4)), Buffer.from(stored.Data), `NORAD ${norad}: the emitted $OMM is the stored record byte for byte`);
  byteEqual++;
  // The recorded labels, field by field.
  const p = old[i].params;
  assert.equal(old[i].norad, norad);
  assert.equal(product.RECORD_CID, p.SDN_CATALOG_SOURCE_CID);
  assert.equal(product.SOURCE_ID, p.SDN_CATALOG_SOURCE_NAME);
  assert.equal(product.SELECTION_REASON, p.SDN_CATALOG_PRECEDENCE);
  assert.equal(product.SELECTION_REASON, rule);
  assert.equal(product.SOURCE_ID, stored.SourceTags.SourceName);
  const theory = o.MEAN_ELEMENT_THEORY();
  if (theory === meanElementSource.SGP4XP) xp++;
  assert.equal(product.KIND, theory === meanElementSource.SGP4XP ? catalogProductKind.Sgp4XpElements : catalogProductKind.Sgp4Elements);
  assert.equal(product.EPOCH, o.EPOCH());
  assert.equal(cat.OBJECT_NAME, o.OBJECT_NAME());
  assert.equal(cat.OBJECT_ID, o.OBJECT_ID());
});
assert.equal(userDefined, 0);
assert.equal(xp, 1);
console.log(`PVN-LABELS catalog-synthesis ${manifest.version}: ${omms.length} $OMM winners, ${userDefined} USER_DEFINED_PARAMETERS, ${byteEqual} byte-equal to the stored record whose CID $CAT PRODUCTS[0].RECORD_CID names; ${cats.length} $CAT (SDN_CATALOG_SOURCE_CID -> RECORD_CID, SDN_CATALOG_SOURCE_NAME -> SOURCE_ID, SDN_CATALOG_PRECEDENCE -> SELECTION_REASON, SDN_CATALOG_SOURCE_KIND -> KIND, ${xp} Sgp4XpElements; GATE_STATUS, BATCH, COMMENT dropped); FlowNotices byte-identical`);

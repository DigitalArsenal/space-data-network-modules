// The recorded SATCAT identity fields encoded as canonical stored CAT records.
// This fixture reads no network and carries no element sets or orbital calculations.
import fs from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {Builder, ByteBuffer} from 'flatbuffers';
import assert from 'node:assert/strict';
import {CAT, CATT} from 'spacedatastandards.org/lib/js/CAT/CAT.js';

export const SATCAT_URL = 'https://celestrak.org/pub/satcat.csv';
const original = JSON.parse(gunzipSync(fs.readFileSync(new URL('./fixtures/cassette.json.gz', import.meta.url)))).responses[SATCAT_URL];
export function storedCatRecords(peer, entry = original) {
  if (entry.status !== 200) return [];
  const lines = entry.body.trim().split('\n');
  const head = lines.shift().split(',');
  return lines.map(line => {
    const values = line.split(',');
    const row = Object.fromEntries(head.map((name, i) => [name, values[i]]));
    const cat = new CATT();
    cat.OBJECT_NAME = row.OBJECT_NAME;
    cat.OBJECT_ID = row.OBJECT_ID;
    cat.NORAD_CAT_ID = Number(row.NORAD_CAT_ID);
    cat.OBJECT_TYPE = {PAY: 0, 'R/B': 1, DEB: 2}[row.OBJECT_TYPE] ?? 3;
    cat.LAUNCH_DATE = row.LAUNCH_DATE;
    cat.DECAY_DATE = row.DECAY_DATE;
    const b = new Builder(256);
    CAT.finishCATBuffer(b, cat.pack(b));
    return {CID: 'fixture-cat-' + cat.NORAD_CAT_ID, Timestamp: new Date(entry.retrievedMs).toISOString(),
      SourceTags: {ProviderID: 'fixture-producer', SourceName: 'celestrak-satcat-csv', ProducerPeerID: peer}, Data: b.asUint8Array()};
  });
}

export function catIdentity(record) { return CAT.getRootAsCAT(new ByteBuffer(record.Data)).unpack(); }

// An unrelated catalog larger than the node's 1,000-row query cap precedes the
// recorded source, proving the module never depends on an unfiltered CAT read.
export function withUnrelatedCatalog(stored) {
  const unrelated = Array.from({length: 1100}, (_, i) => {
    const cat = new CATT(); cat.NORAD_CAT_ID = 90000000 + i; cat.OBJECT_NAME = 'UNRELATED TEST CATALOG ' + i;
    const b = new Builder(128); CAT.finishCATBuffer(b, cat.pack(b));
    return {CID:'unrelated-'+i, Timestamp:'2026-11-05T00:00:00Z', SourceTags:{SourceName:'unrelated-test-catalog',ProducerPeerID:'other-producer'},Data:b.asUint8Array()};
  });
  return [...unrelated, ...stored];
}

export function discoveryRows(stored, sql, params) {
  assert.match(sql, /^SELECT DISTINCT NORAD_CAT_ID FROM CAT WHERE NORAD_CAT_ID > \? AND \(NORAD_CAT_ID IN \(/);
  assert.match(sql, /\) ORDER BY NORAD_CAT_ID LIMIT 32$/);
  assert.equal(params[0].t, 'i64');
  const cursor = Number(params[0].v);
  const wanted = new Set(params.slice(1).filter(p => p.t === 'i64').map(p => Number(p.v)));
  const prefixes = params.slice(1).filter(p => p.t === 'str').map(p => {
    assert.match(p.v, /^[A-Z]+-%$/); return p.v.slice(0,-1);
  });
  return [...new Set(stored.map(catIdentity).filter(r => r.NORAD_CAT_ID > cursor &&
    (wanted.has(r.NORAD_CAT_ID) || prefixes.some(p => r.OBJECT_NAME.startsWith(p)))).map(r => r.NORAD_CAT_ID))]
    .sort((a,b) => a-b).slice(0,32).map(NORAD_CAT_ID => ({NORAD_CAT_ID}));
}

export function exactIdentityRows(stored, params) {
  assert.equal(params.schema, 'CAT.fbs'); assert.equal(params.limit, 1000);
  assert.ok(params.norad_cat_id > 0, 'every identity read has a NORAD predicate');
  return stored.filter(r => catIdentity(r).NORAD_CAT_ID === params.norad_cat_id).slice(0,1000);
}

// The recorded SATCAT identity fields encoded as canonical stored CAT records.
// This fixture reads no network and carries no element sets or orbital calculations.
import fs from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {Builder} from 'flatbuffers';
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

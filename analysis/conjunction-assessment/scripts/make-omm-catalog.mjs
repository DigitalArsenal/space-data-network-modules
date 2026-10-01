// GP JSON (Space-Track class gp, or CelesTrak FORMAT=json) to the catalog file
// the all-vs-all runners read: one $OMM record per object, each prefixed by its
// u32 big-endian length.
//
// usage: node scripts/make-omm-catalog.mjs <gp.json> <out.OMM.uint32be.bin>
import fs from 'node:fs';
import { gpRecord, initCqrFlatc, publishedSchema } from '../tests/lib/cqr.mjs';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('usage: make-omm-catalog.mjs <gp.json> <out.OMM.uint32be.bin>');

const TEXT = ['OBJECT_NAME', 'OBJECT_ID', 'EPOCH', 'CLASSIFICATION_TYPE'];
const NUMBER = ['NORAD_CAT_ID', 'MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION', 'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER',
  'MEAN_ANOMALY', 'ELEMENT_SET_NO', 'REV_AT_EPOCH', 'BSTAR', 'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT'];

const flatc = await initCqrFlatc();
const schema = publishedSchema('OMM');
const parts = [];
let skipped = 0;
for (const g of JSON.parse(fs.readFileSync(input, 'utf8'))) {
  // Space-Track sends numbers as strings, and fields the OMM schema does not hold.
  const gp = {};
  for (const k of TEXT) if (g[k] != null && g[k] !== '') gp[k] = String(g[k]);
  for (const k of NUMBER) if (g[k] != null && g[k] !== '') gp[k] = Number(g[k]);
  if (!gp.EPOCH || !Number.isFinite(gp.MEAN_MOTION) || !Number.isFinite(gp.NORAD_CAT_ID)) { skipped++; continue; }
  const record = flatc.generateBinary(schema, JSON.stringify(gpRecord(gp)), { sizePrefix: false });
  const length = Buffer.alloc(4);
  length.writeUInt32BE(record.length);
  parts.push(length, Buffer.from(record));
}
fs.writeFileSync(output, Buffer.concat(parts));
console.log(`${output}: ${parts.length / 2} objects${skipped ? `, ${skipped} skipped (no epoch or mean motion)` : ''}`);

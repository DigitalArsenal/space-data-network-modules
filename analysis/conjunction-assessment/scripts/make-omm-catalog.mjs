// GP JSON (Space-Track class gp, or CelesTrak FORMAT=json) to the catalog file
// the all-vs-all runners read: one $OMM record per object, each prefixed by its
// u32 big-endian length.
//
// usage: node scripts/make-omm-catalog.mjs <gp.json> <out.OMM.uint32be.bin>
import fs from 'node:fs';
import { catalogFile, createOmmEncoder } from './lib/ommCatalog.mjs';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('usage: make-omm-catalog.mjs <gp.json> <out.OMM.uint32be.bin>');

const encode = await createOmmEncoder();
const records = [];
let skipped = 0;
for (const g of JSON.parse(fs.readFileSync(input, 'utf8'))) {
  const record = encode(g);
  if (record) records.push(record); else skipped++;
}
fs.writeFileSync(output, catalogFile(records));
console.log(`${output}: ${records.length} objects${skipped ? `, ${skipped} skipped (no epoch or mean motion)` : ''}`);

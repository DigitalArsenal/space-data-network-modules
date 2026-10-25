#!/usr/bin/env node
// Writes a source field as the $SHC record the module's gravity_field input reads: the Moon's GRGM660PRIM to its whole degree
// (660), from the PDS table scripts/fetch-planetary-sources.mjs downloads and verifies against its pinned SHA-256.
//
//   node scripts/make-gravity-field-input.mjs <sources-dir> <out.shc> [grgm660prim|mro120f]
//
// The record carries the table's own numbers, converted to the SHC units (GM in m^3/s^2, reference radius in meters): the
// table's header gives km^3/s^2 and km. License and redistribution of the source are in planetary-sources.json (NASA PDS, no use
// restriction); the record is derived data written to wherever the caller says and is not committed (about 4.4 MB at degree 660).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '../package.json'));
const [sources, out, key = 'grgm660prim'] = process.argv.slice(2);
if (!sources || !out) throw new Error('usage: make-gravity-field-input.mjs <sources-dir> <out.shc> [grgm660prim|mro120f]');
const spec = JSON.parse(fs.readFileSync(path.join(here, 'planetary-sources.json'), 'utf8')).sources[key];
if (!spec) throw new Error(`Unknown source ${key}`);
const NAIF = { grgm660prim: [301, 'GRGM660PRIM', 'Moon'], mro120f: [499, 'MRO120F', 'Mars'] }[key];
const bytes = fs.readFileSync(path.join(sources, spec.directory, spec.file));
const digest = crypto.createHash('sha256').update(bytes).digest('hex');
if (digest !== spec.sha256) throw new Error(`${spec.file}: SHA-256 ${digest} differs from the pinned ${spec.sha256}`);

const lines = bytes.toString('latin1').split(/\r?\n/).filter((l) => l.trim().length);
const [radiusKm, gmKm3S2, , degree, order, normalization] = lines[0].split(',').map(Number);
if (normalization !== 1) throw new Error(`${spec.file}: coefficients are not fully normalized`);
const D = [], O = [], C = [], S = [];
for (const line of lines.slice(1)) {
  const f = line.split(',');
  const n = Number(f[0]), m = Number(f[1]);
  if (n < 2) continue;   // degrees 0 and 1 are the point mass and the frame's origin, which no field here carries
  D.push(n); O.push(m); C.push(Number(f[2])); S.push(Number(f[3]));
}
const flatbuffers = await import(pathToFileURL(require.resolve('flatbuffers')));
const shc = await import(pathToFileURL(path.join(path.dirname(require.resolve('spacedatastandards.org/package.json')), 'lib/js/SHC/main.js')));
const record = Object.assign(new shc.SHCT(), {
  MODEL_NAME: NAIF[1], CENTRAL_BODY_NAIF_ID: NAIF[0], BODY_NAME: NAIF[2],
  GM: gmKm3S2 * 1e9, REFERENCE_RADIUS: radiusKm * 1e3, MAX_DEGREE: degree, MAX_ORDER: order,
  NORMALIZATION: shc.shcNormalization.FULLY_NORMALIZED, PERMANENT_TIDE_SYSTEM: shc.shcTideSystem.UNSPECIFIED,
  DEGREES: D, ORDERS: O, C, S, SOURCE: `${spec.file} sha256 ${spec.sha256}`, CITATION: spec.citation,
});
const builder = new flatbuffers.Builder(1 << 24);
builder.finish(record.pack(builder), '$SHC');
fs.writeFileSync(out, builder.asUint8Array());
console.log(`${NAIF[1]}: ${D.length} coefficients to degree ${degree}, ${builder.asUint8Array().length} bytes -> ${out}`);

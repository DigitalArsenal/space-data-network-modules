#!/usr/bin/env node
// Writes lib/egm2008_data.h as an ICGEM .gfc file so Orekit evaluates the
// SAME coefficients HPOP embeds. This isolates the implementations: a
// difference between HPOP and Orekit is then a difference in how the field is
// evaluated, never in which numbers were used. (Whether the embedded numbers
// are EGM2008's is a separate check against the published ICGEM file.)
//
//   node tests/fixtures/orekit/make-gfc.mjs <out.gfc> [maxDegree] [gmM3S2] [radiusM]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const header = fs.readFileSync(path.resolve(here, '../../../lib/egm2008_data.h'), 'utf8');
const [out, maxDegree = '70', gm = '3.986004418e14', radius = '6378137.0'] = process.argv.slice(2);
if (!out) throw new Error('usage: make-gfc.mjs <out.gfc> [maxDegree] [gmM3S2] [radiusM]');
const records = [...header.matchAll(/\{\s*(\d+),\s*(\d+),\s*([-+0-9.eE]+),\s*([-+0-9.eE]+)\s*\}/g)]
  .map((m) => ({ n: Number(m[1]), m: Number(m[2]), c: m[3], s: m[4] }))
  .filter((r) => r.n <= Number(maxDegree));
const lines = [
  'begin_of_head ==================================================================',
  'product_type              gravity_field',
  'modelname                 EGM2008-as-embedded-in-hpop',
  `earth_gravity_constant    ${gm}`,
  `radius                    ${radius}`,
  `max_degree                ${maxDegree}`,
  'errors                    no',
  'norm                      fully_normalized',
  'tide_system               tide_free',
  '',
  'key     L    M         C                      S',
  'end_of_head ====================================================================',
  'gfc     0    0  1.0  0.0',
  ...records.map((r) => `gfc ${String(r.n).padStart(4)} ${String(r.m).padStart(4)}  ${r.c}  ${r.s}`),
];
fs.writeFileSync(out, `${lines.join('\n')}\n`);
console.log(`wrote ${records.length} coefficient records to degree ${maxDegree} into ${out}`);

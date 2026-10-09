#!/usr/bin/env node
// Writes the Earth orientation rows Orekit read (IERS finals2000A.all, the
// file in Orekit's data directory) as a size-prefixed $EOP stream, so HPOP's
// earth_orientation input carries exactly the same values.
//
// finals2000A.all is fixed-column (IERS, readme.finals2000A): MJD 8-15,
// PM-x 19-27 and PM-y 38-46 (arcsec), UT1-UTC 59-68 (s), LOD 80-86 (ms),
// dX 98-106 and dY 117-125 (mas), all IERS Bulletin A values. A blank LOD is 0.
//
//   node tests/fixtures/orekit/make-eop.mjs <finals2000A.all> <fromMJD> <toMJD> <out.json>
import fs from 'node:fs';
import crypto from 'node:crypto';
import * as flatbuffers from 'flatbuffers';
import { EOP, EOPT, eopSeries, iauPrecessionNutationModel } from 'spacedatastandards.org/lib/js/EOP/main.js';

const [file, from, to, out] = process.argv.slice(2);
if (!out) throw new Error('usage: make-eop.mjs <finals2000A.all> <fromMJD> <toMJD> <out.json>');
const raw = fs.readFileSync(file);
const ARCSEC = Math.PI / 648000;
const col = (line, a, b) => line.slice(a - 1, b).trim();
const rows = [];
for (const line of raw.toString('latin1').split('\n')) {
  const mjd = Number(col(line, 8, 15));
  if (!(mjd >= Number(from) && mjd <= Number(to))) continue;
  const num = (a, b) => { const t = col(line, a, b); return t === '' ? 0 : Number(t); };
  rows.push({
    mjd,
    xPoleArcsec: num(19, 27), yPoleArcsec: num(38, 46), ut1MinusUtcS: num(59, 68),
    lodMs: num(80, 86), dXMas: num(98, 106), dYMas: num(117, 125),
  });
}
const date = (mjd) => new Date((mjd - 40587) * 86400000).toISOString().replace('.000Z', 'Z');
const parts = rows.map((r) => {
  const t = new EOPT();
  t.DATE = date(r.mjd);
  t.MJD = r.mjd;
  t.X_POLE_WANDER_RADIANS = t.X_POLE_WANDER_RADIANS_HP = r.xPoleArcsec * ARCSEC;
  t.Y_POLE_WANDER_RADIANS = t.Y_POLE_WANDER_RADIANS_HP = r.yPoleArcsec * ARCSEC;
  t.UT1_MINUS_UTC_SECONDS = t.UT1_MINUS_UTC_SECONDS_HP = r.ut1MinusUtcS;
  t.LENGTH_OF_DAY_CORRECTION_SECONDS = t.LENGTH_OF_DAY_CORRECTION_SECONDS_HP = r.lodMs / 1000;
  t.X_CELESTIAL_POLE_OFFSET_RADIANS = t.X_CELESTIAL_POLE_OFFSET_RADIANS_HP = (r.dXMas / 1000) * ARCSEC;
  t.Y_CELESTIAL_POLE_OFFSET_RADIANS = t.Y_CELESTIAL_POLE_OFFSET_RADIANS_HP = (r.dYMas / 1000) * ARCSEC;
  t.SERIES = eopSeries.FINALS2000A;
  t.IAU_CONVENTION = iauPrecessionNutationModel.IAU_2000A;
  const b = new flatbuffers.Builder(512);
  EOP.finishSizePrefixedEOPBuffer(b, t.pack(b));
  return Buffer.from(b.asUint8Array());
});
fs.writeFileSync(out, `${JSON.stringify({
  source: 'IERS finals2000A.all (Bulletin A columns), the file in the Orekit data directory used for orekit-reference.json',
  sha256: crypto.createHash('sha256').update(raw).digest('hex'),
  rows,
  payloadBase64: Buffer.concat(parts).toString('base64'),
}, null, 1)}\n`);
console.log(`wrote ${rows.length} EOP rows (MJD ${from}..${to}) to ${out}`);

#!/usr/bin/env node
// Writes the JB2008 drivers Orekit read (Space Environment Technologies'
// SOLFSMY.TXT and DTCFILE.TXT, the files in Orekit's data directory) for a
// range of days as PRWJB2008Indices rows, so HPOP's jb2008_indices input
// carries exactly the same values.
//
// SOLFSMY.TXT: YYYY DDD JulianDay F10 F81c S10 S81c M10 M81c Y10 Y81c Ssrc
// (SFU, reported at 12 UT). DTCFILE.TXT: "DTC" YYYY DDD and 24 hourly DTC (K).
//
//   node tests/fixtures/orekit/make-jb2008.mjs <SOLFSMY.TXT> <DTCFILE.TXT> <fromYYYY-MM-DD> <toYYYY-MM-DD> <out.json>
import fs from 'node:fs';
import crypto from 'node:crypto';

const [solFile, dtcFile, from, to, out] = process.argv.slice(2);
if (!out) throw new Error('usage: make-jb2008.mjs <SOLFSMY.TXT> <DTCFILE.TXT> <from> <to> <out.json>');
const iso = (year, doy) => new Date(Date.UTC(year, 0, doy)).toISOString().slice(0, 10);
const sol = new Map(), dtc = new Map();
const solText = fs.readFileSync(solFile, 'latin1'), dtcText = fs.readFileSync(dtcFile, 'latin1');
for (const line of solText.split(/\r?\n/)) {
  const t = line.trim().split(/\s+/);
  if (t.length < 12 || line.trim().startsWith('#')) continue;
  const [y, d] = [Number(t[0]), Number(t[1])];
  if (!Number.isInteger(y) || !Number.isInteger(d)) continue;
  sol.set(iso(y, d), { F10: +t[3], F10_CENTRED_81: +t[4], S10: +t[5], S10_CENTRED_81: +t[6], M10: +t[7], M10_CENTRED_81: +t[8],
    Y10: +t[9], Y10_CENTRED_81: +t[10], SOURCE_FLAGS: t[11] });
}
for (const line of dtcText.split(/\r?\n/)) {
  const t = line.trim().split(/\s+/);
  if (t[0] !== 'DTC' || t.length < 27) continue;
  dtc.set(iso(Number(t[1]), Number(t[2])), t.slice(3, 27).map(Number));
}
const rows = [];
for (let day = new Date(`${from}T00:00:00Z`); day <= new Date(`${to}T00:00:00Z`); day = new Date(day.getTime() + 86400000)) {
  const date = day.toISOString().slice(0, 10);
  if (!sol.has(date) || !dtc.has(date)) throw new Error(`No SOLFSMY or DTCFILE row for ${date}`);
  rows.push({ DATE: date, ...sol.get(date), DTC_HOURLY_K: dtc.get(date) });
}
fs.writeFileSync(out, `${JSON.stringify({
  source: "Space Environment Technologies SOLFSMY.TXT and DTCFILE.TXT, the files in the Orekit data directory used for orekit-reference.json",
  sha256: { solfsmy: crypto.createHash('sha256').update(solText).digest('hex'), dtcfile: crypto.createHash('sha256').update(dtcText).digest('hex') },
  rows,
}, null, 1)}\n`);
console.log(`wrote ${rows.length} JB2008 rows (${from}..${to}) to ${out}`);

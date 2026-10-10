#!/usr/bin/env node
// Writes synthetic space-weather files in the formats Orekit's data directory
// carries, so HPOP and Orekit can be compared on drivers that nobody owns.
//
// The real files are not redistributable: SET's SOLFSMY.TXT and DTCFILE.TXT state
// no licence (its JB2008 code README reserves all rights), and CelesTrak's
// SpaceWeather-All-v1.2.txt gathers GFZ, SILSO (CC BY-NC), NRCan and NOAA values
// under no licence of its own. The values here are invented: smooth solar-cycle-like
// curves with a 27-day rotation term, a seeded scatter, and geomagnetic activity
// that is quiet with a few storms. The files keep the layouts and the header lines'
// shape; their headers say they are synthetic.
//
//   node tests/fixtures/orekit/make-synthetic-weather.mjs <out dir>
// writes <out dir>/Space-Environment-Data/{SOLFSMY.TXT,DTCFILE.TXT} and
// <out dir>/CSSI-Space-Weather-Data/SpaceWeather-All-v1.2.txt. make-jb2008.mjs and
// make-spw.mjs turn them into the fixtures HPOP reads; OrekitReference.java reads
// the same files for the W1 and J1 cases.
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2];
if (!out) throw new Error('usage: make-synthetic-weather.mjs <out dir>');
function rng(seed) {   // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const r = rng(20260810);
const DAY = 86400000;
const days = (from, to) => { const list = []; for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY) list.push(new Date(t)); return list; };
const doy = (d) => Math.floor((d - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY) + 1;
const jd = (d) => d / DAY + 2440587.5;   // at 0 h; SOLFSMY reports at 12 UT (+ 0.5)
const one = (v) => v.toFixed(1);

// ----- SOLFSMY.TXT and DTCFILE.TXT: 2026-04-01 .. 2026-06-30 ---------------------
const solDays = days('2026-04-01', '2026-06-30');
const base = (k) => 138 + 12 * Math.sin(2 * Math.PI * k / 27.3);
const sol = [
  '# F10, S10, M10, Y10 synthetic data (invented values in the layout of Space Environment Technologies SOLFSMY.TXT)',
  `# Number of records = ${solDays.length} with daily and 81-days centered-smoothed data`,
  '# Written by propagator/hpop/tests/fixtures/orekit/make-synthetic-weather.mjs. NOT SET DATA.',
  '# YYYY DDD   JulianDay  F10   F81c  S10   S81c  M10   M81c  Y10   Y81c  Ssrc',
];
solDays.forEach((d, k) => {
  const f10 = base(k) + 4 * (r() - 0.5);
  const row = [f10, 136 + 0.02 * k, f10 - 8 + 3 * (r() - 0.5), 126 + 0.02 * k, f10 + 22 + 5 * (r() - 0.5), 148, f10 + 14 + 4 * (r() - 0.5), 150];
  sol.push(`  ${d.getUTCFullYear()} ${String(doy(d)).padStart(3)}   ${(jd(d.getTime()) + 0.5).toFixed(1)} ${row.map((v) => one(v).padStart(5)).join(' ')}  1E11`);
});
const dtc = solDays.map((d, k) => `DTC ${d.getUTCFullYear()}${String(doy(d)).padStart(4)}${Array.from({ length: 24 }, (_, h) => {
  const v = String(Math.round(24 + 30 * Math.max(0, Math.sin((k * 7 + h) / 9)) + 10 * r()));
  return v.padStart(h === 0 ? 5 : 4);
}).join('')}`);
fs.mkdirSync(path.join(out, 'Space-Environment-Data'), { recursive: true });
fs.writeFileSync(path.join(out, 'Space-Environment-Data/SOLFSMY.TXT'), `${sol.join('\n')}\n`);
fs.writeFileSync(path.join(out, 'Space-Environment-Data/DTCFILE.TXT'), `${dtc.join('\n')}\n`);

// ----- SpaceWeather-All-v1.2.txt: 2026-06-01 .. 2026-08-12 --------------------------
// FORMAT(I4,I3,I3,I5,I3,8I3,I4,8I4,I4,F4.1,I2,I4,F6.1,I2,5F6.1): year, month,
// day, BSRN, ND, Kp x 8 (tenths), Kp sum, Ap x 8, Ap mean, Cp, C9, ISN, F10.7 adj,
// Q, 81-day centred and last-81 F10.7 adj, F10.7 obs, centred and last-81 obs.
const apOfKp = [0, 2, 3, 4, 5, 6, 7, 9, 12, 15, 18, 22, 27, 32, 39, 48, 56, 67, 80, 94, 111, 132, 154, 179, 207, 236, 300, 400];
const apOf = (kp10) => apOfKp[Math.min(apOfKp.length - 1, Math.round(kp10 / 3.3333))];
const swDays = days('2026-06-01', '2026-08-12');
const cssi = swDays.map((d, k) => {
  const storm = (k > 22 && k < 26) || (k > 51 && k < 54) ? 25 : 0;
  const kp = Array.from({ length: 8 }, () => Math.min(90, Math.round((8 + 14 * r() + storm * r()) / 3.3333) * 3.3333));
  const ap = kp.map((v) => apOf(v));
  const apMean = Math.round(ap.reduce((a, b) => a + b, 0) / 8);
  const f = base(k + 61) + 4 * (r() - 0.5);
  const cols = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
  const fmt = (v, w) => String(v).padStart(w);
  return `${fmt(cols[0], 4)} ${String(cols[1]).padStart(2, '0')} ${String(cols[2]).padStart(2, '0')} ${fmt(2600 + k, 4)} ${fmt((k % 27) + 1, 2)} ${kp.map((v) => fmt(Math.round(v), 2)).join(' ')} ${fmt(Math.round(kp.reduce((a, b) => a + b, 0)), 3)} ${ap.map((v) => fmt(v, 3)).join(' ')} ${fmt(apMean, 3)} ${(apMean / 25).toFixed(1).padStart(3)} ${Math.min(9, Math.round(apMean / 12))} ${fmt(Math.round(80 + 20 * r()), 3)} ${(f + 1).toFixed(1).padStart(5)} 0 ${(137).toFixed(1).padStart(5)} ${(136).toFixed(1).padStart(5)} ${f.toFixed(1).padStart(5)} ${(136).toFixed(1).padStart(5)} ${(135).toFixed(1).padStart(5)}`;
});
// From 2026-08-01 the rows are predictions, as in the real file the cases were first built from.
const observed = cssi.filter((_, k) => swDays[k] < Date.parse('2026-08-01T00:00:00Z'));
const predicted = cssi.filter((_, k) => swDays[k] >= Date.parse('2026-08-01T00:00:00Z'));
fs.mkdirSync(path.join(out, 'CSSI-Space-Weather-Data'), { recursive: true });
fs.writeFileSync(path.join(out, 'CSSI-Space-Weather-Data/SpaceWeather-All-v1.2.txt'), [
  'DATATYPE CssiSpaceWeather', 'VERSION 1.2 ', 'UPDATED 2026 Aug 12 00:00:00.00',
  '# SYNTHETIC: invented values in the layout of the CSSI Space Weather file, NOT CSSI/CelesTrak DATA.',
  '# Written by propagator/hpop/tests/fixtures/orekit/make-synthetic-weather.mjs.',
  '# FORMAT(I4,I3,I3,I5,I3,8I3,I4,8I4,I4,F4.1,I2,I4,F6.1,I2,5F6.1)',
  '# yy mm dd BSRN ND Kp Kp Kp Kp Kp Kp Kp Kp Sum Ap  Ap  Ap  Ap  Ap  Ap  Ap  Ap  Avg Cp C9 ISN F10.7 Q Ctr81 Lst81 F10.7 Ctr81 Lst81',
  `NUM_OBSERVED_POINTS ${observed.length}`, 'BEGIN OBSERVED', ...observed, 'END OBSERVED', '',
  `NUM_DAILY_PREDICTED_POINTS ${predicted.length}`, 'BEGIN DAILY_PREDICTED', ...predicted, 'END DAILY_PREDICTED', '',
  'NUM_MONTHLY_PREDICTED_POINTS 0', 'BEGIN MONTHLY_PREDICTED', 'END MONTHLY_PREDICTED', '',
  'NUM_MONTHLY_FIT_POINTS 0', 'BEGIN MONTHLY_FIT', 'END MONTHLY_FIT', ''].join('\n'));
console.log(`wrote ${solDays.length} SOLFSMY/DTCFILE days and ${cssi.length} CSSI days to ${out}`);

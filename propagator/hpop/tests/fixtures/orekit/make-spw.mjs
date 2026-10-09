#!/usr/bin/env node
// Writes the daily space weather Orekit read (CelesTrak/CSSI
// SpaceWeather-All-v1.2.txt, the file in Orekit's data directory) as SDS $SPW
// rows, so HPOP's space_weather input carries exactly the same values.
//
// The file is whitespace-separated (CelesTrak, "Space Weather Data" format
// v1.2): year month day BSRN ND Kp1..Kp8 (x10) Sum Ap1..Ap8 Avg Cp C9 ISN
// F10.7adj Q Ctr81adj Lst81adj F10.7obs Ctr81obs Lst81obs, in sections
// OBSERVED, DAILY_PREDICTED and MONTHLY_PREDICTED.
//
//   node tests/fixtures/orekit/make-spw.mjs <SpaceWeather-All-v1.2.txt> <from YYYY-MM-DD> <to YYYY-MM-DD> <out.json>
import fs from 'node:fs';
import crypto from 'node:crypto';

const [file, from, to, out] = process.argv.slice(2);
if (!out) throw new Error('usage: make-spw.mjs <SpaceWeather-All-v1.2.txt> <from> <to> <out.json>');
const raw = fs.readFileSync(file);
const TYPE = { OBSERVED: 0, DAILY_PREDICTED: 2, MONTHLY_PREDICTED: 3 };  // SDS F107DataType OBS, PRD, PRM
let section = null;
const rows = [];
for (const line of raw.toString('latin1').split('\n')) {
  const begin = /^BEGIN (\w+)/.exec(line), end = /^END (\w+)/.exec(line);
  if (begin) { section = begin[1]; continue; }
  if (end) { section = null; continue; }
  if (!(section in TYPE)) continue;
  const t = line.trim().split(/\s+/);
  if (t.length < 33) continue;
  const date = `${t[0]}-${t[1]}-${t[2]}`;
  if (date < from || date > to) continue;
  const n = (i) => Number(t[i]);
  rows.push({
    DATE: date, BSRN: n(3), ND: n(4),
    KP1: n(5), KP2: n(6), KP3: n(7), KP4: n(8), KP5: n(9), KP6: n(10), KP7: n(11), KP8: n(12), KP_SUM: n(13),
    AP1: n(14), AP2: n(15), AP3: n(16), AP4: n(17), AP5: n(18), AP6: n(19), AP7: n(20), AP8: n(21), AP_AVG: n(22),
    CP: n(23), C9: n(24), ISN: n(25),
    F107_ADJ: n(26), F107_DATA_TYPE: TYPE[section], F107_ADJ_CENTER81: n(28), F107_ADJ_LAST81: n(29),
    F107_OBS: n(30), F107_OBS_CENTER81: n(31), F107_OBS_LAST81: n(32),
  });
}
fs.writeFileSync(out, `${JSON.stringify({
  source: 'CelesTrak/CSSI SpaceWeather-All-v1.2.txt, the file in the Orekit data directory used for orekit-reference.json',
  sha256: crypto.createHash('sha256').update(raw).digest('hex'),
  rows,
}, null, 1)}\n`);
console.log(`wrote ${rows.length} SPW rows (${from}..${to}) to ${out}`);

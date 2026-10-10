#!/usr/bin/env node
// Re-draws the orbital numbers in the SupGP-shaped fixtures of this directory.
//
// CelesTrak publishes no licence for its supplemental GP data, so the files here
// keep only what identifies a record (object name, designator, NORAD number,
// epoch, element-set number, DATA_SOURCE) and carry invented numbers for the rest:
// mean motion keeps its first two decimals (the orbit class), everything else is
// drawn from a seeded generator. The SES-E CSV is written from the first four SES-E
// records so both formats agree. Run in place:
//   node data-source/celestrak-supgp/test/fixtures/make-synthetic.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
function rng(seed) {   // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const seedOf = (text) => [...text].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);

const num = (v) => (Math.abs(v) < 1e-3 && v !== 0 ? v.toExponential(4) : String(Number(v.toPrecision(7))));

function redraw(record, u) {
  const mm = Math.round(record.MEAN_MOTION * 100) / 100 + Math.floor(u() * 99999) / 1e8 + 0.00001;
  const geo = record.MEAN_MOTION < 1.1;
  return {
    ...record,
    MEAN_MOTION: Number(mm.toFixed(8)),
    ECCENTRICITY: Number((0.0001 + 0.0004 * u()).toPrecision(4)),
    INCLINATION: Number(((geo ? 0 : Math.round(record.INCLINATION)) + (geo ? 3 * u() : u() - 0.5)).toFixed(4)),
    RA_OF_ASC_NODE: Number((360 * u()).toFixed(4)),
    ARG_OF_PERICENTER: Number((360 * u()).toFixed(4)),
    MEAN_ANOMALY: Number((360 * u()).toFixed(4)),
    BSTAR: record.BSTAR === 0 ? 0 : Number(((u() - 0.3) * 6e-4).toPrecision(5)),
    MEAN_MOTION_DOT: Number(((u() - 0.5) * (geo ? 6e-6 : 6e-5)).toPrecision(5)),
    RMS: (0.08 + 0.7 * u()).toFixed(3),
  };
}

// JSON text of one flat OMM object, key order and number style as CelesTrak serves it.
const KEYS = ['OBJECT_NAME', 'OBJECT_ID', 'EPOCH', 'MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION', 'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'EPHEMERIS_TYPE', 'CLASSIFICATION_TYPE', 'NORAD_CAT_ID', 'ELEMENT_SET_NO', 'REV_AT_EPOCH', 'BSTAR', 'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT', 'RMS', 'DATA_SOURCE'];
const jsonObject = (r) => `{${KEYS.map((k) => `${JSON.stringify(k)}:${['MEAN_MOTION_DOT'].includes(k) ? num(r[k]) : JSON.stringify(r[k])}`).join(',')}}`;

const records = {};
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.trimmed.json'))) {
  const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  records[file] = parsed.map((r, i) => redraw(r, rng(seedOf(`${file}:${r.NORAD_CAT_ID}:${r.EPOCH}:${i}`))));
  fs.writeFileSync(path.join(dir, file), `[${records[file].map(jsonObject).join(',')}]`);
  console.log(`wrote ${file} (${records[file].length} records)`);
}

// CSV: leading-dot decimals and E-notation mantissas in [0.1, 1), as the CSV is served.
const dotted = (v) => (v < 1 ? String(v).replace(/^0\./, '.') : String(v));
const eNotation = (v) => {
  if (v === 0) return '0';
  const exp = Math.floor(Math.log10(Math.abs(v))) + 1;
  const mantissa = Number((v / 10 ** exp).toPrecision(5));
  return `${String(mantissa).replace(/^(-?)0\./, '$1.')}E${exp}`;
};
const csvHeader = 'OBJECT_NAME,OBJECT_ID,EPOCH,MEAN_MOTION,ECCENTRICITY,INCLINATION,RA_OF_ASC_NODE,ARG_OF_PERICENTER,MEAN_ANOMALY,EPHEMERIS_TYPE,CLASSIFICATION_TYPE,NORAD_CAT_ID,ELEMENT_SET_NO,REV_AT_EPOCH,BSTAR,MEAN_MOTION_DOT,MEAN_MOTION_DDOT,RMS,DATA_SOURCE';
const csvRows = records['SES-E.trimmed.json'].map((r) => [r.OBJECT_NAME, r.OBJECT_ID, r.EPOCH, r.MEAN_MOTION.toFixed(8), dotted(r.ECCENTRICITY), r.INCLINATION.toFixed(4), r.RA_OF_ASC_NODE.toFixed(4),
  r.ARG_OF_PERICENTER.toFixed(4), r.MEAN_ANOMALY.toFixed(4), r.EPHEMERIS_TYPE, r.CLASSIFICATION_TYPE, r.NORAD_CAT_ID, r.ELEMENT_SET_NO, r.REV_AT_EPOCH, r.BSTAR === 0 ? '0' : eNotation(r.BSTAR),
  eNotation(r.MEAN_MOTION_DOT), 0, r.RMS, r.DATA_SOURCE].join(','));
fs.writeFileSync(path.join(dir, 'SES-E.csv.trimmed.csv'), `${[csvHeader, ...csvRows].join('\n')}\n`);
console.log('wrote SES-E.csv.trimmed.csv');
const first = records['SES-E.trimmed.json'][0];
console.log('NSS-11:', JSON.stringify({ n: first.MEAN_MOTION, e: first.ECCENTRICITY, i: first.INCLINATION, ndot: first.MEAN_MOTION_DOT, rms: first.RMS }));

#!/usr/bin/env node
// Writes the five CCSDS example messages of this directory.
//
// The CCSDS Blue Books (503.0-B-2 TDM, 504.0-B-2 ADM) state no terms for
// reproducing their annex examples, so none is kept. These messages have the
// same structure, keywords and quirks as the figures the tests were written
// against (non-uniform AEM epochs, a SPIN segment with a COMMENT in the data
// block, a TDM whose last RCS line repeats an earlier epoch, two-segment TDMs,
// phase counts with INTERPOLATION keywords) with invented spacecraft, stations,
// times and numbers. Seeded; rerun in place:
//   node files/ccsds-messages/fixtures/make-synthetic.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
function rng(seed) {   // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const r = rng(5030);
const num = (v, d, w = 0) => v.toFixed(d).padStart(w);
const quaternion = (d) => {   // a unit quaternion, scalar last, printed to d decimals
  const q = [0, 0, 0, 0].map(() => r() * 2 - 1);
  const n = Math.hypot(...q);
  return q.map((x) => num(x / n, d));
};
const write = (name, lines) => fs.writeFileSync(path.join(dir, name), `${lines.join('\n')}\n`);

// ----- AEM, two segments, non-uniform epochs (a 2336 s step, then 1 s) --------
write('ccsds-504.0-B-2-figure-G-4-aem.txt', [
  'CCSDS_AEM_VERS = 2.0', 'CREATION_DATE = 2031-03-04T17:22:31', 'ORIGINATOR = EXAMPLE-AGENCY', 'MESSAGE_ID = S4015Q9', '',
  'META_START',
  'COMMENT This file is synthetic: invented values in the layout of an attitude message.',
  'COMMENT It is to be used for testing only. The stated relative accuracy of these',
  'COMMENT  attitudes is 0.1 degrees per axis.',
  'OBJECT_NAME     = SYNTHETIC ORBITER A', 'OBJECT_ID      = 2030-041A', 'CENTER_NAME     = MARS BARYCENTER',
  'REF_FRAME_A     = EME2000', 'REF_FRAME_B     = SC_BODY_1', 'TIME_SYSTEM     = UTC',
  'START_TIME      = 2031-03-01T10:12:07.2555', 'USEABLE_START_TIME  = 2031-03-01T10:51:02.5555',
  'USEABLE_STOP_TIME  = 2031-03-02T14:01:02.5555', 'STOP_TIME      = 2031-03-02T14:11:02.5555',
  'ATTITUDE_TYPE    = QUATERNION', 'INTERPOLATION_METHOD = hermite', 'INTERPOLATION_DEGREE = 7', 'META_STOP', '',
  'DATA_START',
  '2031-03-01T10:12:07.2555 0.52000  0.12000  0.47000  0.70306', `2031-03-01T10:51:03.5555 ${quaternion(5).join('  ')}`,
  `2031-03-01T10:51:04.5555 ${quaternion(5).join('  ')}`, `2031-03-02T14:11:02.5555 ${quaternion(5).join('  ')}`,
  'DATA_STOP', '',
  'META_START', 'COMMENT  This block begins after trajectory correction maneuver TCM-3.',
  'OBJECT_NAME     = synthetic orbiter a', 'OBJECT_ID      = 2030-041A', 'CENTER_NAME     = MARS BARYCENTER',
  'REF_FRAME_A     = EME2000', 'REF_FRAME_B    = SC_BODY_1', 'TIME_SYSTEM     = UTC',
  'START_TIME      = 2031-03-21T05:35:00.5555', 'USEABLE_START_TIME  = 2031-03-21T05:40:00.5555',
  'USEABLE_STOP_TIME  = 2031-03-31T14:53:00.5555', 'STOP_TIME      = 2031-03-31T14:58:00.5555',
  'ATTITUDE_TYPE    = QUATERNION', 'META_STOP', '',
  'DATA_START',
  `2031-03-21T05:35:00.5555 ${quaternion(5).join(' ')}`, `2031-03-21T05:40:05.5555 ${quaternion(5).join('  ')}`,
  `2031-03-21T05:40:10.5555 ${quaternion(5).join(' ')}`, `2031-03-31T14:58:00.5555 ${quaternion(5).join('  ')}`,
  'DATA_STOP']);

// ----- AEM, one SPIN segment, 0.125 s step, a COMMENT in the data block ----------
const spin = Array.from({ length: 8 }, (_, k) => {
  const ms = 71 + 125 * k;
  return `  2031-090T05:00:00.${String(ms).padStart(3, '0')}  ${[2.69e2 + r(), 6.8e1 + r(), 1.6e2 - 13.7 * k + r(), -1.0996e2 + 0.0005 * r()].map((v) => v.toExponential(7)).join(' ')}`;
});
write('ccsds-504.0-B-2-figure-G-5-aem-spinner.txt', [
  'CCSDS_AEM_VERS = 2.0', 'CREATION_DATE  = 2031-071T17:09:49', 'ORIGINATOR     = EXAMPLE-AGENCY', 'MESSAGE_ID     = 7077456', '',
  'META_START', 'OBJECT_NAME    = SYNTH-SPIN-1', 'OBJECT_ID      = 2030-224A', 'CENTER_NAME    = EARTH',
  'REF_FRAME_A    = J2000', 'REF_FRAME_B    = SC_BODY_1', 'TIME_SYSTEM    = UTC',
  'START_TIME     = 2031-090T05:00:00.071', 'USEABLE_START_TIME = 2031-090T05:00:00.071',
  'USEABLE_STOP_TIME = 2031-090T05:00:00.946', 'STOP_TIME     = 2031-090T05:00:00.946',
  'ATTITUDE_TYPE   = SPIN', 'META_STOP', '',
  'DATA_START', 'COMMENT       Synthetic spin solution', ...spin, 'DATA_STOP']);

// ----- TDM, optical angles in two segments ---------------------------------------
const optical = (track, start, stops, ra0, dec0) => {
  const lines = ['META_START', 'TIME_SYSTEM = UTC', `START_TIME = ${start[0]}`, `STOP_TIME = ${start[start.length - 1]}`, 'PARTICIPANT_1 = TSTN',
    `PARTICIPANT_2 = TRACK NUMBER ${track}`, 'MODE = SEQUENTIAL', 'PATH = 2,1', 'ANGLE_TYPE = RADEC', 'REFERENCE_FRAME = EME2000', 'META_STOP', 'DATA_START'];
  start.forEach((t, k) => {
    lines.push(`ANGLE_1 = ${t} ${num(ra0 + 0.52 * k + 0.01 * r(), 7)}`, `ANGLE_2 = ${t} ${num(dec0 + 0.11 * k + 0.01 * r(), 7)}`, `MAG =     ${t}    ${num(11.5 + 2 * r(), 1)}`);
  });
  return [...lines, 'DATA_STOP'];
};
write('ccsds-503.0-B-2-figure-E-16-tdm-optical.txt', [
  'CCSDS_TDM_VERS = 2.0', 'COMMENT Synthetic angles, invented values.', 'CREATION_DATE = 2032-10-30T20:00', 'ORIGINATOR = EXAMPLE-AGENCY', '',
  ...optical('001', ['2032-10-29T17:46:39.02', '2032-10-29T17:48:46.02', '2032-10-29T17:50:53.02'], null, 232.2, -26.3), '',
  ...optical('003', ['2032-10-29T17:57:14.02', '2032-10-29T17:59:21.02', '2032-10-29T18:01:28.02'], null, 235.1, -27.7)]);

// ----- TDM, radar; the last RCS line repeats an earlier epoch --------------------
const radarTimes = ['2031-05-11T10:26:33.2613', '2031-05-11T10:26:33.7008', '2031-05-11T10:26:33.9686'];
const radar = [];
radarTimes.forEach((t, k) => {
  radar.push(`RANGE =         ${t}    ${num(3108.27 - 5.1 * k - 2 * r(), 4)}`, `ANGLE_1 =       ${t}     ${num(171.4 + 0.04 * k + 0.01 * r(), 8)}`,
    `ANGLE_2 =       ${t}      ${num(35.44 + 0.08 * k + 0.01 * r(), 8)}`, `CARRIER_POWER = ${t}     ${num(-37 + 1.5 * r(), 8)}`,
    `RCS =           ${radarTimes[k === 2 ? 1 : k]}       ${num(2.9 + 0.1 * r(), 3)}`);
});
write('ccsds-503.0-B-2-figure-E-17-tdm-radar.txt', [
  'CCSDS_TDM_VERS = 2.0', 'COMMENT Synthetic test file', 'CREATION_DATE = 2031-05-12T00:00:00.000', 'ORIGINATOR = EXAMPLE-AGENCY',
  'META_START', 'COMMENT', 'TIME_SYSTEM = UTC', 'PARTICIPANT_1 = STATION-X', 'PARTICIPANT_2 = SYNTH-SAT-9', 'MODE = SEQUENTIAL', 'PATH = 1,2,1',
  'EPHEMERIS_NAME = 4417_2033-11-09T23-02-30', 'RANGE_UNITS = km', 'ANGLE_TYPE = AZEL', 'CORRECTION_RANGE =  -1.48', 'CORRECTIONS_APPLIED = NO', 'META_STOP',
  'DATA_START', ...radar, 'DATA_STOP']);

// ----- TDM, phase counts in two segments (transmit, then receive) ---------------
const phase = (tag, t0, step, rate, first) => Array.from({ length: 10 }, (_, k) => {
  const stamp = `${t0}`.replace(/\d\d(\.\d+)?$/, (m) => String(Number(m) + k * step).padStart(m.includes('.') ? 5 : 2, '0'));
  return `${tag}=${stamp} ${num(first * (k + 1) + k * rate * r(), 6, 22)}`;
});
write('ccsds-503.0-B-2-figure-E-18-tdm-phase.txt', [
  'CCSDS_TDM_VERS=2.0', 'COMMENT Synthetic TDM, invented values', 'CREATION_DATE=2035-184T20:15:00', 'ORIGINATOR=EXAMPLE-AGENCY', 'MESSAGE_ID=EX-2035-184-0001',
  'META_START', 'TIME_SYSTEM=UTC', 'START_TIME=2035-184T11:12:23', 'STOP_TIME=2035-184T11:12:32', 'PARTICIPANT_1=STATION-Y', 'PARTICIPANT_2=SYNTH-SAT-10',
  'MODE=SEQUENTIAL', 'PATH=1,2,1', 'FREQ_OFFSET=0.0', 'INTERPOLATION = HERMITE', 'INTERPOLATION_DEGREE = 7', 'META_STOP',
  'DATA_START', ...phase('TRANSMIT_PHASE_CT_1', '2035-184T11:12:23', 1, 0.7, 7312450918.274051), 'DATA_STOP', '',
  'META_START', 'TIME_SYSTEM=UTC', 'START_TIME=2035-184T13:59:27.27', 'STOP_TIME=2035-184T13:59:36.27', 'PARTICIPANT_1=STATION-Y', 'PARTICIPANT_2=SYNTH-SAT-10',
  'MODE=SEQUENTIAL', 'PATH=1,2,1', 'FREQ_OFFSET=0.0', 'INTERPOLATION = HERMITE', 'INTERPOLATION_DEGREE = 7', 'META_STOP',
  'DATA_START', '', ...phase('RECEIVE_PHASE_CT_1', '2035-184T13:59:27.27', 1, 0.7, 8517203994.118862), '', 'DATA_STOP']);
console.log('wrote 5 messages');

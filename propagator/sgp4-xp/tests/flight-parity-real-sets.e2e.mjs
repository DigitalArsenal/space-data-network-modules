#!/usr/bin/env node
// E2E (task modules-sgp4-xp-flight-departs-library-20261104): the module flies real geosynchronous SGP4-XP sets as
// the Space Force library does when each state is propagated from the set's epoch.
// - Every GE and IG set of the 2x2 (tests/fixtures/geo-real-sets.json: 70 GE and 120 IG two-line sets, both fitters,
//   from the experiments' geo-sgp4-one-mode run) enters through ingest_omm and is flown by propagate on one grid per
//   set: the last hour of each lead day 1 to 7 after the window's cutoff, every 5 minutes (91 epochs). The same text
//   and times go to the SGP4-XP oracle's 9.1.1.0 leg (the unmodified library behind a black-box harness,
//   SDN_AP_ORACLE_ROOT; predictions only). Every state of every set is within 10 m of the oracle's (3D, TEME).
// - The real GE and IG cases of vectors/vectors.json: the oracle's 9.1.1.0 and 9.9 legs fly each case's two-line set
//   to its time and land within 0.5 m (the corpus's position band) of the case's TEME state.
// The 0.2.0 module flew a grid on one satellite, whose integrator continued from the previous request; these sets
// then departed by 0.1 to 0.6 km. JS only moves bytes and compares numbers the module and the oracle produced.
//   cd propagator/sgp4-xp && SDN_AP_ORACLE_ROOT=<closed-modules>/packages/sgp4-xp-oracle node tests/flight-parity-real-sets.e2e.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadModule } from './lib/module.mjs';
import { omm as ommOfLines } from './lib/tle.mjs';
import { blockLines, frame, ommBytes, oemBytes, readOem } from './lib/sds.mjs';

const BOUND_M = 10, VECTOR_BAND_M = 0.5, DAY = 86400000;
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const { sets } = JSON.parse(fs.readFileSync(here('fixtures/geo-real-sets.json'), 'utf8'));
const vectors = JSON.parse(fs.readFileSync(here('../vectors/vectors.json'), 'utf8')).cases.filter((c) => c.source?.temeKm);

if (!process.env.SDN_AP_ORACLE_ROOT) {
  console.error('SDN_AP_ORACLE_ROOT is not set: this E2E flies the sets on the SGP4-XP oracle (closed-modules packages/sgp4-xp-oracle).');
  process.exit(2);
}
const spec = await import(pathToFileURL(path.join(process.env.SDN_AP_ORACLE_ROOT, 'oracle.mjs')).href);
const oracle = { '9.1.1.0': await spec.openOracle({ version: '9.1.1.0' }), '9.9': await spec.openOracle({ version: '9.9' }) };
const fly = async (version, lines, minutes) => {
  const states = await oracle[version].propagate(lines, minutes);
  if (!states || states.some((s) => !s || s.error !== 0)) throw new Error(`the oracle ${version} refused ${lines[0]}`);
  return states.map((s) => s.r);
};
// Minutes from the text's epoch, the experiments' way: from 1 January of its year, less the day field.
const epochOf = (l1) => { const yy = Number(l1.slice(18, 20)); return { jan1: Date.UTC(yy < 57 ? 2000 + yy : 1900 + yy, 0, 1), day: Number(l1.slice(20, 32)) }; };
const meters = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * 1000;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN; };

const failures = [];
const module = await loadModule();
const byGroupDay = {};
let worst = { m: 0 };
try {
  for (const set of sets) {
    const cutoff = Date.parse(set.cutoff), { jan1, day } = epochOf(set.lines[0]);
    const times = [];
    for (let k = 1; k <= 7; k += 1) for (let j = 0; j <= 12; j += 1) times.push(cutoff + k * DAY - (60 - 5 * j) * 60000);
    const minutes = times.map((t) => (t - jan1) / 60000 - (day - 1) * 1440);
    const ingested = await module.invoke('ingest_omm', [frame('omm', 'OMM', ommBytes(ommOfLines(set.lines)))]);
    // The grid's epochs are the instants the oracle is given in minutes: the text's epoch plus those minutes.
    const epochMicros = Math.round((jan1 + (day - 1) * DAY) * 1000);
    const iso = (us) => `${new Date(Math.floor(us / 1000)).toISOString().slice(0, 19)}.${String(us % 1000000).padStart(6, '0')}Z`;
    const grid = oemBytes({ blocks: [{ frame: 'TEMEOFDATE', lines: minutes.map((m) => ({ epoch: iso(epochMicros + Math.round(m * 60e6)) })) }] });
    const flown = await module.invoke('propagate', [frame('ocm', 'OCM', ingested.ocm[0]), frame('grid', 'OEM', grid)]);
    const got = blockLines(readOem(flown.ephemeris[0]).EPHEMERIS_DATA_BLOCK[0]);
    const want = await fly('9.1.1.0', set.lines, minutes.map((m) => Math.round(m * 60e6) / 60e6));
    if (got.length !== want.length) { failures.push(`${set.key} ${set.fitter}: ${got.length} of ${want.length} states`); continue; }
    got.forEach((s, i) => {
      const m = meters(s.r, want[i]);
      const k = Math.floor(i / 13) + 1;
      ((byGroupDay[set.group] ??= {})[k] ??= []).push(m);
      if (m > worst.m) worst = { m, key: set.key, fitter: set.fitter, day: k };
      if (!(m <= BOUND_M)) failures.push(`${set.key} ${set.fitter} day ${k} +${(minutes[i] / 1440).toFixed(4)} d: ${m.toFixed(3)} m from the oracle 9.1.1.0`);
    });
  }
  for (const c of vectors) {
    const { minutes, r } = c.source.temeKm;
    for (const version of ['9.1.1.0', '9.9']) {
      const [o] = await fly(version, c.source.twoLine, [minutes]);
      const m = meters(o, r);
      if (!(m <= VECTOR_BAND_M)) failures.push(`vector ${c.id}: the oracle ${version} lands ${m.toFixed(3)} m from the case`);
    }
  }
} finally {
  await module.destroy();
  for (const o of Object.values(oracle)) o.close?.();
}

for (const [group, days] of Object.entries(byGroupDay)) {
  console.log(`${group}: ${sets.filter((s) => s.group === group).length} sets; module - oracle 9.1.1.0, m, median / max by lead day: ${Object.entries(days).map(([k, xs]) => `${k}: ${median(xs).toFixed(4)} / ${Math.max(...xs).toFixed(4)}`).join(', ')}`);
}
console.log(`worst: ${worst.m.toFixed(4)} m (${worst.key ?? '-'} ${worst.fitter ?? ''} day ${worst.day ?? '-'}); vectors: ${vectors.length} real cases on 9.1.1.0 and 9.9`);
if (vectors.length < 8) failures.push(`vectors/vectors.json holds ${vectors.length} real GE and IG cases, not 8`);
if (failures.length) {
  console.log(`FLIGHT PARITY: FAIL (${failures.length})`);
  for (const f of failures.slice(0, 40)) console.log(`  ${f}`);
  process.exit(1);
}
console.log(`FLIGHT PARITY: PASS: ${sets.length} sets x 91 epochs within ${BOUND_M} m of the oracle 9.1.1.0; ${vectors.length} vector cases within ${VECTOR_BAND_M} m on 9.1.1.0 and 9.9`);

#!/usr/bin/env node
// E2E (tasks modules-sgp4-xp-flight-departs-library-20261104 and modules-sgp4-xp-flight-cost-20261104): the module flies
// real geosynchronous SGP4-XP sets as the Space Force library does when each state is propagated from the set's epoch,
// and flies a dense grid at a small multiple of the cost of one such propagation.
// - Every GE and IG set of the 2x2 (tests/fixtures/geo-real-sets.json: 70 GE and 120 IG two-line sets, both fitters,
//   from the experiments' geo-sgp4-one-mode run) enters through ingest_omm and is flown by propagate on its lead grid:
//   the last hour of each lead day 1 to 7 after the window's cutoff, every 5 minutes (91 epochs). The same text and
//   times go to the SGP4-XP oracle's 9.1.1.0 leg (the unmodified library behind a black-box harness,
//   SDN_AP_ORACLE_ROOT; predictions only). Every state of every set is within 10 m of the oracle's (3D, TEME).
// - The real GE and IG cases of vectors/vectors.json: the oracle's 9.1.1.0 and 9.9 legs fly each case's two-line set
//   to its time and land within 0.5 m (the corpus's position band) of the case's TEME state.
// - Each set also flies its week grid: 2,016 states, every 5 minutes from 5 minutes after its epoch to 7 days after it.
//   The states of both grids are the 0.2.1 dist's bit for bit (tests/fixtures/flight-0-2-1.json; 0.2.1 flew every
//   state on a new library satellite, 1.56 s per week grid), and every week grid's propagate takes under 0.1 s; the
//   timing line names the machine's 1-minute load.
// The 0.2.0 module flew a grid on one satellite, whose integrator continued from the previous request; these sets
// then departed by 0.1 to 0.6 km. JS only moves bytes and compares numbers the module and the oracle produced.
//   cd propagator/sgp4-xp && SDN_AP_ORACLE_ROOT=<closed-modules>/packages/sgp4-xp-oracle node tests/flight-parity-real-sets.e2e.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadModule } from './lib/module.mjs';
import { omm as ommOfLines } from './lib/tle.mjs';
import { blockLines, frame, ommBytes, readOem } from './lib/sds.mjs';
import { leadGrid, statesDigest, WEEK_STATES, weekGrid } from './lib/flight-grids.mjs';

const BOUND_M = 10, VECTOR_BAND_M = 0.5, WEEK_MS = 100;
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const { sets } = JSON.parse(fs.readFileSync(here('fixtures/geo-real-sets.json'), 'utf8'));
const recorded = JSON.parse(fs.readFileSync(here('fixtures/flight-0-2-1.json'), 'utf8')).sets;
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
const meters = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * 1000;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN; };

const failures = [];
const module = await loadModule();
const propagate = async (ocm, grid) => blockLines(readOem((await module.invoke('propagate', [frame('ocm', 'OCM', ocm), frame('grid', 'OEM', grid)])).ephemeris[0]).EPHEMERIS_DATA_BLOCK[0]);
const byGroupDay = {};
const weekMs = [];
let worst = { m: 0 }, exact = 0;
const loadAtStart = os.loadavg()[0];
try {
  for (const [index, set] of sets.entries()) {
    const { minutes, grid } = leadGrid(set);
    const { ocm: [ocm] } = await module.invoke('ingest_omm', [frame('omm', 'OMM', ommBytes(ommOfLines(set.lines)))]);
    const got = await propagate(ocm, grid);
    const t0 = performance.now();
    const flown = await module.invoke('propagate', [frame('ocm', 'OCM', ocm), frame('grid', 'OEM', weekGrid(set))]);
    const ms = performance.now() - t0;
    weekMs.push(ms);
    const week = blockLines(readOem(flown.ephemeris[0]).EPHEMERIS_DATA_BLOCK[0]);
    if (!(ms < WEEK_MS)) failures.push(`${set.key} ${set.fitter}: the week grid took ${ms.toFixed(1)} ms`);
    const was = recorded[index];
    if (was?.key !== set.key || was?.fitter !== set.fitter) failures.push(`${set.key} ${set.fitter}: no 0.2.1 record`);
    else if (week.length !== WEEK_STATES || statesDigest(got) !== was.lead || statesDigest(week) !== was.week) failures.push(`${set.key} ${set.fitter}: ${statesDigest(got) === was.lead ? '' : 'lead '}${statesDigest(week) === was.week ? '' : `week (${week.length} states) `}not the 0.2.1 states`);
    else exact += 1;
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
console.log(`week grid (${WEEK_STATES} states, 7 days): propagate ${median(weekMs).toFixed(1)} ms per set median, ${Math.max(...weekMs).toFixed(1)} ms max, ${Math.min(...weekMs).toFixed(1)} ms min over ${weekMs.length} sets (under ${WEEK_MS} ms each); 1-minute load ${loadAtStart.toFixed(1)} at start, ${os.loadavg()[0].toFixed(1)} at end, ${os.cpus().length} cores; ${exact} of ${sets.length} sets the 0.2.1 states bit for bit on both grids`);
if (vectors.length < 8) failures.push(`vectors/vectors.json holds ${vectors.length} real GE and IG cases, not 8`);
if (failures.length) {
  console.log(`FLIGHT PARITY: FAIL (${failures.length})`);
  for (const f of failures.slice(0, 40)) console.log(`  ${f}`);
  process.exit(1);
}
console.log(`FLIGHT PARITY: PASS: ${sets.length} sets x 91 epochs within ${BOUND_M} m of the oracle 9.1.1.0; ${vectors.length} vector cases within ${VECTOR_BAND_M} m on 9.1.1.0 and 9.9; ${sets.length} week grids of ${WEEK_STATES} states under ${WEEK_MS} ms each, both grids the 0.2.1 states bit for bit`);

#!/usr/bin/env node
// Records tests/fixtures/flight-0-2-1.json from this directory's dist (PROVENANCE.md): for every set of
// geo-real-sets.json, the SHA-256 of the states `propagate` returns on the lead grid and on the week grid of
// tests/lib/flight-grids.mjs. The module computes every state; this script moves bytes and hashes them.
//   cd propagator/sgp4-xp && node tests/fixtures/record-flight.mjs
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadModule, manifest, wasmPath } from '../lib/module.mjs';
import { omm as ommOfLines } from '../lib/tle.mjs';
import { blockLines, frame, ommBytes, readOem } from '../lib/sds.mjs';
import { leadGrid, statesDigest, WEEK_STATES, weekGrid } from '../lib/flight-grids.mjs';

const here = (name) => fileURLToPath(new URL(name, import.meta.url));
const { sets } = JSON.parse(fs.readFileSync(here('geo-real-sets.json'), 'utf8'));
const module = await loadModule();
const fly = async (ocm, grid) => blockLines(readOem((await module.invoke('propagate', [frame('ocm', 'OCM', ocm), frame('grid', 'OEM', grid)])).ephemeris[0]).EPHEMERIS_DATA_BLOCK[0]);
const rows = [];
const ms = [];
try {
  for (const set of sets) {
    const { ocm: [ocm] } = await module.invoke('ingest_omm', [frame('omm', 'OMM', ommBytes(ommOfLines(set.lines)))]);
    const lead = await fly(ocm, leadGrid(set).grid);
    const t0 = performance.now();
    const week = await fly(ocm, weekGrid(set));
    ms.push(performance.now() - t0);
    if (lead.length !== 91 || week.length !== WEEK_STATES) throw new Error(`${set.key} ${set.fitter}: ${lead.length} lead and ${week.length} week states`);
    rows.push({ key: set.key, fitter: set.fitter, lead: statesDigest(lead), week: statesDigest(week) });
  }
} finally {
  await module.destroy();
}
const sorted = [...ms].sort((a, b) => a - b);
const out = {
  '//': 'The states propagator/sgp4-xp 0.2.1 returns on the lead grid (91 epochs) and the week grid (2,016 states) of tests/lib/flight-grids.mjs for every set of geo-real-sets.json, as SHA-256 of their doubles (tests/fixtures/record-flight.mjs; PROVENANCE.md).',
  module: { version: manifest.version, sha256: createHash('sha256').update(fs.readFileSync(wasmPath)).digest('hex') },
  sets: rows,
};
fs.writeFileSync(here('flight-0-2-1.json'), `${JSON.stringify(out, null, 1)}\n`);
console.log(`recorded ${rows.length} sets from ${out.module.version} (${out.module.sha256}); week grid ms per set median ${sorted[Math.floor((sorted.length - 1) / 2)].toFixed(0)}, max ${sorted[sorted.length - 1].toFixed(0)}`);

#!/usr/bin/env node
// Fetches JPL Horizons geocentric vectors (ICRF, km and km/s, CSV) at the 50 sample epochs
// of the reference-case export (UTC), for the bodies HPOP reads from DE440 and for JWST.
// Network is needed only here; run-horizons.mjs reads the stored responses.
//   node fetch-horizons.mjs [out dir]
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(process.argv[2] ?? path.join(here, 'raw'));
fs.mkdirSync(out, { recursive: true });
const cases = JSON.parse(fs.readFileSync(path.join(here, '../cases/hpop-reference-cases.json'), 'utf8'));
const epochs = [...new Set(cases.cases.flatMap((c) => [c.epochUtc, ...c.sampleEpochsUtc]))].sort();
const jd = (s) => Date.parse(s + 'Z') / 86400000 + 2440587.5;
const TLIST = epochs.map((e) => jd(e).toFixed(8));
const BODIES = [['sun', '10'], ['moon', '301'], ['venus', '299'], ['jupiter', '599'], ['jwst', '-170']];
const index = { fetched: new Date().toISOString(), epochsUtc: epochs, bodies: {} };
for (const [name, id] of BODIES) {
  const q = new URLSearchParams({ format: 'json', COMMAND: `'${id}'`, OBJ_DATA: 'NO', MAKE_EPHEM: 'YES', EPHEM_TYPE: 'VECTORS', CENTER: "'500@399'",
    TLIST: TLIST.map((t) => `'${t}'`).join(' '), TLIST_TYPE: 'JD', TIME_TYPE: 'UT', REF_SYSTEM: 'ICRF', REF_PLANE: 'FRAME', OUT_UNITS: "'KM-S'", VEC_TABLE: '2', VEC_CORR: 'NONE', CSV_FORMAT: 'YES' });
  const res = await fetch(`https://ssd.jpl.nasa.gov/api/horizons.api?${q}`);
  const text = await res.text();
  const j = JSON.parse(text);
  fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(j, null, 1) + '\n');
  index.bodies[name] = { command: id, status: res.status, sha256: createHash('sha256').update(text).digest('hex'), version: j.signature?.version, resultBytes: (j.result ?? '').length };
  console.log(name, res.status, j.signature?.version, (j.result ?? '').length);
}
fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify(index, null, 1) + '\n');

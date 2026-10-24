#!/usr/bin/env node
// Writes the planetary data FFM embeds (lib/data/planetary/*.bin) and their provenance
// (lib/data/planetary/SOURCES.json) from the public sources, which scripts/fetch-planetary-sources.mjs
// downloads and verifies against pinned SHA-256 hashes:
//
//   node scripts/generate-planetary-data.mjs <sources-dir>
//
//   grgm660prim.bin   GRGM660PRIM, the Moon's field to degree and order 660 (Lemoine et al. 2013, JGR Planets
//                     118, doi:10.1002/jgre.20118), PDS GRAIL-L-LGRS-5-RDR-V1.0 gggrx_0660pm_sha.tab.
//   mro120f.bin       MRO120F, Mars's field to degree and order 120 (Konopliv et al. 2020, GRL 47,
//                     doi:10.1029/2020GL090568), PDS MRO-M-RSS-5-SDP-V1.0 jgmro_120f_sha.tab.
//   ../mars_atmosphere_data.h  the banded-exponential Mars atmosphere NASA GMAT R2026a ships (Apache-2.0).
//   moon_pa_de440.bin DE440's lunar principal-axis libration angles (Park et al. 2021), 2000-01-01 to
//                     2050-01-01, the Chebyshev records of NAIF's moon_pa_de440_200625.bpc copied as published.
//
// Field file layout (little endian): "FFMF", u32 version 1, u32 degree, u32 order, f64 GM (km^3/s^2),
// f64 reference radius (km), then C(n,m) for n = 0..degree, m = 0..n and the same for S, as float32 (the
// fully normalized coefficients of the table rounded to float32, relative 6e-8: at the Moon's surface the
// rounding moves the acceleration by under 1e-11 of itself, tests/planetary.e2e.mjs measures it).
// Libration file layout: "FFMP", u32 version 1, u32 degree, u32 records, f64 first record start (TDB seconds
// past J2000), f64 record length (s), then records x 3 angles x (degree + 1) float64 Chebyshev coefficients
// (phi, delta, w of the 3-1-3 rotation J2000 -> MOON_PA; the record's midpoint and radius follow from the
// start and length).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, '../lib/data/planetary');
const sources = process.argv[2];
if (!sources) throw new Error('usage: generate-planetary-data.mjs <sources-dir>');
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
fs.mkdirSync(outDir, { recursive: true });
const provenance = JSON.parse(fs.readFileSync(path.join(here, 'planetary-sources.json'), 'utf8'));
const written = {};

// ---- harmonic fields (PDS SHADR tables) ----------------------------------------------------------------
function field(sourceKey, outName) {
  const spec = provenance.sources[sourceKey];
  const file = path.join(sources, spec.directory, spec.file);
  const bytes = fs.readFileSync(file);
  if (sha(bytes) !== spec.sha256) throw new Error(`${spec.file}: SHA-256 differs from the pinned ${spec.sha256}`);
  const lines = bytes.toString('latin1').split(/\r?\n/).filter((l) => l.trim().length);
  const head = lines[0].split(',').map((v) => Number(v));
  const [radius, gm, , degree, order, normalization] = head;
  if (normalization !== 1) throw new Error(`${spec.file}: coefficients are not fully normalized`);
  if (degree !== spec.degree || order !== spec.degree) throw new Error(`${spec.file}: degree ${degree}/${order}, expected ${spec.degree}`);
  const rows = (degree + 1) * (degree + 2) / 2;
  const C = new Float32Array(rows), S = new Float32Array(rows);
  const seen = new Uint8Array(rows);
  for (const line of lines.slice(1)) {
    const f = line.split(',');
    const n = Number(f[0]), m = Number(f[1]);
    if (!(n >= 0 && n <= degree && m >= 0 && m <= n)) throw new Error(`${spec.file}: bad row ${line}`);
    const at = n * (n + 1) / 2 + m;
    C[at] = Number(f[2]); S[at] = Number(f[3]); seen[at] = 1;
  }
  for (let n = 0; n <= degree; ++n) for (let m = 0; m <= n; ++m)
    if (!seen[n * (n + 1) / 2 + m] && n >= 1) throw new Error(`${spec.file}: missing (${n},${m})`);
  const header = Buffer.alloc(40);
  header.write('FFMF', 0, 'latin1'); header.writeUInt32LE(1, 4); header.writeUInt32LE(degree, 8); header.writeUInt32LE(order, 12);
  header.writeDoubleLE(gm, 16); header.writeDoubleLE(radius, 24);
  header.writeDoubleLE(0, 32); // reserved
  const out = Buffer.concat([header, Buffer.from(C.buffer), Buffer.from(S.buffer)]);
  fs.writeFileSync(path.join(outDir, outName), out);
  written[outName] = { bytes: out.length, sha256: sha(out), source: sourceKey, degree, gmKm3S2: gm, referenceRadiusKm: radius };
}

// ---- lunar libration (NAIF binary PCK, DAF type 2) -----------------------------------------------------
function libration() {
  const spec = provenance.sources['moon-pa-de440'];
  const file = fs.readFileSync(path.join(sources, spec.directory, spec.file));
  if (sha(file) !== spec.sha256) throw new Error(`${spec.file}: SHA-256 differs from the pinned ${spec.sha256}`);
  if (file.toString('latin1', 0, 8) !== 'DAF/PCK ' || file.toString('latin1', 88, 96) !== 'LTL-IEEE') throw new Error('Expected a little-endian DAF/PCK');
  if (file.readInt32LE(8) !== 2 || file.readInt32LE(12) !== 5) throw new Error('Expected ND=2, NI=5');
  const forward = file.readInt32LE(76);
  const summaryRecord = file.subarray((forward - 1) * 1024, forward * 1024);
  const count = summaryRecord.readDoubleLE(16);
  const START = Date.parse(spec.window.start) / 1000 - Date.parse('2000-01-01T12:00:00Z') / 1000; // UTC seconds past J2000; TDB-UTC is 64 s at most
  const STOP = Date.parse(spec.window.stop) / 1000 - Date.parse('2000-01-01T12:00:00Z') / 1000;
  for (let s = 0; s < count; ++s) {
    const at = 24 + s * 40;
    const et0 = summaryRecord.readDoubleLE(at), et1 = summaryRecord.readDoubleLE(at + 8);
    const body = summaryRecord.readInt32LE(at + 16), frame = summaryRecord.readInt32LE(at + 20), type = summaryRecord.readInt32LE(at + 24);
    const first = summaryRecord.readInt32LE(at + 28), last = summaryRecord.readInt32LE(at + 32);
    if (body !== 31008 || frame !== 1 || type !== 2 || START < et0 || STOP > et1) continue;
    const end = file.subarray((last - 4) * 8, last * 8);
    const init = end.readDoubleLE(0), length = end.readDoubleLE(8), size = end.readDoubleLE(16), n = end.readDoubleLE(24);
    const degree = (size - 2) / 3 - 1;
    if (!Number.isInteger(degree)) throw new Error('Not a type 2 segment of three angles');
    const k0 = Math.floor((START - init) / length), k1 = Math.ceil((STOP - init) / length);
    const records = k1 - k0;
    const header = Buffer.alloc(40);
    header.write('FFMP', 0, 'latin1'); header.writeUInt32LE(1, 4); header.writeUInt32LE(degree, 8); header.writeUInt32LE(records, 12);
    header.writeDoubleLE(init + k0 * length, 16); header.writeDoubleLE(length, 24); header.writeDoubleLE(0, 32);
    const data = Buffer.alloc(records * 3 * (degree + 1) * 8);
    for (let k = 0; k < records; ++k) {
      const record = file.subarray((first - 1 + (k0 + k) * size) * 8, (first - 1 + (k0 + k + 1) * size) * 8);
      const mid = record.readDoubleLE(0), radius = record.readDoubleLE(8);
      if (Math.abs(mid - (init + (k0 + k + 0.5) * length)) > 1e-6 || Math.abs(radius - length / 2) > 1e-6) throw new Error(`Record ${k0 + k} is not on the segment's uniform grid`);
      record.copy(data, k * 3 * (degree + 1) * 8, 16, size * 8);
    }
    const out = Buffer.concat([header, data]);
    fs.writeFileSync(path.join(outDir, 'moon_pa_de440.bin'), out);
    written['moon_pa_de440.bin'] = { bytes: out.length, sha256: sha(out), source: 'moon-pa-de440', degree, records, startTdbSeconds: init + k0 * length, lengthSeconds: length, segmentCount: n };
    return;
  }
  throw new Error('No segment of the binary PCK covers the window');
}

// ---- Mars banded-exponential atmosphere (GMAT's table) -------------------------------------------------
function marsAtmosphere() {
  const spec = provenance.sources['mars-exponential-atmosphere'];
  const bytes = fs.readFileSync(path.join(sources, spec.directory, spec.file));
  if (sha(bytes) !== spec.sha256) throw new Error(`${spec.file}: SHA-256 differs from the pinned ${spec.sha256}`);
  const rows = bytes.toString('latin1').split(/\r?\n/).filter((l) => l.trim().length).map((l) => l.split(',').map(Number));
  if (rows.some((r) => r.length !== 3 || r.some((v) => !Number.isFinite(v)))) throw new Error(`${spec.file}: malformed row`);
  rows.forEach((r, i) => { if (i && !(r[0] > rows[i - 1][0] && r[1] < rows[i - 1][1] && r[1] > 0 && r[2] > 0)) throw new Error(`${spec.file}: row ${i} is not a decreasing banded profile`); });
  const text = `// Generated by scripts/generate-planetary-data.mjs from ${spec.file} (${spec.url}, SHA-256 ${spec.sha256}). DO NOT EDIT.
// NASA GMAT R2026a, Apache License 2.0: the Mars banded-exponential atmosphere, rows of (altitude of the band's bottom in km,
// density at it in kg/m^3, scale height in km), the model form of Vallado, Fundamentals of Astrodynamics and Applications, 8.6.
#pragma once
namespace astro {
namespace planetary {
struct AtmosphereBand { double altitudeKm, densityKgM3, scaleHeightKm; };
constexpr AtmosphereBand kMarsBands[] = {
${rows.map((r) => `    {${r[0]}, ${r[1]}, ${r[2]}},`).join('\n')}
};
} // namespace planetary
} // namespace astro
`;
  fs.writeFileSync(path.join(here, '../lib/mars_atmosphere_data.h'), text);
  written['mars_atmosphere_data.h'] = { bytes: text.length, sha256: sha(text), source: 'mars-exponential-atmosphere', rows: rows.length };
}

field('grgm660prim', 'grgm660prim.bin');
field('mro120f', 'mro120f.bin');
libration();
marsAtmosphere();
fs.writeFileSync(path.join(outDir, 'SOURCES.json'), JSON.stringify({ sources: provenance.sources, embedded: written }, null, 2) + '\n');
for (const [name, info] of Object.entries(written)) console.log(`${name}: ${info.bytes} bytes sha256 ${info.sha256}`);

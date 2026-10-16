#!/usr/bin/env node
// HPOP's Earth orientation as a NAIF binary PCK, so Nyx evaluates the field
// and the atmosphere in the same Earth-fixed axes as HPOP.
//
//   node tests/evidence/nyx/make-itrf-bpc.mjs <out.bpc> --nyx <hpop-xval-nyx binary>
//        [--pca <pck08.pca>] [--python <venv python>]
//
// Nyx (through ANISE) takes the Earth's orientation from a binary PCK, not
// from EOP rows. NAIF's earth_latest_high_prec.bpc is JPL's own reduction
// (IAU 1976/1980 with nutation corrections), a few milliarcseconds from the
// IERS 2010 pole of the case export's rows. This writes HPOP's own rotation
// instead: EarthRotation::matrix (GCRF -> ITRF, IAU 2006/2000A with the
// eop-2026-08 rows) from HPOP's sources (../erfa-spice/hpop-frames-native.mjs,
// at the TDB date HPOP's force model evaluates it), every 30 s from
// 2026-08-01 22:00 to 2026-08-03 02:00 UTC, fitted by write_bpc.py as
// one-hour Chebyshev records of the 3-1-3 Euler angles (frame ITRF93, class
// 3000, relative to J2000 = ICRF axes). Each record is tagged with the
// ephemeris time hifitime (Nyx's clock) gives the sample's UTC instant, so at
// any UTC instant Nyx reads the rotation HPOP uses at that instant (HPOP's
// TDB and hifitime's ET differ by tens of microseconds). The file is read
// back through SPICE (write_bpc.py) and through ANISE (the runner's
// "rotation" mode) at the samples it was not fitted to; that and the BPC's
// SHA-256 go to itrf-bpc.json beside this file. ../erfa-spice checks HPOP's
// rotation itself against ERFA and SPICE.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { buildHpopFrames, eopStream } from '../erfa-spice/hpop-frames-native.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { values: o, positionals } = parseArgs({ options: {
  python: { type: 'string', default: process.env.XVAL_PYTHON ?? '/Users/tj/software/tools/xval/erfa-spice/bin/python' },
  nyx: { type: 'string' }, pca: { type: 'string', default: '/Users/tj/software/tools/xval/nyx/data/pck08.pca' },
}, allowPositionals: true });
const out = positionals[0];
if (!out || !o.nyx) throw new Error('usage: make-itrf-bpc.mjs <out.bpc> --nyx <binary> [--pca <pck08.pca>] [--python <python>]');
const nyx = (input) => JSON.parse(execFileSync(o.nyx, { input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 256 << 20 }));
// Rotation angle of a b^T (row-major), from its antisymmetric part.
const angle = (a, b) => {
  const d = (i, j) => a[3 * i] * b[3 * j] + a[3 * i + 1] * b[3 * j + 1] + a[3 * i + 2] * b[3 * j + 2];
  return Math.asin(Math.min(1, Math.hypot(d(2, 1) - d(1, 2), d(0, 2) - d(2, 0), d(1, 0) - d(0, 1)) / 2));
};
const UAS = Math.PI / 180 / 3600 / 1e6;
const CASES = JSON.parse(fs.readFileSync(path.join(here, '../cases/hpop-reference-cases.json'), 'utf8'));
const SET = 'eop-2026-08', START = Date.parse('2026-08-01T22:00:00Z'), STEP_MS = 30000, COUNT = 28 * 120 + 1;
const utcs = Array.from({ length: COUNT }, (_, i) => new Date(START + i * STEP_MS).toISOString().replace('Z', ''));

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hpop-itrf-bpc-'));
try {
  const frames = await buildHpopFrames(work);
  const { et } = nyx({ mode: 'et', utc: utcs });
  // HPOP evaluates the rotation at its force model's single-double TDB Julian
  // date (about 40 us resolution); the tag adds that rounding to the UTC
  // instant's ET, so the records are the smooth rotation HPOP rounds from
  // (the rounding is a jitter of up to 0.3 mas, not reproduced).
  const rows = frames.at(eopStream(work, CASES, SET), utcs).map((e, i) => ({
    et: et[i] + ((e.jdTdb - 2451545.0) * 86400 - (e.ttWhole + e.ttFraction + e.tdbMinusTtS)), c2t: e.c2t }));
  const src = path.join(work, 'rotations.json');
  fs.writeFileSync(src, JSON.stringify(rows));
  fs.rmSync(out, { force: true });
  const fit = JSON.parse(execFileSync(o.python, ['-I', path.join(here, 'write_bpc.py'), src, out], { encoding: 'utf8' }));
  // ANISE's reading of the file against HPOP's matrices.
  const inside = rows.filter((r) => r.et >= fit.firstEt && r.et <= fit.lastEt);
  const { c2t } = nyx({ mode: 'rotation', pca: o.pca, bpc: out, et: inside.map((r) => r.et) });
  const anise = inside.map((r, i) => angle(c2t[i], r.c2t) / UAS);
  const sha = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  fs.writeFileSync(path.join(here, 'itrf-bpc.json'), `${JSON.stringify({
    about: 'HPOP\'s GCRF -> ITRF rotation (EarthRotation::matrix with the case export\'s eop-2026-08 rows) as a type-2 binary PCK for Nyx (make-itrf-bpc.mjs, write_bpc.py). Records tagged with hifitime ET of each UTC sample. Residuals in microarcseconds: fitted = the even 60-s samples the Chebyshev records were fitted to, checked = the odd samples between them, both read back through SPICE pxform; aniseReadBack = every sample read back through ANISE (Nyx).',
    earthOrientation: SET, utcFirst: utcs[0], utcLast: utcs.at(-1), sampleStepS: STEP_MS / 1000,
    bpc: { name: path.basename(out), sha256: sha(out), bytes: fs.statSync(out).size },
    ...fit,
    aniseReadBack: { samples: anise.length, maxResidualUas: Math.max(...anise), nyxBinarySha256: sha(o.nyx) },
  }, null, 1)}\n`);
  console.error(`${out}: ${fit.records} records, residual fitted ${fit.maxFittedResidualUas.toFixed(3)} uas, checked ${fit.maxCheckedResidualUas.toFixed(3)} uas, ANISE ${Math.max(...anise).toFixed(3)} uas`);
} finally { fs.rmSync(work, { recursive: true, force: true }); }

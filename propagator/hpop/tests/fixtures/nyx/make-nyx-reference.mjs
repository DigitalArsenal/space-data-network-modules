#!/usr/bin/env node
// Nyx Space reference trajectories for propagator/hpop.
//
// Nyx (nyx-space 2.6.0 with ANISE 0.10.6, Nyx Space / Rabotin, MPL-2.0)
// propagates the cross-validation cases (../xval/xval-cases.json) from the
// Orekit file's initial states.
//
//   node tests/fixtures/nyx/make-nyx-reference.mjs <cargo> <work dir> <pck08.pca> <earth_latest_high_prec.bpc> <out.json> [only]
//
// <cargo> builds src/main.rs (Cargo.lock pins every crate); target and
// registry go wherever CARGO_TARGET_DIR and CARGO_HOME point. The data files
// are public: pck08.pca (http://public-data.nyxspace.com/anise/v0.5/pck08.pca,
// planetary constants for the frames) and NAIF's earth_latest_high_prec.bpc
// (https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/), whose ITRF93
// orientation is the Earth-fixed frame of the field. Their SHA-256 are
// written into the output.
//
// Setup, matched to the Orekit file where Nyx allows:
//   - GM 398600.4415 km^3/s^2 on the integration frame (SPICE J2000, DE440's
//     ICRF axes, about the Earth) and on the field; HPOP's EGM2008 20x20
//     (../xval/egm2008-cof.mjs) at 6378.1363 km in ITRF93;
//   - Sun and Moon from the repo's de440-2026.bsp, GM from pck08;
//   - radiation pressure 1361 W/m^2 at Nyx's 1 au (149 597 870.7 km), Cr 1.3,
//     20 m^2, 1000 kg, the Earth a 6378.137 km sphere for the shadow;
//   - drag: Cd 2.2, Nyx's NRLMSISE-00 on mean local solar time with the
//     daily Ap (its defaults, as Orekit's and HPOP's), constant F10.7 150,
//     Ap 15, Kp 3, altitude on the WGS84 ellipsoid in ITRF93;
//   - RK8(9) at 1e-13, steps of at most 60 s, restarted at every sample.
// What Nyx does differently (../../../docs/cross-validation.md):
//   - Earth orientation comes from JPL's BPC (ITRF93 from IERS data JPL
//     processed), not the IERS rows Orekit read: the two differ at the
//     milliarcsecond level;
//   - the Sun's shadow radius is pck08's 696 000 km, not 695 700 km.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeEgm2008Cof } from '../xval/egm2008-cof.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const [cargo, work, pca, bpc, out, only] = process.argv.slice(2);
if (!out) throw new Error('usage: make-nyx-reference.mjs <cargo> <work dir> <pck08.pca> <earth_latest_high_prec.bpc> <out.json> [only]');
fs.mkdirSync(work, { recursive: true });
const OREKIT = JSON.parse(fs.readFileSync(path.join(here, '../orekit/orekit-reference.json'), 'utf8'));
const LIST = JSON.parse(fs.readFileSync(path.join(here, '../xval/xval-cases.json'), 'utf8')).cases;
const KERNEL = path.resolve(here, '../../../../../files/orbit-products/tests/fixtures/de440/de440-2026.bsp');
const K = OREKIT.constants;
const cof = path.join(work, 'EGM2008-hpop.cof');
writeEgm2008Cof(cof, K);

execFileSync(cargo, ['build', '--release', '--locked', '--manifest-path', path.join(here, 'Cargo.toml')], { stdio: ['ignore', 'ignore', 'inherit'] });
const target = process.env.CARGO_TARGET_DIR ?? path.join(here, 'target');
const cases = LIST.filter((name) => (!only || name.includes(only))).map((name) => OREKIT.cases.find((x) => `${x.orbit} ${x.forces}` === name));
const input = {
  cof, kernel: KERNEL, pca, bpc, gmKm3S2: K.gm / 1e9, fieldRadiusKm: K.fieldRadiusM / 1000, shadowRadiusKm: K.shadowRadiusM / 1000,
  massKg: K.massKg, areaM2: K.areaM2, cr: K.cr, cd: K.cd, fluxWm2: 1361, f107: K.f107, ap: K.ap, kp: 3,
  cases: cases.map((c) => ({ orbit: c.orbit, forces: c.forces, degree: c.degree, order: c.order, thirdBodies: c.thirdBodies, srp: c.srp, drag: c.drag,
    state: c.samples[0].slice(1, 7).map((v) => v / 1000), epochs: c.samples.map((s) => s[7]), offsets: c.samples.map((s) => s[0]) })),
};
const result = JSON.parse(execFileSync(path.join(target, 'release/hpop-xval-nyx'), { input: JSON.stringify(input), maxBuffer: 64 << 20, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] }));
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const doc = {
  source: 'Nyx Space 2.6.0 with ANISE 0.10.6 (MPL-2.0), RK8(9) at 1e-13 (steps <= 60 s), SPICE J2000 (ICRF) axes about the Earth; field in ITRF93 from NAIF earth_latest_high_prec.bpc; Sun and Moon from DE440; NRLMSISE-00 with constant space weather',
  epochUtc: OREKIT.epochUtc,
  data: { 'de440-2026.bsp': sha(KERNEL), 'pck08.pca': sha(pca), 'earth_latest_high_prec.bpc': sha(bpc) },
  cases: result.cases.map((r, i) => {
    const c = cases[i];
    return { orbit: c.orbit, forces: c.forces, degree: c.degree, order: c.order, thirdBodies: c.thirdBodies, srp: c.srp, drag: c.drag,
      samples: r.samples.map((s, k) => [s[0], ...s.slice(1, 4).map((x) => Number((x * 1000).toFixed(6))), ...s.slice(4, 7).map((x) => Number((x * 1000).toFixed(9))), c.samples[k][7]]) };
  }),
};
fs.writeFileSync(out, `${JSON.stringify(doc, null, 1).replace(/\[\n\s+([^\[\]{}]*?)\n\s+\]/g, (m, body) => `[${body.replace(/\n\s+/g, ' ')}]`)}\n`);

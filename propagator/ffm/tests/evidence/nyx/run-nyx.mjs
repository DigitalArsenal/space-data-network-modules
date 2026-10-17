#!/usr/bin/env node
// Nyx Space (nyx-space 2.6.0 with ANISE 0.10.6, MPL-2.0) on the FFM
// reference cases: every case of ../cases/ffm-reference-cases.json whose
// forces Nyx models, from the same initial state, epoch, constants, Earth
// orientation, space weather, DE440 kernel and gravity coefficients, sampled
// every hour for 24 h, and (with --stm) Nyx's 9x9 state-transition matrix
// (orbit, Cr, Cd) at every sample.
//
//   node tests/evidence/nyx/run-nyx.mjs <cargo> <work dir> <pck08.pca> <ITRF93 bpc> <out.json>
//        [--only <substring>] [--stm] [--tolerance 1e-13] [--max-step 30] [--bin <binary>]
//
// --bin runs a prebuilt runner instead of building src/main.rs (the
// make-msis-variant.mjs diagnostic build).
// <cargo> builds src/main.rs (Cargo.lock pins every crate; target and registry
// go wherever CARGO_TARGET_DIR and CARGO_HOME point). pck08.pca is Nyx's
// planetary constants file (http://public-data.nyxspace.com/anise/v0.5/pck08.pca).
// The ITRF93 BPC is the Earth's orientation: make-itrf-bpc.mjs writes FFM's
// own IERS 2010 rotation with the case export's EOP rows as one (the default
// comparison); NAIF's earth_latest_high_prec.bpc gives Nyx's usual JPL
// orientation instead. Its SHA-256 is recorded. Nyx is a test oracle only;
// nothing here ships. <out.json> holds the samples (meters, m/s; GCRF, or
// EME2000 for the EME2000 cases), the STMs (6x6 orbit block, and the Cr and Cd
// columns per unit Cr*A/m and Cd*A/m), Nyx's version, the binary's SHA-256 and
// those of every input file, and every setting.
//
// Settings that match FFM (the case export's "forces" and "constants"):
//   - Earth GM 398600.4415 km^3/s^2 on the integration frame (SPICE J2000 =
//     ICRF axes, about the Earth); the field from FFM's embedded EGM2008 or
//     EGM96 coefficients as .cof (../gmat/gmat-files.mjs writeCof, the file
//     GMAT reads), tide-free, at 6378.1363 km, in ITRF93 from the BPC; G2's
//     36x24 with the terms of order >= 1 above degree 24 written as zero.
//   - Sun and Moon from the case export's DE440 kernel, with the DE440 header
//     GMs set in the almanac (pck08's otherwise); the Sun a 695 700 km sphere
//     for the shadow (pck08: 696 000 km), the Earth a 6378.137 km sphere.
//   - Cannonball radiation pressure, 1361 W/m^2 at 1 au (149 597 870.7 km),
//     Nyx's conical shadow with penumbra.
//   - Drag: Nyx's NRLMSISE-00 on mean local solar time with the daily Ap
//     (its defaults; anomalous oxygen included, as FFM's gtd7d), altitude on
//     the WGS84 ellipsoid in ITRF93, constant F10.7 = F10.7a = 150, Ap 15,
//     Kp 3. W1: the case export's CSSI rows as a CelesTrak CSV, which Nyx
//     reads as FFM does (F10.7 of the previous day, the 81-day centered mean
//     and the daily Ap of the day).
//   - Written in src/main.rs because Nyx 2.6.0 has no such model: relativity
//     (R1 Schwarzschild; R2 IERS 2010 with Lense-Thirring about the BPC's
//     Earth-fixed z axis and de Sitter), the in-track acceleration (I1, QSW
//     S axis) and the drag-area rate (B1, b = Cd*A/m + rate * t).
//   - EME2000 cases: the state to GCRF by the IERS 2003 frame bias and the
//     samples back by it, as run-gmat.mjs.
//   - RK8(9) with Nyx's RSS Cartesian step error control at 1e-13 and steps
//     of at most 30 s, stopped at every sample.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { writeCof } from '../gmat/gmat-files.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../../..');
const { values: o, positionals } = parseArgs({ options: {
  only: { type: 'string' }, stm: { type: 'boolean', default: false },
  tolerance: { type: 'string', default: '1e-13' }, 'max-step': { type: 'string', default: '30' }, bin: { type: 'string' },
}, allowPositionals: true });
const [cargo, workArg, pca, bpc, out] = positionals;
if (!out) throw new Error('usage: run-nyx.mjs <cargo> <work dir> <pck08.pca> <ITRF93 bpc> <out.json> [--only s] [--stm]');
const work = path.resolve(workArg);
fs.mkdirSync(work, { recursive: true });
const sha256 = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const CASES_PATH = path.join(here, '../cases/ffm-reference-cases.json');
const CASES = JSON.parse(fs.readFileSync(CASES_PATH, 'utf8'));
const K = CASES.constants;
const KERNEL = path.join(repo, CASES.models.ephemeris.path);
if (sha256(KERNEL) !== CASES.models.ephemeris.sha256) throw new Error('DE440 kernel does not match the case export');

// What Nyx 2.6.0 does not model (src/main.rs adds R1, R2, I1, B1).
function unsupported(c) {
  const f = c.forces;
  if (f.solidTides) return 'solid tides: Nyx 2.6.0 SolidTides is IERS 2010 step 1 with one k2 and one k3 (no order-dependent k2m, no k+ degree-4 terms, no step-2 frequency corrections)';
  if (f.oceanTides) return 'ocean tides: not in Nyx 2.6.0';
  if (f.earthRadiation) return 'Knocke Earth radiation: not in Nyx 2.6.0';
  if (f.drag && f.drag.atmosphere !== 'NRLMSISE00') return `${f.drag.atmosphere}: not among Nyx 2.6.0's atmospheres`;
  return null;
}

// IERS 2003 frame bias (IERS Conventions 2010, eq. 5.21), as run-gmat.mjs.
const MAS = Math.PI / 180 / 3600000;
const [XI0, ETA0, DA0] = [-16.617 * MAS, -6.819 * MAS, -14.6 * MAS];
const BIAS = [
  [1 - (DA0 ** 2 + XI0 ** 2) / 2, DA0, -XI0],
  [-DA0 - ETA0 * XI0, 1 - (DA0 ** 2 + ETA0 ** 2) / 2, -ETA0],
  [XI0 - ETA0 * DA0, ETA0 + XI0 * DA0, 1 - (ETA0 ** 2 + XI0 ** 2) / 2],
];
const mul = (m, v) => m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
const mulT = (m, v) => [0, 1, 2].map((i) => m[0][i] * v[0] + m[1][i] * v[1] + m[2][i] * v[2]);

// The CSSI rows as the CelesTrak CSV Nyx reads (io::space_weather).
function writeCsv(file) {
  const cols = ['DATE', 'BSRN', 'ND', ...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => `KP${i}`), 'KP_SUM', ...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => `AP${i}`), 'AP_AVG', 'CP', 'C9', 'ISN',
    'F10.7_OBS', 'F10.7_ADJ', 'F10.7_DATA_TYPE', 'F10.7_OBS_CENTER81', 'F10.7_OBS_LAST81', 'F10.7_ADJ_CENTER81', 'F10.7_ADJ_LAST81'];
  const key = (c) => c.replace('F10.7_', 'F107_');
  const lines = CASES.spaceWeather.cssi.rows.map((r) => cols.map((c) => (c === 'F10.7_DATA_TYPE' ? 'OBS' : r[key(c)])).join(','));
  fs.writeFileSync(file, `${cols.join(',')}\n${lines.join('\n')}\n`);
  return file;
}

const files = {};
const cofFor = (field) => {
  const name = `${field.model}-${field.degree}x${field.order}${field.tesseralDegree !== undefined ? `t${field.tesseralDegree}` : ''}.cof`;
  if (!files[name]) { const p = path.join(work, name); writeCof(p, field, CASES); files[name] = p; }
  return files[name];
};

const skipped = [], selected = [];
for (const c of CASES.cases) {
  if (o.only && !c.id.includes(o.only)) continue;
  const why = unsupported(c);
  if (why) skipped.push({ id: c.id, reason: why }); else selected.push(c);
}
const input = {
  mode: 'propagate', kernel: KERNEL, pca, bpc, gmKm3S2: K.earthGmM3S2 / 1e9, occultingRadiusKm: K.shadowBodyRadiusM / 1000,
  sunRadiusKm: K.sunRadiusM / 1000, sunGmKm3S2: K.sunGmM3S2 / 1e9, moonGmKm3S2: K.moonGmM3S2 / 1e9, fluxWm2: K.solarIrradianceAt1AuWM2,
  tolerance: Number(o.tolerance), maxStepS: Number(o['max-step']),
  cases: selected.map((c) => {
    const f = c.forces;
    let [x, y, z] = c.initialState.positionM, [vx, vy, vz] = c.initialState.velocityMS;
    if (c.frame === 'EME2000') { [x, y, z] = mulT(BIAS, [x, y, z]); [vx, vy, vz] = mulT(BIAS, [vx, vy, vz]); }
    const d = f.drag;
    return {
      id: c.id, state: [x, y, z, vx, vy, vz].map((v) => v / 1000), epochs: c.sampleEpochsUtc, offsets: c.sampleOffsetsS, massKg: K.spacecraft.massKg,
      field: f.gravityField ? { cof: cofFor(f.gravityField), degree: f.gravityField.degree, order: f.gravityField.order, radiusKm: f.gravityField.radiusM / 1000 } : null,
      thirdBodies: f.thirdBodies.length > 0,
      srp: f.solarRadiationPressure ? { cr: f.solarRadiationPressure.cr, areaM2: f.solarRadiationPressure.areaM2 } : null,
      drag: d ? { cd: d.cd, areaM2: d.areaM2, rateM2KgS: d.areaOverMassRateM2KgS ?? null,
        weather: d.spaceWeather === 'cssi' ? { csv: files['cssi.csv'] ??= writeCsv(path.join(work, 'cssi.csv')) }
          : { f107: CASES.spaceWeather.constant.f107, ap: CASES.spaceWeather.constant.ap, kp: CASES.spaceWeather.constant.kp } } : null,
      inTrackMS2: f.inTrackAccelerationMS2, relativity: f.relativity, stm: o.stm,
    };
  }),
};

if (!o.bin) execFileSync(cargo, ['build', '--release', '--locked', '--manifest-path', path.join(here, 'Cargo.toml')], { stdio: ['ignore', 'ignore', 'inherit'] });
const bin = o.bin ?? path.join(process.env.CARGO_TARGET_DIR ?? path.join(here, 'target'), 'release/ffm-xval-nyx');
const started = Date.now();
const result = JSON.parse(execFileSync(bin, { input: JSON.stringify(input), maxBuffer: 256 << 20, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] }));
const wallSeconds = (Date.now() - started) / 1000;

const cases = result.cases.map((r, i) => {
  const c = selected[i];
  const toOut = (v) => (c.frame === 'EME2000' ? mul(BIAS, v) : v);
  const entry = { id: c.id, orbit: c.orbit, forceSet: c.forceSet, row: c.row, toleranceClass: c.toleranceClass, frame: c.frame,
    samples: r.samples.map((s) => [s[0], ...toOut(s.slice(1, 4)).map((v) => Number((v * 1000).toFixed(6))), ...toOut(s.slice(4, 7)).map((v) => Number((v * 1000).toFixed(9)))]) };
  if (r.stm) {
    // 6x6 orbit block (same units in SI as in km, km/s); Cr and Cd columns
    // in m and m/s per unit Cr*A/m and Cd*A/m (m^2/kg). EME2000: Q Phi Q^T.
    const M = c.frame === 'EME2000' ? BIAS : [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const q = (i, k) => (Math.floor(i / 3) === Math.floor(k / 3) ? M[i % 3][k % 3] : 0);
    const perParameter = (p) => K.spacecraft.massKg / p.areaM2 * 1000;
    entry.stm = r.stm.map((phi) => {
      const block = new Array(36).fill(0);
      for (let i = 0; i < 6; ++i) for (let j = 0; j < 6; ++j) {
        let s = 0;
        for (let k = 0; k < 6; ++k) for (let l = 0; l < 6; ++l) { const a = q(i, k), b = q(j, l); if (a && b) s += a * phi[k * 9 + l] * b; }
        block[i * 6 + j] = Number(s.toPrecision(15));
      }
      const column = (j, scale) => [0, 1, 2, 3, 4, 5].map((i) => [0, 1, 2, 3, 4, 5].reduce((s, k) => s + q(i, k) * phi[k * 9 + j], 0) * scale)
        .map((v) => Number(v.toPrecision(15)));
      return { phi: block, ...(c.forces.solarRadiationPressure ? { srpAreaOverMass: column(6, perParameter(c.forces.solarRadiationPressure)) } : {}),
        ...(c.forces.drag ? { dragAreaOverMass: column(7, perParameter(c.forces.drag)) } : {}) };
    });
  }
  return entry;
});

const lock = fs.readFileSync(path.join(here, 'Cargo.lock'), 'utf8');
const version = (name) => lock.match(new RegExp(`name = "${name}"\\nversion = "([^"]+)"`))?.[1];
const doc = {
  about: 'Nyx Space trajectories for the FFM reference cases (tests/evidence/nyx/run-nyx.mjs). Samples [t s, x y z m, vx vy vz m/s], GCRF (EME2000 for the EME2000 cases); stm: per sample, the 6x6 orbit STM (row-major) and the Cr and Cd columns per unit Cr*A/m and Cd*A/m, same axes.',
  tool: {
    name: 'Nyx Space (nyx-space, MPL-2.0) with ANISE and hifitime', nyxSpace: version('nyx-space'), anise: version('anise'), hifitime: version('hifitime'),
    rustc: execFileSync('rustc', ['--version'], { encoding: 'utf8' }).trim(), cargoLockSha256: sha256(path.join(here, 'Cargo.lock')),
    binary: path.basename(bin), binarySha256: sha256(bin),
    nyxCrateSha256: lock.match(/name = "nyx-space"\nversion = "[^"]+"\nsource = "[^"]+"\nchecksum = "([0-9a-f]+)"/)?.[1],
  },
  settings: {
    integrator: 'RK8(9) (Nyx Propagator::rk89)', tolerance: Number(o.tolerance), maxStepS: Number(o['max-step']), minStepS: 1e-3, errorControl: 'RSSCartesianStep',
    stm: o.stm, atmosphere: 'NRLMSISE-00 (Nyx, mean local solar time, daily Ap, anomalous oxygen included)',
    earthOrientation: `ITRF93 from ${path.basename(bpc)}`, axes: 'SPICE J2000 (ICRF) about the Earth; EME2000 cases through the IERS 2003 frame bias',
    ephemeris: 'the case export DE440 kernel through ANISE, at hifitime ET', constants: result.constants,
  },
  caseExportSha256: sha256(CASES_PATH),
  inputFiles: Object.fromEntries([['pck08.pca', pca], [path.basename(bpc), bpc], ...Object.entries(files)].map(([k, p]) => [k, sha256(p)])),
  wallSeconds,
  skipped,
  cases,
};
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(doc, null, 1).replace(/\[\n\s+([^\[\]{}]*?)\n\s+\]/g, (m, body) => `[${body.replace(/\n\s+/g, ' ')}]`)}\n`);
console.error(`${cases.length} cases, ${skipped.length} not modeled, ${wallSeconds.toFixed(0)} s -> ${out}`);

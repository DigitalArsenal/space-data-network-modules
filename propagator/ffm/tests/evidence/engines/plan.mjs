#!/usr/bin/env node
// The engine speed benchmark's plan: one neutral file every engine driver
// reads, so FFM and each reference propagator start from the same states with
// the same constants, Earth orientation, space weather, force tiers, spans and
// integrator settings.
//
//   node tests/evidence/engines/plan.mjs <work dir> [--finals <finals2000A.all> | --eop <eop.json>]
//
// Writes into <work dir>:
//   plan.json             cases (orbit x tier x integrator), constants, data paths
//   eop.json              IERS finals2000A rows for the arc as a $EOP stream (FFM)
//   EGM2008-ffm-70.gfc    FFM's embedded EGM2008 to 70x70 as ICGEM (Orekit)
//   EGM2008-ffm-70.cof    the same as GMAT/Nyx .cof
//
// Representation only: every number is copied from committed fixtures or the
// IERS file; nothing is propagated here.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));
const ffm = path.resolve(here, '../../..');
const repo = path.resolve(ffm, '../..');
const { values: o, positionals } = parseArgs({ allowPositionals: true, options: {
  finals: { type: 'string', default: '/Users/tj/software/gmat09-authority/orekit-data/orekit-data-main/Earth-Orientation-Parameters/IAU-2000/finals2000A.all' },
  // A $EOP fixture of make-eop.mjs instead of the finals file (the E2E's
  // committed rows); the reference engines need the finals file they read.
  eop: { type: 'string' },
} });
const work = path.resolve(positionals[0] ?? '');
if (!positionals[0]) throw new Error('usage: plan.mjs <work dir> [--finals <finals2000A.all>]');
fs.mkdirSync(work, { recursive: true });
const sha256 = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const REFERENCE = JSON.parse(fs.readFileSync(path.join(ffm, 'tests/fixtures/orekit/orekit-reference.json'), 'utf8'));
const KERNEL = path.join(repo, 'files/orbit-products/tests/fixtures/de440/de440-2026.bsp');
const K = REFERENCE.constants;
const EPOCH_UTC = '2026-08-02T00:00:00.000';
const DAYS = 3, SAMPLE_S = 3600;

// Earth orientation: finals2000A rows 2026-07-31 .. 2026-08-12 (MJD 61252 is 2026-07-31).
if (o.eop) fs.copyFileSync(o.eop, path.join(work, 'eop.json'));
else execFileSync(process.execPath, [path.join(ffm, 'tests/fixtures/orekit/make-eop.mjs'), o.finals, '61250', '61262', path.join(work, 'eop.json')], { stdio: 'inherit' });
// The field FFM embeds, to 70x70, for Orekit (.gfc) and GMAT/Nyx (.cof).
execFileSync(process.execPath, [path.join(ffm, 'tests/fixtures/orekit/make-gfc.mjs'), path.join(work, 'EGM2008-ffm-70.gfc'), '70', String(K.gm), String(K.fieldRadiusM), 'egm2008'], { stdio: 'inherit' });
writeCof(path.join(work, 'EGM2008-ffm-70.cof'), 70, K.gm, K.fieldRadiusM);

function writeCof(out, degree, gm, radius) {
  const header = fs.readFileSync(path.join(ffm, 'lib/egm2008_data.h'), 'utf8');
  const e = (v) => {
    const text = `${v < 0 ? '-' : ' '}${Math.abs(v).toExponential(14).toUpperCase().replace(/E([+-])(\d)$/, 'E$10$2')}`;
    if (Number(text) !== v) throw new Error(`${v} does not fit 15 digits`);
    return text;
  };
  const rows = [...header.matchAll(/\{\s*(\d+),\s*(\d+),\s*([-+0-9.eE]+),\s*([-+0-9.eE]+)\s*\}/g)]
    .map((m) => ({ n: Number(m[1]), m: Number(m[2]), c: Number(m[3]), s: Number(m[4]) })).filter((r) => r.n <= degree && r.n >= 2);
  fs.writeFileSync(out, [
    'COMMENT   1', `CCCCC  EGM2008 to ${degree}x${degree} as embedded in FFM (lib/egm2008_data.h), tide-free`,
    `POTFIELD ${degree} ${degree}  1 ${gm.toExponential(14).toUpperCase()} ${radius.toExponential(14).toUpperCase()} 1.00000000000000E+00`.replace(/E\+(\d)\b/g, 'E+0$1'),
    ...rows.map((r) => `RECOEF${String(r.n).padStart(5)}${String(r.m).padStart(3)}   ${e(r.c)}${r.m > 0 ? e(r.s) : ''}`),
    'END  ', '',
  ].join('\r\n'));
}

// The five xval orbits, from the Orekit file's initial GCRF states.
const ORBITS = ['LEO400', 'SSO700', 'GPS', 'GEO', 'MOLNIYA'].map((name) => {
  const c = REFERENCE.cases.find((x) => x.orbit === name);
  const [, x, y, z, vx, vy, vz] = c.samples[0];
  return { name, regime: { LEO400: 'LEO', SSO700: 'LEO', GPS: 'MEO', GEO: 'GEO', MOLNIYA: 'HEO' }[name], positionM: [x, y, z], velocityMS: [vx, vy, vz] };
});
const LEO = new Set(['LEO400', 'SSO700']);

// Force tiers.
//   FFM1: the FFM-1 profile (FFM.md) on the benchmark spacecraft. Drag is on for
//         every orbit as in FFM-1, which applies no drag above 2,500 km
//         (|r| - 6378.137 km, lib/force_models.cpp); engines without that cutoff
//         get the same cutoff (Orekit) or, for GPS and GEO, no drag.
//   COMMON: the subset every engine models alike: EGM2008 70x70, Sun and Moon,
//         cannonball radiation pressure with a conical shadow, and on LEO400 and
//         SSO700 NRLMSISE-00 drag on constant space weather.
const TIERS = {
  FFM1: (orbit) => ({
    gravity: { model: 'EGM2008', degree: 70, order: 70 },
    thirdBodies: ['SUN', 'MOON', 'VENUS_BARYCENTER', 'MARS_BARYCENTER', 'JUPITER_BARYCENTER'],
    srp: true, drag: true, dragCutoffKm: 2500, solidTides: 'IERS2010', oceanTides: { model: 'FES2004', degree: 30, order: 30 },
    relativity: 'IERS2010', earthRadiation: { model: 'KNOCKE', resolutionDeg: 15 },
  }),
  COMMON: (orbit) => ({
    gravity: { model: 'EGM2008', degree: 70, order: 70 }, thirdBodies: ['SUN', 'MOON'], srp: true,
    drag: LEO.has(orbit.name), dragCutoffKm: null, solidTides: null, oceanTides: null, relativity: null, earthRadiation: null,
  }),
};
// Integrator settings. Tolerances: relative r, absolute r*1000 in m and m/s
// (FFM's PRW convention: ABSOLUTE_TOLERANCES = r * 1000).
const INTEGRATORS = {
  'fixed-30s': { kind: 'fixed', stepS: 30, order: 8,
    note: 'eighth-order Runge-Kutta, fixed 30 s steps: the force-evaluation cost at identical work' },
  'tol1e-12-max300s': { kind: 'adaptive', relativeTolerance: 1e-12, absoluteTolerance: 1e-9, initialStepS: 30, minStepS: 0.01, maxStepS: 300,
    note: 'FFM standard RK settings (FFM 1.3.0 catalog; resident fallback before 2.0.0)' },
  'tol1e-14-max120s': { kind: 'adaptive', relativeTolerance: 1e-14, absoluteTolerance: 1e-11, initialStepS: 30, minStepS: 0.01, maxStepS: 120,
    note: 'FFM-1 catalog RK settings (CATALOG_INTEGRATOR)' },
};

const sampleOffsetsS = Array.from({ length: DAYS * 86400 / SAMPLE_S + 1 }, (_, i) => i * SAMPLE_S);
const isoAfter = (s) => new Date(Date.parse(`${EPOCH_UTC}Z`) + s * 1000).toISOString().replace('Z', '').replace(/\.(\d{3})$/, '.$1');
const cases = [];
for (const [tier, forcesOf] of Object.entries(TIERS)) for (const orbit of ORBITS) for (const [integrator, settings] of Object.entries(INTEGRATORS))
  cases.push({ id: `${orbit.name} ${tier} ${integrator}`, orbit: orbit.name, regime: orbit.regime, tier, integrator, settings, forces: forcesOf(orbit),
    positionM: orbit.positionM, velocityMS: orbit.velocityMS });

const plan = {
  about: 'FFM engine speed benchmark plan (tests/evidence/engines/plan.mjs). Every driver reads it; units SI, GCRF, UTC epochs, TT integration clock.',
  epochUtc: EPOCH_UTC, days: DAYS, sampleStepS: SAMPLE_S, sampleOffsetsS, sampleEpochsUtc: sampleOffsetsS.map(isoAfter),
  spacecraft: { massKg: K.massKg, areaM2: K.areaM2, cr: K.cr, cd: K.cd },
  constants: { earthGmM3S2: K.gm, fieldRadiusM: K.fieldRadiusM, shadowBodyRadiusM: K.shadowRadiusM, solarIrradianceAt1AuWM2: 1361,
    solarPressureAt1AuNm2: K.solarPressureAt1AuNm2, auM: 149597870700, sunRadiusM: 695700e3,
    wgs84: { equatorialRadiusM: 6378137, inverseFlattening: 298.257223563 } },
  spaceWeather: { f107: K.f107, f107a: K.f107a, ap: K.ap, kp: 3 },
  data: {
    kernel: { path: KERNEL, sha256: sha256(KERNEL) },
    finals: o.eop ? null : { path: o.finals, sha256: sha256(o.finals) },
    eop: { path: path.join(work, 'eop.json'), sha256: sha256(path.join(work, 'eop.json')) },
    gfc: { path: path.join(work, 'EGM2008-ffm-70.gfc'), sha256: sha256(path.join(work, 'EGM2008-ffm-70.gfc')) },
    cof: { path: path.join(work, 'EGM2008-ffm-70.cof'), sha256: sha256(path.join(work, 'EGM2008-ffm-70.cof')) },
  },
  tiers: Object.keys(TIERS), integrators: INTEGRATORS, orbits: ORBITS.map((x) => x.name), cases,
};
fs.writeFileSync(path.join(work, 'plan.json'), `${JSON.stringify(plan, null, 1)}\n`);
// The same plan as tab-separated lines for drivers without a JSON reader
// (OrekitBench.java): "global" lines, then one "case" line per case.
const k = plan.constants, sc = plan.spacecraft, sw = plan.spaceWeather;
const tsv = [
  ['global', 'epochUtc', EPOCH_UTC], ['global', 'days', DAYS], ['global', 'sampleStepS', SAMPLE_S],
  ['global', 'massKg', sc.massKg], ['global', 'areaM2', sc.areaM2], ['global', 'cr', sc.cr], ['global', 'cd', sc.cd],
  ['global', 'gm', k.earthGmM3S2], ['global', 'fieldRadiusM', k.fieldRadiusM], ['global', 'shadowRadiusM', k.shadowBodyRadiusM],
  ['global', 'solarPressureAt1AuNm2', k.solarPressureAt1AuNm2], ['global', 'auM', k.auM],
  ['global', 'f107', sw.f107], ['global', 'f107a', sw.f107a], ['global', 'ap', sw.ap],
  ['global', 'gfc', path.basename(plan.data.gfc.path)],
  ...cases.map((c) => {
    const s = c.settings, f = c.forces;
    return ['case', c.id, c.orbit, c.tier, c.integrator, s.kind, s.stepS ?? 0, s.relativeTolerance ?? 0, s.absoluteTolerance ?? 0,
      s.initialStepS ?? 0, s.minStepS ?? 0, s.maxStepS ?? 0, ...c.positionM, ...c.velocityMS, f.gravity.degree, f.gravity.order,
      f.thirdBodies.join(','), f.srp ? 1 : 0, f.drag ? 1 : 0, f.dragCutoffKm ?? 0, f.solidTides ? 1 : 0, f.oceanTides?.degree ?? 0,
      f.relativity ? 1 : 0, f.earthRadiation?.resolutionDeg ?? 0];
  }),
].map((r) => r.map((v) => (typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toPrecision(17)) : v)).join('\t')).join('\n');
fs.writeFileSync(path.join(work, 'plan.tsv'), `${tsv}\n`);
console.log(`${cases.length} cases -> ${path.join(work, 'plan.json')} and plan.tsv`);

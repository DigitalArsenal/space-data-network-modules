#!/usr/bin/env node
// The 72 HPOP reference cases as one neutral JSON file that every reference
// tool's runner reads (GMAT, Tudat, Nyx, Basilisk, ...), so each tool starts
// from the same initial states with the same constants, Earth orientation,
// space weather, force settings, sample epochs and step settings as the
// Orekit 13.1 suite (tests/orekit-summary.mjs, tests/lib/orekitCases.mjs).
//
//   node tests/evidence/cases/export-cases.mjs [out.json]
//
// Representation only: every number is copied from the committed fixtures,
// whose SHA-256 the output records. Nothing is computed except unit labels,
// sample offsets and the case classes the summary tables group by.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const hpop = path.resolve(here, '../../..');
const repo = path.resolve(hpop, '../..');
const out = process.argv[2] ?? path.join(here, 'hpop-reference-cases.json');

const rel = (p) => path.relative(repo, p).split(path.sep).join('/');
const sha256 = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const source = (p) => ({ path: rel(p), sha256: sha256(p) });
const json = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

const F = (p) => path.join(hpop, 'tests/fixtures', p);
const REFERENCE = F('orekit/orekit-reference.json');
const EOP_AUG = F('orekit/eop-2026-08.json'), EOP_JUN = F('orekit/eop-2026-06.json');
const SPW = F('orekit/spw-2026-08.json'), JB2008 = F('orekit/jb2008-2026-06.json');
const XVAL = F('xval/xval-cases.json');
const KERNEL = path.join(repo, 'files/orbit-products/tests/fixtures/de440/de440-2026.bsp');
const EGM2008 = path.join(hpop, 'lib/egm2008_data.h'), EGM96 = path.join(hpop, 'lib/egm96_data.h');
const FES2004 = path.join(hpop, 'lib/fes2004_data.h');

const reference = json(REFERENCE);
const k = reference.constants;
const xval = new Set(json(XVAL).cases);
// The tools that already hold a trajectory for a case (tests/lib/xvalCases.mjs).
const EXISTING = {
  gmat: F('gmat/gmat-reference.json'), tudatpy: F('tudat/tudatpy-reference.json'),
  'tudat-wasm': F('tudat/tudat-wasm-reference.json'), nyx: F('nyx/nyx-reference.json'),
};
const existing = Object.fromEntries(Object.entries(EXISTING).map(([id, p]) => [id, new Set(json(p).cases.map((c) => `${c.orbit} ${c.forces}`))]));

// DE440 header (as GMAT and Tudat were given them: make-gmat-reference.mjs, tudat_reference.py).
const AU_M = 149597870700, DAY_S = 86400;
const AU3_DAY2_TO_M3_S2 = AU_M ** 3 / DAY_S ** 2;
const DE440 = { GMS: 2.9591220828411951e-04, GMB: 8.9970116036316091e-10, EMRAT: 81.3005682214972154 };

// The summary tables' grouping (tests/orekit-summary.mjs ROWS) and the
// tolerance class (tests/lib/orekitCases.mjs toleranceFor).
const row = (c) => (c.drag ? 'drag' : c.degree > 0 || c.thirdBodies || c.srp ? 'fullNoDrag' : 'pointMass');
const toleranceClass = (c) => (c.drag ? 'drag' : c.srp ? 'srp' : c.degree > 0 || c.thirdBodies ? 'gravity' : 'pointMass');
const RELATIVITY = ['none', 'schwarzschild', 'iers2010'];

const cases = reference.cases.map((c) => {
  const name = `${c.orbit} ${c.forces}`;
  const [, x, y, z, vx, vy, vz] = c.samples[0];
  const epochUtc = c.epochUtc ?? reference.epochUtc;
  const forces = {
    centralBody: { gmM3S2: k.gm },
    gravityField: c.degree > 0 ? {
      model: c.gravityModel ?? 'EGM2008', degree: c.degree, order: c.order,
      ...(c.tesseralDegree !== undefined ? { tesseralDegree: c.tesseralDegree } : {}),
      radiusM: k.fieldRadiusM, tideSystem: 'TIDE_FREE', bodyFixedFrame: 'ITRF (IERS 2010)',
    } : null,
    thirdBodies: c.thirdBodies ? ['SUN', 'MOON'] : [],
    solarRadiationPressure: c.srp ? {
      shape: 'cannonball', cr: k.cr, areaM2: k.areaM2, massKg: k.massKg,
      shadow: 'conical (dual cone), umbra and penumbra', occultingBodyRadiusM: k.shadowRadiusM,
    } : null,
    drag: c.drag ? {
      atmosphere: c.atmosphere ?? 'NRLMSISE00', cd: k.cd, areaM2: k.areaM2, massKg: k.massKg,
      bodyShape: 'WGS84 ellipsoid in ITRF',
      spaceWeather: c.atmosphere === 'JB2008' ? 'jb2008' : c.spaceWeather === 'cssi' ? 'cssi' : 'constant',
      ...(c.atmosphere === 'JB2008' ? {} : { localSolarTime: 'mean (UT + longitude/15)' }),
      ...(c.dragAreaOverMassRateM2KgS ? { areaOverMassRateM2KgS: c.dragAreaOverMassRateM2KgS } : {}),
    } : null,
    relativity: RELATIVITY[c.relativity ?? 0],
    solidTides: c.solidTides ? 'IERS 2010 section 6.2 (no pole tide), tidal coefficients sampled every 60 s' : null,
    oceanTides: c.oceanTidesDegree ? { model: 'FES2004', degree: c.oceanTidesDegree, order: c.oceanTidesDegree, poleTide: false } : null,
    earthRadiation: c.earthRadiation ? { model: 'Knocke (albedo + infrared)', resolutionDeg: c.earthRadiationResolutionDeg, cr: k.cr } : null,
    inTrackAccelerationMS2: c.inTrackAccelerationMS2 ?? null,
  };
  return {
    id: name, orbit: c.orbit, forceSet: c.forces, row: row(c), toleranceClass: toleranceClass(c),
    epochUtc, frame: c.frame ?? 'GCRF',
    initialState: { positionM: [x, y, z], velocityMS: [vx, vy, vz] },
    earthOrientation: epochUtc.startsWith('2026-06') ? 'eop-2026-06' : 'eop-2026-08',
    forces,
    ...(c.parameters ? { sensitivities: { stm: true, parameters: c.parameters } } : {}),
    sampleOffsetsS: c.samples.map((s) => s[0]),
    sampleEpochsUtc: c.samples.map((s) => s[7]),
    referenceTrajectories: ['orekit', ...Object.keys(existing).filter((id) => existing[id].has(name))],
    inCrossValidationSubset: xval.has(name),
  };
});

const eop = (p) => { const e = json(p); return { source: e.source, finalsSha256: e.sha256, fixture: source(p), rows: e.rows }; };
const spw = json(SPW), jb = json(JB2008);

const doc = {
  about: 'The HPOP reference cases (the Orekit 13.1 suite, tests/orekit-summary.mjs) in a tool-neutral form. Every cross-validation runner reads this file: initial states, epochs, constants, Earth orientation rows, space weather, force settings, sample epochs and integrator step settings. Generated by tests/evidence/cases/export-cases.mjs from the committed fixtures listed under sources.',
  protocol: {
    arcS: 86400, sampleStepS: 3600, samples: 25,
    score: 'largest 3D position difference over the 25 hourly samples, metres, in GCRF (EME2000 for the cases whose frame is EME2000)',
    rows: {
      pointMass: 'point mass',
      fullNoDrag: 'field, third bodies, radiation pressure, tides, relativity, thrust (no drag)',
      drag: 'any case with drag',
    },
    stepSettings: [
      { id: 'suite', maxStepS: 300, relativeTolerance: 1e-13, relativeTolerancePointMass: 1e-15, note: 'HPOP RK78; the suite request' },
      { id: 'steps30', maxStepS: 30, relativeTolerance: 1e-13, relativeTolerancePointMass: 1e-15 },
      { id: 'finest', maxStepS: 10, relativeTolerance: 1e-15, relativeTolerancePointMass: 1e-15 },
    ],
    stepSettingsForReferenceTools: 'A reference tool runs at its own converged setting (stated with its results, with the change a finer setting makes); the three settings are HPOP\'s side of the comparison. A tool that exposes step control may also be run at the same three settings.',
    sensitivities: 'Cases with sensitivities report the 6x6 STM and the parameter columns at each sample; scored as the largest relative difference of a column (position rows and velocity rows apart), as tests/lib/orekitCases.mjs scoreJacobians. Parameters are per unit Cd*A/m, Cr*A/m, the Cd*A/m rate, and the in-track acceleration.',
    tolerancesM: {
      default: { pointMass: 1e-3, gravity: 0.05, srp: 0.1, drag: 0.1 },
      gmat: { pointMass: 0.01, gravity: 0.05, srp: 0.1, drag: 1.5, dragNote: 'GMAT evaluates the atmosphere with the Sun and spacecraft in J2000 (MJ2000Eq) axes; HPOP uses the true equator of date and keeps it (owner 2026-10-09)' },
      upperBoundOtherwiseM: 0.1,
    },
  },
  timeScales: {
    epochUtc: reference.epochUtc, epochTdb: reference.epochTdb,
    integrationClock: 'TT (geocentric motion); ephemerides are read at TDB',
    leapSecondsTaiMinusUtcS: 37,
  },
  constants: {
    earthGmM3S2: k.gm, fieldRadiusM: k.fieldRadiusM, shadowBodyRadiusM: k.shadowRadiusM,
    wgs84: { equatorialRadiusM: 6378137, inverseFlattening: 298.257223563 },
    solarIrradianceAt1AuWM2: 1361, solarPressureAt1AuNm2: k.solarPressureAt1AuNm2, auM: AU_M, speedOfLightMS: 299792458,
    sunRadiusM: 695700e3,
    de440Header: DE440,
    sunGmM3S2: DE440.GMS * AU3_DAY2_TO_M3_S2,
    moonGmM3S2: DE440.GMB * AU3_DAY2_TO_M3_S2 / (1 + DE440.EMRAT),
    spacecraft: { massKg: k.massKg, areaM2: k.areaM2, cr: k.cr, cd: k.cd },
  },
  models: {
    ephemeris: { name: 'JPL DE440 (DE440s records spanning 2026 TDB)', ...source(KERNEL), axes: 'ICRF (SPICE J2000)' },
    gravityFields: {
      EGM2008: { ...source(EGM2008), note: 'fully normalized, tide-free; the coefficients HPOP embeds. tests/fixtures/orekit/make-gfc.mjs writes them as ICGEM .gfc, tests/fixtures/xval/egm2008-cof.mjs as GMAT .cof' },
      EGM96: { ...source(EGM96), note: 'fully normalized; the coefficients HPOP embeds (make-gfc.mjs ... egm96)' },
    },
    oceanTides: { FES2004: source(FES2004) },
    earthOrientation: 'IERS 2010 conventions, IAU 2006/2000A CIO-based GCRS to ITRS, with the daily IERS finals2000A rows below; the Orekit reference adds the IERS 2010 sub-daily tidal and libration corrections to polar motion and UT1 (getITRF(IERS_2010, false)); a simple-EOP Orekit run without them is scored in tests/evidence/orekit/summary-simple-eop.json',
  },
  earthOrientation: { 'eop-2026-08': eop(EOP_AUG), 'eop-2026-06': eop(EOP_JUN) },
  spaceWeather: {
    constant: { f107: k.f107, f107a: k.f107a, ap: k.ap, kp: 3, note: 'every daily and 3-hourly Ap 15 (Kp 3o)' },
    cssi: { source: spw.source, fixture: source(SPW), rows: spw.rows },
    jb2008: { source: jb.source, fixture: source(JB2008), rows: jb.rows },
  },
  sources: {
    orekitReference: { ...source(REFERENCE), generator: 'propagator/hpop/tests/fixtures/orekit/OrekitReference.java', tool: reference.source },
    crossValidationSubset: source(XVAL),
    existingReferences: Object.fromEntries(Object.entries(EXISTING).map(([id, p]) => [id, { ...source(p), tool: json(p).source }])),
  },
  cases,
};

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(doc, null, 1)}\n`);
console.log(`${cases.length} cases -> ${rel(out)}`);

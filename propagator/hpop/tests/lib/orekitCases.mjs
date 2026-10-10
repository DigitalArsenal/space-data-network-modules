// The Orekit reference cases (tests/fixtures/orekit/orekit-reference.json) as
// HPOP execution requests, and how a response is scored against them.
// Representation only: encoding, decoding and differences of positions.
import fs from 'node:fs';
import * as flatbuffers from 'flatbuffers';
import { decodePrw, decodeResult, encodePrw, execution, makeTable, nativeInput, sds, TYPE } from './prwCodec.mjs';

export const REFERENCE = JSON.parse(fs.readFileSync(new URL('../fixtures/orekit/orekit-reference.json', import.meta.url), 'utf8'));
export const EOP = JSON.parse(fs.readFileSync(new URL('../fixtures/orekit/eop-2026-08.json', import.meta.url), 'utf8'));
// The JB2008 cases start on 2026-06-10 (the synthetic indices end on 2026-06-30): their Earth orientation and drivers.
export const EOP_JUNE = JSON.parse(fs.readFileSync(new URL('../fixtures/orekit/eop-2026-06.json', import.meta.url), 'utf8'));
export const JB2008 = JSON.parse(fs.readFileSync(new URL('../fixtures/orekit/jb2008-2026-06.json', import.meta.url), 'utf8'));
export const SPW = JSON.parse(fs.readFileSync(new URL('../fixtures/orekit/spw-2026-08.json', import.meta.url), 'utf8'));
const KERNEL = fs.readFileSync(new URL('../../../../files/orbit-products/tests/fixtures/de440/de440-2026.bsp', import.meta.url));

// Tolerances on the largest 3D position difference over the 24 h arc. The
// rationale for each, and the agreement measured, are in
// tests/orekit_reference.test.mjs.
export const TOLERANCE_M = { pointMass: 1e-3, gravity: 0.05, srp: 0.1, drag: 0.1 };
export const toleranceFor = (c) => (c.drag ? TOLERANCE_M.drag : c.srp ? TOLERANCE_M.srp : c.degree > 0 || c.thirdBodies ? TOLERANCE_M.gravity : TOLERANCE_M.pointMass);
// HPOP's RK78 tolerance. The point-mass cases compare the integration itself
// and run at 1e-15 (at 1e-13 HPOP's own truncation is 6.5 mm a day in LEO).
// Every other case runs at 1e-13. Radiation pressure has a kink at every
// penumbra boundary; HPOP's adaptive steps end on those boundaries
// (lib/shadow_events.h), so these cases need no tighter tolerance and no
// shorter steps (before the boundaries were located they needed 1e-14).
export const integratorTolerance = (c) => (c.degree > 0 || c.thirdBodies || c.srp || c.drag ? 1e-13 : 1e-15);

export const isoUtc = (iso) => makeTable('TIMInstant', { TIME_SYSTEM: sds.timingStandard.UTC, EPOCH_FORMAT: sds.timEpochRepresentation.ISO8601, ISO8601: iso });
const needsKernel = (c) => c.thirdBodies || c.srp;

// Earth orientation rows for the arc, from the same IERS file Orekit read,
// as PRW.EARTH_ORIENTATION. The fixture keeps them as a size-prefixed $EOP
// stream (make-eop.mjs); this only re-frames the records.
const eopRows = (fixture = EOP) => {
  const bytes = Buffer.from(fixture.payloadBase64, 'base64'), rows = [];
  for (let at = 0; at < bytes.length;) {
    const n = bytes.readUInt32LE(at);
    rows.push(sds.EOP.getSizePrefixedRootAsEOP(new flatbuffers.ByteBuffer(new Uint8Array(bytes.subarray(at, at + 4 + n)))).unpack());
    at += 4 + n;
  }
  return rows;
};
export function eopInput(c) {
  const fixture = c?.epochUtc?.startsWith('2026-06') ? EOP_JUNE : EOP;
  return { portId: 'earth_orientation', typeRef: TYPE, payload: encodePrw('EARTH_ORIENTATION', makeTable('PRWEarthOrientation', { ROWS: eopRows(fixture) })) };
}

// The synthetic JB2008 drivers Orekit read (make-jb2008.mjs), as PRW.JB2008_INDICES.
export function jb2008Input() {
  return { portId: 'jb2008_indices', typeRef: TYPE, payload: encodePrw('JB2008_INDICES', makeTable('PRWJB2008IndicesTable', { ROWS: JB2008.rows.map((row) => makeTable('PRWJB2008Indices', row)) })) };
}

// The synthetic daily space weather Orekit read (make-spw.mjs), as PRW.SPACE_WEATHER.
export function spaceWeatherInput() {
  return { portId: 'space_weather', typeRef: TYPE, payload: encodePrw('SPACE_WEATHER', makeTable('PRWSpaceWeatherTable', { ROWS: SPW.rows.map((row) => makeTable('SPW', row)) })) };
}

// `edit(exec)` may change the request before it is encoded (tests).
export function requestInputs(c, { tolerance = integratorTolerance(c), maxStep = 300, technique = 'ANALYTIC', edit } = {}) {
  const [, x, y, z, vx, vy, vz] = c.samples[0];
  const k = REFERENCE.constants;
  const forces = {
    mu: k.gm / 1e9, pointMass: true, j2: false, j3: false, j4: false, higherZonals: false,
    thirdBody: c.thirdBodies, sun: c.thirdBodies, moon: c.thirdBodies, srp: c.srp, drag: c.drag,
    massKg: k.massKg, areaM2: k.areaM2, cr: k.cr, cd: k.cd, dragModel: 'NRLMSISE00',
    gravityMode: c.degree > 0 ? (c.gravityModel === 'EGM96' ? 'EGM96' : 'SPHERICAL_HARMONICS') : 'POINT_MASS',
    ...(c.degree > 0 ? { maxDegree: c.degree, maxOrder: c.order } : {}),
  };
  const exec = execution({
    epochJD: 2461254.5, targetJD: 2461255.5, position: [x / 1000, y / 1000, z / 1000], velocity: [vx / 1000, vy / 1000, vz / 1000],
    massKg: k.massKg, integrator: { method: 'RK78', tolerance, initialStep: 30, minStep: 1e-3, maxStep, maxSteps: 1000000 },
    forces, weather: c.drag ? { epochUTCJD: 2461254.5, F107: k.f107, F107a: k.f107a, Ap: k.ap, Kp: 3 } : undefined,
    ephemerisSource: needsKernel(c) ? 'JPL_SPK' : 'Analytical',
    frame: c.frame ?? 'GCRF',
  }, needsKernel(c));
  // Exact ISO epochs on UTC, as Orekit wrote them; both sides integrate on TT.
  exec.INITIAL.STATE.EPOCH = c.epochUtc ?? REFERENCE.epochUtc;
  exec.INITIAL.STATE.EPOCH_TIME_SYSTEM = 'UTC';
  exec.INITIAL.STATE.POSITION = makeTable('FRMVector3', { X: x, Y: y, Z: z });
  exec.INITIAL.STATE.VELOCITY = makeTable('FRMVector3', { X: vx, Y: vy, Z: vz });
  const epochs = c.samples.slice(1).map((s) => s[7]);
  exec.SAMPLE_EPOCHS = epochs.map(isoUtc);
  exec.TARGET_EPOCH = isoUtc(epochs.at(-1));
  // Forces added with PRW SDS 1.240.0.
  if (c.relativity) exec.FORCES.RELATIVITY = [sds.prwRelativityTerms.NONE, sds.prwRelativityTerms.SCHWARZSCHILD, sds.prwRelativityTerms.IERS_2010][c.relativity];
  if (c.solidTides) exec.FORCES.SOLID_TIDES = sds.prwSolidTideModel.IERS_2010;
  if (c.inTrackAccelerationMS2) Object.assign(exec.FORCES, { IN_TRACK_ACCELERATION_M_S2: c.inTrackAccelerationMS2, HAS_IN_TRACK_ACCELERATION_M_S2: true });
  if (c.dragAreaOverMassRateM2KgS) Object.assign(exec.FORCES, { DRAG_AREA_OVER_MASS_RATE_M2_KG_S: c.dragAreaOverMassRateM2KgS, HAS_DRAG_AREA_OVER_MASS_RATE_M2_KG_S: true });
  if (c.spaceWeather === 'cssi') exec.FORCES.WEATHER = null;
  if (c.atmosphere === 'JB2008') Object.assign(exec.FORCES, { ATMOSPHERE_MODEL: sds.prwAtmosphereFamily.JB2008, WEATHER: null });
  if (c.tesseralDegree !== undefined) Object.assign(exec.FORCES, { MAXIMUM_TESSERAL_DEGREE: c.tesseralDegree, HAS_MAXIMUM_TESSERAL_DEGREE: true });
  // Forces added with PRW SDS 1.243.0: Knocke Earth radiation on the
  // cannonball's Cr*A/m, FES2004 ocean tides.
  if (c.earthRadiation) Object.assign(exec.FORCES, { EARTH_RADIATION: sds.prwEarthRadiationModel.KNOCKE, EARTH_RADIATION_RESOLUTION_DEG: c.earthRadiationResolutionDeg });
  if (c.oceanTidesDegree) Object.assign(exec.FORCES, { OCEAN_TIDES: sds.prwOceanTideModel.FES2004, OCEAN_TIDE_MAXIMUM_DEGREE: c.oceanTidesDegree, OCEAN_TIDE_MAXIMUM_ORDER: c.oceanTidesDegree });
  // Jacobian cases: the STM with the VCM parameters appended, analytic, with
  // the density gradient (Orekit differentiates the density too).
  if (c.parameters) Object.assign(exec, {
    INCLUDE_STM: true, STM_TECHNIQUE: sds.prwDerivativeTechnique[technique], DENSITY_TREATMENT: sds.prwDensityTreatment.FINITE_DIFFERENCE,
    DYNAMIC_PARAMETERS: c.parameters.map((name) => sds.prwDynamicParameter[name]),
  });
  if (edit) edit(exec);
  const inputs = [{ portId: 'request', typeRef: TYPE, payload: encodePrw('EXECUTION_REQUEST', exec) }];
  if (needsKernel(c)) inputs.push({ portId: 'kernel', typeRef: TYPE, payload: nativeInput(KERNEL) });
  // Every Earth-fixed field gets the EOP, so its pole matches Orekit's ITRF.
  if (c.degree > 0 || c.drag) inputs.push(eopInput(c));
  if (c.spaceWeather === 'cssi') inputs.push(spaceWeatherInput());
  if (c.atmosphere === 'JB2008') inputs.push(jb2008Input());
  return inputs;
}

// {worst, worstAt} over the samples of a decoded response.
export function score(c, response) {
  const result = decodeResult(response);
  let worst = 0, worstAt = 0;
  result.samples.forEach((s, i) => {
    const [time, x, y, z] = c.samples[i + 1];
    const d = Math.hypot(s.position[0] * 1000 - x, s.position[1] * 1000 - y, s.position[2] * 1000 - z);
    if (d > worst) { worst = d; worstAt = time; }
  });
  return { worst, worstAt };
}

// Jacobian cases: the largest relative difference of a column of the STM
// (position and velocity rows apart) and of each parameter column, over the
// samples, from the raw SI matrices (n = 6 + parameters).
export function scoreJacobians(c, response) {
  const root = decodePrw(response.outputs.find((o) => o.portId === 'response').payload).EXECUTION_RESULT;
  const np = c.parameters.length, n = 6 + np;
  const rel = (a, b) => { const d = Math.hypot(...a.map((x, i) => x - b[i])), r = Math.hypot(...b); return r > 0 ? d / r : d; };
  let stm = 0; const parameters = Object.fromEntries(c.parameters.map((p) => [p, 0]));
  root.SAMPLES.forEach((sample, k) => {
    const m = sample.STM.VALUES, ref = c.stm[k + 1], jac = c.parameterJacobian[k + 1];
    if (sample.STM.DIMENSION !== n) throw new Error(`STM dimension ${sample.STM.DIMENSION}, expected ${n}`);
    for (let j = 0; j < 6; ++j) for (const rows of [[0, 1, 2], [3, 4, 5]])
      stm = Math.max(stm, rel(rows.map((i) => m[i * n + j]), rows.map((i) => ref[i * 6 + j])));
    c.parameters.forEach((p, q) => {
      for (const rows of [[0, 1, 2], [3, 4, 5]])
        parameters[p] = Math.max(parameters[p], rel(rows.map((i) => m[i * n + 6 + q]), rows.map((i) => jac[i * np + q])));
    });
  });
  return { stm, parameters };
}


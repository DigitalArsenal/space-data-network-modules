// The Orekit reference cases (tests/fixtures/orekit/orekit-reference.json) as
// HPOP execution requests, and how a response is scored against them.
// Representation only: encoding, decoding and differences of positions.
import fs from 'node:fs';
import { decodeResult, encodePrw, execution, makeTable, nativeInput, sds, TYPE } from './prwCodec.mjs';

export const REFERENCE = JSON.parse(fs.readFileSync(new URL('../fixtures/orekit/orekit-reference.json', import.meta.url), 'utf8'));
export const EOP = JSON.parse(fs.readFileSync(new URL('../fixtures/orekit/eop-2026-08.json', import.meta.url), 'utf8'));
const KERNEL = fs.readFileSync(new URL('../../../../files/orbit-products/tests/fixtures/de440/de440-2026.bsp', import.meta.url));

// Tolerances on the largest 3D position difference over the 24 h arc. The
// rationale for each, and the agreement measured, are in
// tests/orekit_reference.test.mjs.
export const TOLERANCE_M = { pointMass: 1e-3, gravity: 0.05, srp: 0.1, drag: 0.1 };
export const toleranceFor = (c) => (c.drag ? TOLERANCE_M.drag : c.srp ? TOLERANCE_M.srp : c.degree > 0 || c.thirdBodies ? TOLERANCE_M.gravity : TOLERANCE_M.pointMass);
// HPOP's RK78 tolerance. The point-mass cases compare the integration itself
// and run at 1e-15 (at 1e-13 HPOP's own truncation is 6.5 mm a day in LEO).
// Radiation pressure has a kink at every penumbra boundary, which HPOP's
// steps cross without locating it; at 1e-13 that leaves up to ~8 cm a day in
// LEO that moves with any rounding change, at 1e-14 up to ~3 cm. Those cases
// run at 1e-14, the field and third-body cases at 1e-13.
export const integratorTolerance = (c) => (c.srp || c.drag ? 1e-14 : c.degree > 0 || c.thirdBodies ? 1e-13 : 1e-15);

const isoUtc = (iso) => makeTable('TIMInstant', { TIME_SYSTEM: sds.timingStandard.UTC, EPOCH_FORMAT: sds.timEpochRepresentation.ISO8601, ISO8601: iso });
const needsKernel = (c) => c.thirdBodies || c.srp;

// Earth orientation rows for the arc, from the same IERS file Orekit read.
export function eopInput() {
  return { portId: 'earth_orientation', typeRef: { schemaName: 'EOP.fbs', fileIdentifier: '$EOP', rootTypeName: 'EOP' }, payload: Buffer.from(EOP.payloadBase64, 'base64') };
}

export function requestInputs(c, { tolerance = integratorTolerance(c), maxStep = 300 } = {}) {
  const [, x, y, z, vx, vy, vz] = c.samples[0];
  const k = REFERENCE.constants;
  const forces = {
    mu: k.gm / 1e9, pointMass: true, j2: false, j3: false, j4: false, higherZonals: false,
    thirdBody: c.thirdBodies, sun: c.thirdBodies, moon: c.thirdBodies, srp: c.srp, drag: c.drag,
    massKg: k.massKg, areaM2: k.areaM2, cr: k.cr, cd: k.cd, dragModel: 'NRLMSISE00',
    gravityMode: c.degree > 0 ? 'SPHERICAL_HARMONICS' : 'POINT_MASS',
    ...(c.degree > 0 ? { maxDegree: c.degree, maxOrder: c.order } : {}),
  };
  const exec = execution({
    epochJD: 2461254.5, targetJD: 2461255.5, position: [x / 1000, y / 1000, z / 1000], velocity: [vx / 1000, vy / 1000, vz / 1000],
    massKg: k.massKg, integrator: { method: 'RK78', tolerance, initialStep: 30, minStep: 1e-3, maxStep, maxSteps: 1000000 },
    forces, weather: c.drag ? { epochUTCJD: 2461254.5, F107: k.f107, F107a: k.f107a, Ap: k.ap, Kp: 3 } : undefined,
    ephemerisSource: needsKernel(c) ? 'JPL_SPK' : 'Analytical',
  }, needsKernel(c));
  // Exact ISO epochs on UTC, as Orekit wrote them; both sides integrate on TT.
  exec.INITIAL.STATE.EPOCH = REFERENCE.epochUtc;
  exec.INITIAL.STATE.EPOCH_TIME_SYSTEM = 'UTC';
  exec.INITIAL.STATE.POSITION = makeTable('FRMVector3', { X: x, Y: y, Z: z });
  exec.INITIAL.STATE.VELOCITY = makeTable('FRMVector3', { X: vx, Y: vy, Z: vz });
  const epochs = c.samples.slice(1).map((s) => s[7]);
  exec.SAMPLE_EPOCHS = epochs.map(isoUtc);
  exec.TARGET_EPOCH = isoUtc(epochs.at(-1));
  const inputs = [{ portId: 'request', typeRef: TYPE, payload: encodePrw('EXECUTION_REQUEST', exec) }];
  if (needsKernel(c)) inputs.push({ portId: 'kernel', typeRef: TYPE, payload: nativeInput(KERNEL) });
  // Every Earth-fixed field gets the EOP, so its pole matches Orekit's ITRF.
  if (c.degree > 0 || c.drag) inputs.push(eopInput());
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

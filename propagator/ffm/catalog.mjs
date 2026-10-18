// A resident catalog under the full force model, as PRW records: the
// configuration (one EXECUTION_REQUEST), resident states with their
// coefficients, and the JPL kernel. Encoding only; the propagation is the
// module's.
//
// The force model is the orbit-determination fits' set: EGM2008 70x70 with
// EGM2008's TT-compatible GM; the Sun, the Moon, Venus, Mars and Jupiter from
// the JPL kernel; cannonball radiation pressure with the conical shadow;
// Knocke Earth radiation (15 degree elements); NRLMSISE-00 drag on daily
// space weather; IERS 2010 solid tides, FES2004 ocean tides 30x30 and IERS
// 2010 relativity. Coefficients ride on unit area and mass:
// DRAG_COEFFICIENT carries Cd*A/m and REFLECTIVITY_COEFFICIENT Cr*A/m (m^2/kg).
//
// Element sets: Cd*A/m from SGP4's drag term B*, computed by the module
// (plugin_drag_area_over_mass_from_bstar: B = 2 B* / rho0, Spacetrack Report
// No. 3). Two stated assumptions, the fits' a priori values: a B* of zero or
// below carries no drag information, and such an object takes 0.01 m^2/kg;
// Cr*A/m is 0.02 m^2/kg for every object.
import { createHash } from 'node:crypto';
import * as flatbuffers from 'flatbuffers';
import * as P from 'spacedatastandards.org/lib/js/PRW/main.js';

if (!('EARTH_RADIATION' in new P.PRWForceConfigurationT()) || !('OCEAN_TIDES' in new P.PRWForceConfigurationT()))
  throw new Error('propagator/ffm catalog records need spacedatastandards.org 1.243.0 or later (npm ci in propagator/ffm).');

export const TYPE = Object.freeze({ schemaName: 'PRW.fbs', fileIdentifier: '$PRW', rootTypeName: 'PRW', wireFormat: 'flatbuffer' });
export const GM = 3.986004415e14;                 // m^3/s^2, EGM2008, TT-compatible
export const DEFAULT_DRAG_AREA_OVER_MASS = 0.01;  // m^2/kg
export const DEFAULT_SRP_AREA_OVER_MASS = 0.02;   // m^2/kg
// Automatic resident GJ8/Sundman policy; RK is its startup and physical handoff core.
export const CATALOG_INTEGRATOR = Object.freeze({ tolerance: 1e-14, initialStep: 30, minStep: 0.01, maxStep: 120, maxSteps: 1000000 });

const table = (name, fields = {}) => Object.assign(new P[`${name}T`](), fields);
const vector = (v) => table('FRMVector3', { X: v[0], Y: v[1], Z: v[2] });
export const gcrf = () => table('RFMCoordinateSystem', {
  NAME: 'GCRF', AXIS_TYPE: P.rfmAxisType.ICRF, AXIS_REFERENCE_BODY_ID: 399,
  ORIGIN: table('RFMOrigin', { KIND: P.rfmOriginKind.CELESTIAL_BODY, CELESTIAL_BODY_ID: 399 }),
});
export const instant = (iso, scale = 'UTC') => table('TIMInstant', {
  TIME_SYSTEM: P.timingStandard[scale], EPOCH_FORMAT: P.timEpochRepresentation.ISO8601, ISO8601: iso,
});
const stateVector = (epoch, state) => table('FRMStateVector', {
  REPRESENTATION: P.frmStateRepresentation.CARTESIAN, POSITION: vector(state.slice(0, 3)), VELOCITY: vector(state.slice(3, 6)),
  COORDINATE_SYSTEM_NAME: 'GCRF', EPOCH: epoch, EPOCH_TIME_SYSTEM: 'UTC',
});
export function encode(arm, value) {
  const b = new flatbuffers.Builder(4096);
  P.PRW.finishSizePrefixedPRWBuffer(b, table('PRW', { [arm]: value }).pack(b));
  return b.asUint8Array().slice();
}

// Cd*A/m (m^2/kg) of an element set's B* (1/earth radii), by the module:
// `exports` are an FFM instance's exports (an SDK harness's instance.exports).
export function dragAreaOverMass(exports, bstar) {
  return exports.plugin_drag_area_over_mass_from_bstar(Number(bstar), DEFAULT_DRAG_AREA_OVER_MASS);
}

// The full force execution request: GCRF state (m, m/s) at a UTC ISO epoch,
// propagated to `target` (ISO on `targetScale`; the epoch itself when absent).
export function fullForceRequest({ epoch, state, target, targetScale = 'UTC', cdAm = DEFAULT_DRAG_AREA_OVER_MASS, crAm = DEFAULT_SRP_AREA_OVER_MASS,
  integrator = CATALOG_INTEGRATOR }) {
  const it = integrator;
  return table('PRWExecutionRequest', {
    INITIAL: table('PRWResidentState', { STATE: stateVector(epoch, state), COORDINATE_SYSTEM: gcrf() }),
    TARGET_EPOCH: instant(target ?? epoch, target ? targetScale : 'UTC'),
    INTEGRATOR: table('PRWIntegratorSettings', {
      ALGORITHM: P.prwSolverAlgorithm.RK78, INITIAL_STEP_SECONDS: it.initialStep, MINIMUM_STEP_SECONDS: it.minStep,
      MAXIMUM_STEP_SECONDS: it.maxStep, ABSOLUTE_TOLERANCES: Array(6).fill(it.tolerance * 1000), RELATIVE_TOLERANCE: it.tolerance,
      MAXIMUM_STEPS: it.maxSteps,
    }),
    FORCES: table('PRWForceConfiguration', {
      GRAVITY_CHOICE: P.prwGravitySelection.EGM2008, ENABLE_POINT_MASS: true, GRAVITATIONAL_PARAMETER: GM,
      ENABLE_J2: false, MAXIMUM_DEGREE: 70, HAS_MAXIMUM_DEGREE: true, MAXIMUM_ORDER: 70, HAS_MAXIMUM_ORDER: true,
      ENABLE_THIRD_BODY: true, THIRD_BODY_IDS: [10, 301, 2, 4, 5],
      ENABLE_SRP: true, RADIATION_PRESSURE_MODEL: P.prwRadiationPressureFamily.CANNONBALL,
      ENABLE_DRAG: true, ATMOSPHERE_MODEL: P.prwAtmosphereFamily.NRLMSISE00,
      INITIAL_MASS_KG: 1, AREA_M2: 1, DRAG_COEFFICIENT: cdAm, REFLECTIVITY_COEFFICIENT: crAm,
      EPHEMERIS_SOURCE: 'JPL_SPK',
      SOLID_TIDES: P.prwSolidTideModel.IERS_2010, RELATIVITY: P.prwRelativityTerms.IERS_2010,
      EARTH_RADIATION: P.prwEarthRadiationModel.KNOCKE, EARTH_RADIATION_RESOLUTION_DEG: 15,
      OCEAN_TIDES: P.prwOceanTideModel.FES2004, OCEAN_TIDE_MAXIMUM_DEGREE: 30, OCEAN_TIDE_MAXIMUM_ORDER: 30,
    }),
    // The resident covariance: analytic STM with the density gradient.
    STM_TECHNIQUE: P.prwDerivativeTechnique.ANALYTIC,
    DENSITY_TREATMENT: P.prwDensityTreatment.FINITE_DIFFERENCE,
  });
}

// One resident state: GCRF (m, m/s) at a UTC ISO epoch, its Cd*A/m and Cr*A/m,
// optionally a 6x6 SI covariance (row-major) and its PRWProcessNoiseT.
export function residentState({ instanceId, generation = 1n, handle, catalogNumber = 0, objectId = '', epoch, state,
  cdAm, crAm = DEFAULT_SRP_AREA_OVER_MASS, covariance, processNoise, extra = {} }) {
  return table('PRWResidentState', {
    INSTANCE: table('PRWInstance', { MODULE_ID: 'com.orbpro.ffm', INSTANCE_ID: instanceId, GENERATION: BigInt(generation) }),
    ENTITY_HANDLE: handle, CATALOG_NUMBER: catalogNumber, OBJECT_ID: objectId,
    STATE: stateVector(epoch, state), COORDINATE_SYSTEM: gcrf(),
    ...(cdAm !== undefined ? { DRAG_AREA_OVER_MASS_M2_KG: cdAm, HAS_DRAG_AREA_OVER_MASS_M2_KG: true } : {}),
    ...(crAm !== undefined ? { SRP_AREA_OVER_MASS_M2_KG: crAm, HAS_SRP_AREA_OVER_MASS_M2_KG: true } : {}),
    ...(covariance ? { COVARIANCE: table('PRWStateMatrix', { DIMENSION: 6, VALUES: covariance }) } : {}),
    ...(processNoise ? { PROCESS_NOISE: processNoise } : {}),
    VALID: true,
    ...extra,
  });
}

// The kernel input: a PRW NATIVE_INPUT with the bytes' SHA-256.
export function kernelRecord(bytes) {
  return encode('NATIVE_INPUT', table('PRWNativeInput', {
    DESCRIPTOR: table('NCD', { FORMAT: P.ncdContainerFormat.SPK_DAF, SOURCE_BYTE_LENGTH: BigInt(bytes.length),
      SOURCE_SHA256: createHash('sha256').update(bytes).digest('hex') }),
    CONTENT: bytes,
  }));
}

export { P as prw };

export const MODULE_ID = 'com.orbpro.ffm';
export const INTEGRATION_POLICY = 'Forward GJ8 PEC on common TT grids: LEO 10/15/12/24 s by perigee band; near-circular GPS 75 s and GEO 600 s; other low-eccentricity elliptic orbits 24 s. Eccentricity >=0.25: RK78 Sundman alpha=1.5, 200/orbit (GTO-like: 300/orbit). Tight RK alignment <=one GJ step; corrected conical dense acceleration; daily-Ap restart trim; selected-object batches of 32. GJ hands off to two-second-capped RK within 50 km of the sphere enclosing the physical 100 km reentry surface. Fixed diagnostics, backward requests, nonelliptic states, unsupported GJ force families, or insufficient startup coverage retain RK78.';

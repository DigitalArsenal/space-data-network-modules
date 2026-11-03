// $PRW framing for propagator/ffm's `invoke` method (SDS 1.240.0 PRW
// execution request and result, Earth orientation and space weather arms).
// Encoding and unit scaling only (km <-> m); the propagation, frames and time
// scales are the module's.
import { createHash } from 'node:crypto';
import * as flatbuffers from 'flatbuffers';
import * as P from 'spacedatastandards.org/lib/js/PRW/main.js';

export const PRW_TYPE = { schemaName: 'PRW.fbs', fileIdentifier: '$PRW', rootTypeName: 'PRW', wireFormat: 'flatbuffer' };
const table = (name, fields = {}) => Object.assign(new P[`${name}T`](), fields);

function encode(arm, value) {
  const b = new flatbuffers.Builder(4096);
  P.PRW.finishSizePrefixedPRWBuffer(b, table('PRW', { [arm]: value }).pack(b));
  return b.asUint8Array().slice();
}

// An instant given as ISO 8601 text on a named time scale (UTC, TT, TDB, …).
export const instant = (iso, scale = 'UTC') => table('TIMInstant', {
  TIME_SYSTEM: P.timingStandard[scale], EPOCH_FORMAT: P.timEpochRepresentation.ISO8601, ISO8601: iso,
});

const vector = (v, scale) => table('FRMVector3', { X: v[0] * scale, Y: v[1] * scale, Z: v[2] * scale });

function gcrf() {
  return table('RFMCoordinateSystem', {
    NAME: 'GCRF', AXIS_TYPE: P.rfmAxisType.ICRF, AXIS_REFERENCE_BODY_ID: 399,
    ORIGIN: table('RFMOrigin', { KIND: P.rfmOriginKind.CELESTIAL_BODY, CELESTIAL_BODY_ID: 399 }),
  });
}

// request: {epoch (ISO), timeScale, position [km], velocity [km/s] (GCRF), samples [ISO],
//   target (ISO), integrator {algorithm, initialStep, minStep, maxStep, tolerance},
//   forces {degree, order, thirdBodies [NAIF ids], srp, drag, massKg, areaM2, cr, cd,
//     solidTides (IERS 2010), relativity ('SCHWARZSCHILD' | 'IERS_2010')}}
export function executionFrame(request) {
  const f = request.forces, it = request.integrator;
  const scale = request.timeScale ?? 'UTC';
  const initial = table('PRWResidentState', {
    STATE: table('FRMStateVector', {
      REPRESENTATION: P.frmStateRepresentation.CARTESIAN,
      POSITION: vector(request.position, 1000), VELOCITY: vector(request.velocity, 1000),
      COORDINATE_SYSTEM_NAME: 'GCRF', EPOCH: request.epoch, EPOCH_TIME_SYSTEM: scale,
    }),
    COORDINATE_SYSTEM: gcrf(),
    HAS_MASS_KG: f.massKg !== undefined, MASS_KG: f.massKg ?? 0,
  });
  const sphericalHarmonics = f.degree !== undefined;
  const forces = table('PRWForceConfiguration', {
    GRAVITY_CHOICE: sphericalHarmonics ? P.prwGravitySelection.SPHERICAL_HARMONICS : P.prwGravitySelection.POINT_MASS,
    ENABLE_POINT_MASS: true, GRAVITATIONAL_PARAMETER: 398600.4418e9,
    ENABLE_J2: false, ENABLE_J3: false, ENABLE_J4: false, ENABLE_HIGHER_ZONALS: false,
    MAXIMUM_DEGREE: f.degree ?? 0, HAS_MAXIMUM_DEGREE: sphericalHarmonics,
    MAXIMUM_ORDER: f.order ?? 0, HAS_MAXIMUM_ORDER: sphericalHarmonics,
    ENABLE_THIRD_BODY: (f.thirdBodies ?? []).length > 0, THIRD_BODY_IDS: f.thirdBodies ?? [],
    ENABLE_SRP: !!f.srp, ENABLE_DRAG: !!f.drag,
    INITIAL_MASS_KG: f.massKg ?? 1000, AREA_M2: f.areaM2 ?? 1, REFLECTIVITY_COEFFICIENT: f.cr ?? 1, DRAG_COEFFICIENT: f.cd ?? 2.2,
    ATMOSPHERE_MODEL: P.prwAtmosphereFamily.NRLMSISE00,
    EPHEMERIS_SOURCE: request.kernel ? 'JPL_SPK' : 'Analytical',
    SOLID_TIDES: f.solidTides ? P.prwSolidTideModel.IERS_2010 : P.prwSolidTideModel.NONE,
    RELATIVITY: f.relativity ? P.prwRelativityTerms[f.relativity] : P.prwRelativityTerms.NONE,
  });
  const integrator = table('PRWIntegratorSettings', {
    ALGORITHM: P.prwSolverAlgorithm[it.algorithm ?? 'RK78'],
    INITIAL_STEP_SECONDS: it.initialStep ?? 60, MINIMUM_STEP_SECONDS: it.minStep ?? 0.01, MAXIMUM_STEP_SECONDS: it.maxStep ?? 600,
    ABSOLUTE_TOLERANCES: Array(6).fill((it.tolerance ?? 1e-12) * 1000), RELATIVE_TOLERANCE: it.tolerance ?? 1e-12,
    MAXIMUM_STEPS: it.maxSteps ?? 1000000,
  });
  const execution = table('PRWExecutionRequest', {
    INITIAL: initial, TARGET_EPOCH: instant(request.target, scale), INTEGRATOR: integrator, FORCES: forces,
    INCLUDE_STM: false, STM_TECHNIQUE: P.prwDerivativeTechnique.ANALYTIC, DENSITY_TREATMENT: P.prwDensityTreatment.NEGLECTED,
    SAMPLE_EPOCHS: (request.samples ?? []).map((s) => instant(s, scale)),
  });
  return { portId: 'request', typeRef: PRW_TYPE, payload: encode('EXECUTION_REQUEST', execution) };
}

// A JPL SPK kernel on the `kernel` port.
export function kernelFrame(bytes) {
  const descriptor = table('NCD', {
    FORMAT: P.ncdContainerFormat.SPK_DAF, SOURCE_BYTE_LENGTH: BigInt(bytes.length),
    SOURCE_SHA256: createHash('sha256').update(bytes).digest('hex'),
  });
  return { portId: 'kernel', typeRef: PRW_TYPE, payload: encode('NATIVE_INPUT', table('PRWNativeInput', { DESCRIPTOR: descriptor, CONTENT: Array.from(bytes) })) };
}

// Resident catalog (propagator/ffm `ingest_state` / `propagate_state`), which
// uses the module's fixed resident force model and integrator.
// states: [{handle, norad, epoch (ISO UTC), position [km], velocity [km/s]}]
export function residentIngestFrames(instanceId, generation, states) {
  const identity = table('PRWInstance', { MODULE_ID: 'com.orbpro.ffm', INSTANCE_ID: instanceId, GENERATION: BigInt(generation) });
  return {
    identity,
    frames: states.map((s) => {
      const record = table('PRWResidentState', {
        INSTANCE: identity, ENTITY_HANDLE: s.handle, CATALOG_NUMBER: s.norad, OBJECT_ID: String(s.norad),
        STATE: table('FRMStateVector', {
          REPRESENTATION: P.frmStateRepresentation.CARTESIAN,
          POSITION: vector(s.position, 1000), VELOCITY: vector(s.velocity, 1000),
          COORDINATE_SYSTEM_NAME: 'GCRF', EPOCH: s.epoch, EPOCH_TIME_SYSTEM: 'UTC',
        }),
        COORDINATE_SYSTEM: gcrf(), VALID: true,
      });
      return { portId: 'state', typeRef: PRW_TYPE, payload: encode('RESIDENT_STATE', record) };
    }),
  };
}

export function residentRequestFrame(identity, targetIsoUtc, handles) {
  const request = table('PRWResidentRequest', { INSTANCE: identity, TARGET_EPOCH: instant(targetIsoUtc, 'UTC'), ENTITY_HANDLES: handles, MAXIMUM_COUNT: 0, TARGET_COORDINATE_SYSTEM: gcrf() });
  return { portId: 'request', typeRef: PRW_TYPE, payload: encode('RESIDENT_REQUEST', request) };
}

export function decodeResident(response) {
  const root = P.PRW.getSizePrefixedRootAsPRW(new flatbuffers.ByteBuffer(new Uint8Array(response.outputs[0].payload))).unpack();
  const r = root.RESIDENT_STATE;
  return { epoch: r.STATE.EPOCH, position: ['X', 'Y', 'Z'].map((k) => r.STATE.POSITION[k] / 1000), velocity: ['X', 'Y', 'Z'].map((k) => r.STATE.VELOCITY[k] / 1000) };
}

// The execution result's samples as {epoch, timeScale, position [km], velocity [km/s]}.
export function decodeExecution(response) {
  const frame = response.outputs.find((o) => o.portId === 'response');
  const root = P.PRW.getSizePrefixedRootAsPRW(new flatbuffers.ByteBuffer(new Uint8Array(frame.payload))).unpack();
  if (!root.EXECUTION_RESULT) throw new Error('propagator/ffm: no execution result');
  const state = (s) => ({
    epoch: s.STATE.STATE.EPOCH, timeScale: s.STATE.STATE.EPOCH_TIME_SYSTEM,
    position: ['X', 'Y', 'Z'].map((k) => s.STATE.STATE.POSITION[k] / 1000),
    velocity: ['X', 'Y', 'Z'].map((k) => s.STATE.STATE.VELOCITY[k] / 1000),
    steps: Number(s.ACCEPTED_STEPS),
  });
  return { samples: root.EXECUTION_RESULT.SAMPLES.map(state), final: state(root.EXECUTION_RESULT.FINAL_SAMPLE), ephemerisSource: root.EXECUTION_RESULT.EPHEMERIS_SOURCE };
}

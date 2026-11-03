// propagator/ffm execution requests for E2 (SDS 1.240.0 PRW): a state at a
// UTC epoch with the product's dynamic parameters, their STM columns, an
// initial covariance over state and parameters, and white-acceleration
// process noise. Encoding and decoding only; SI units throughout. The
// parameters ride on unit area and mass: Cd = B, Cr = AGOM.
import * as flatbuffers from 'flatbuffers';
import * as P from 'spacedatastandards.org/lib/js/PRW/main.js';
import { PRW_TYPE, instant } from '../../harness/prw.mjs';

const table = (name, fields = {}) => Object.assign(new P[`${name}T`](), fields);
const vector = (v) => table('FRMVector3', { X: v[0], Y: v[1], Z: v[2] });
const gcrf = () => table('RFMCoordinateSystem', {
  NAME: 'GCRF', AXIS_TYPE: P.rfmAxisType.ICRF, AXIS_REFERENCE_BODY_ID: 399,
  ORIGIN: table('RFMOrigin', { KIND: P.rfmOriginKind.CELESTIAL_BODY, CELESTIAL_BODY_ID: 399 }),
});
function encode(execution) {
  const b = new flatbuffers.Builder(1 << 16);
  P.PRW.finishSizePrefixedPRWBuffer(b, table('PRW', { EXECUTION_REQUEST: execution }).pack(b));
  return b.asUint8Array().slice();
}

// request: {epoch (ISO UTC), state [m, m/s] GCRF, samples [ISO UTC],
//   forces {degree, order, thirdBodies, srp, drag, solidTides, atmosphere},
//   parameters [{kind: 'DRAG_AREA_OVER_MASS' | 'SRP_AREA_OVER_MASS' | ..., value}],
//   fixed {b, agom} (values of the coefficients that are not solved for),
//   stm (bool), covariance [(6+p)^2] | null, noise {q [3] m^2/s^3 RTN, intervalSeconds} | null,
//   integrator {tolerance, maxStep}}
export function executionFrame(request) {
  const f = request.forces, it = request.integrator;
  const value = (kind, fallback) => request.parameters.find((p) => p.kind === kind)?.value ?? fallback;
  const n = 6 + request.parameters.length;
  const forces = table('PRWForceConfiguration', {
    GRAVITY_CHOICE: P.prwGravitySelection.SPHERICAL_HARMONICS, ENABLE_POINT_MASS: true, GRAVITATIONAL_PARAMETER: 398600.4418e9,
    ENABLE_J2: false, ENABLE_J3: false, ENABLE_J4: false, ENABLE_HIGHER_ZONALS: false,
    MAXIMUM_DEGREE: f.degree, HAS_MAXIMUM_DEGREE: true, MAXIMUM_ORDER: f.order, HAS_MAXIMUM_ORDER: true,
    ENABLE_THIRD_BODY: !!f.thirdBodies, THIRD_BODY_IDS: f.thirdBodies ? [10, 301] : [],
    ENABLE_SRP: !!f.srp, ENABLE_DRAG: !!f.drag,
    INITIAL_MASS_KG: 1, AREA_M2: 1,
    REFLECTIVITY_COEFFICIENT: value('SRP_AREA_OVER_MASS', request.fixed?.agom ?? 0),
    DRAG_COEFFICIENT: value('DRAG_AREA_OVER_MASS', request.fixed?.b ?? 0),
    ATMOSPHERE_MODEL: P.prwAtmosphereFamily[f.atmosphere ?? 'NRLMSISE00'],
    EPHEMERIS_SOURCE: 'JPL_SPK',
    SOLID_TIDES: f.solidTides ? P.prwSolidTideModel.IERS_2010 : P.prwSolidTideModel.NONE,
    RELATIVITY: P.prwRelativityTerms.NONE,
  });
  const execution = table('PRWExecutionRequest', {
    INITIAL: table('PRWResidentState', {
      STATE: table('FRMStateVector', {
        REPRESENTATION: P.frmStateRepresentation.CARTESIAN, POSITION: vector(request.state.slice(0, 3)), VELOCITY: vector(request.state.slice(3, 6)),
        COORDINATE_SYSTEM_NAME: 'GCRF', EPOCH: request.epoch, EPOCH_TIME_SYSTEM: 'UTC',
      }),
      COORDINATE_SYSTEM: gcrf(), HAS_MASS_KG: false, MASS_KG: 0,
    }),
    TARGET_EPOCH: instant(request.samples.at(-1), 'UTC'),
    INTEGRATOR: table('PRWIntegratorSettings', {
      ALGORITHM: P.prwSolverAlgorithm.RK78, INITIAL_STEP_SECONDS: 60, MINIMUM_STEP_SECONDS: 0.01, MAXIMUM_STEP_SECONDS: it.maxStep,
      ABSOLUTE_TOLERANCES: Array(6).fill(it.tolerance * 1000), RELATIVE_TOLERANCE: it.tolerance, MAXIMUM_STEPS: 1000000,
    }),
    FORCES: forces,
    INCLUDE_STM: !!request.stm, STM_TECHNIQUE: P.prwDerivativeTechnique.ANALYTIC,
    DENSITY_TREATMENT: f.drag ? P.prwDensityTreatment.FINITE_DIFFERENCE : P.prwDensityTreatment.NEGLECTED,
    DYNAMIC_PARAMETERS: request.parameters.map((p) => P.prwDynamicParameter[p.kind]),
    INITIAL_COVARIANCE: request.covariance ? table('PRWStateMatrix', { DIMENSION: n, VALUES: request.covariance }) : null,
    PROCESS_NOISE: request.noise ? table('PRWProcessNoise', {
      MODEL: P.prwProcessNoiseModel.WHITE_ACCELERATION, AXES: P.prwProcessNoiseAxes.RADIAL_TRANSVERSE_NORMAL,
      SPECTRAL_DENSITY_M2_S3: request.noise.q, DISCRETIZATION_SECONDS: request.noise.intervalSeconds,
    }) : null,
    SAMPLE_EPOCHS: request.samples.map((s) => instant(s, 'UTC')),
  });
  return { portId: 'request', typeRef: PRW_TYPE, payload: encode(execution) };
}

// The samples, in request order: {epoch, state [m, m/s], stm [n*n] | null, covariance [n*n] | null, n}.
export function decodeSamples(response) {
  const frame = response.outputs.find((o) => o.portId === 'response');
  const root = P.PRW.getSizePrefixedRootAsPRW(new flatbuffers.ByteBuffer(new Uint8Array(frame.payload))).unpack();
  if (!root.EXECUTION_RESULT) throw new Error('propagator/ffm: no execution result');
  return root.EXECUTION_RESULT.SAMPLES.map((s) => {
    const st = s.STATE.STATE;
    return {
      epoch: st.EPOCH,
      state: [st.POSITION.X, st.POSITION.Y, st.POSITION.Z, st.VELOCITY.X, st.VELOCITY.Y, st.VELOCITY.Z],
      n: s.STM?.DIMENSION ?? s.COVARIANCE?.DIMENSION ?? 6,
      stm: s.STM ? s.STM.VALUES : null,
      covariance: s.COVARIANCE ? s.COVARIANCE.VALUES : null,
    };
  });
}

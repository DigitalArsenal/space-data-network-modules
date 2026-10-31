// End to end: fit_batch converges at the cost's resolution. A fit whose
// observations are finer than the propagator's own numerical noise ends
// CONVERGED, not STALLED or MAXIMUM_ITERATIONS.
//
//   node analysis/estimation/tests/fit-batch-noise-floor.e2e.mjs   (any cwd)
//
// The noise: propagator/ffm's RK78 takes discrete step decisions, so seeds one
// ulp apart part by tenths of a millimeter at some instant of the arc, and
// the gap grows along-track. Each fit_batch trial is one propagation, so
// below some size a trial's cost change is that noise, not its step.
//
// The case, all from committed fixtures:
// - Truth: the LEO400-drag state of the Orekit batch reference
//   (fixtures/orekit-batch-reference.json), 2026-08-02 00:00 UTC, with
//   B = Cd A/m = 0.044 m^2/kg and AGOM = Cr A/m = 0.026 m^2/kg.
// - Forces: propagator/ffm with EGM2008 70 x 70, the Sun and Moon from the
//   DE440 2026 excerpt, cannonball radiation pressure with the conical
//   shadow, NRLMSISE-00 drag at constant weather (F10.7 150, Ap 15), IERS
//   2010 solid tides and relativity, the 2026-08 Earth orientation.
// - Truth arc: propagated at 1e-13 relative (1e-10 m absolute), steps up to
//   120 s, 576 positions at 300 s over 48 h.
// - The fit: the state, B and AGOM by fit_batch. Each round is answered by
//   propagator/ffm with the 8 x 8 STM at 1e-10 relative (1e-7 m absolute),
//   steps up to 120 s, the density gradient by finite difference.
// - Settings: 5 cm sigma, tolerance 0.01, edit at 5 sigma, at most 40
//   rounds, a priori 100 km, 10 m/s and 30 % of each seed.
// - Seed: 116 m, 6 cm/s, -20 % B and +25 % AGOM from the truth.
// At a 5 cm sigma the two integrations differ by about one sigma (reduced
// chi-square 1.04, the misfit of the fits XM2 lost), and the fit sits at the
// RK78 decision noise.
//
// Measured, same inputs, propagator/ffm 2.0.4:
// - analysis/estimation 0.6.0: STALLED after 23 rounds (18 rejected trials).
// - 0.7.0: CONVERGED in 16 rounds (11 rejected trials), about 65 s, each
//   round about 4 s.
//
// Pass:
// - status OK, termination CONVERGED, in at most 20 rounds;
// - at least one rejected trial (the fit reached the noise floor);
// - B within 1e-4 and AGOM within 1e-3 of the truth, relative.
import assert from 'node:assert/strict';
import { REFERENCE as BATCH, harness } from './batch-fit-fixtures.mjs';
import { api, encode, pack, typeRef, unpack } from './wire.mjs';
import { REFERENCE as FFM_REFERENCE, requestInputs } from '../../../propagator/ffm/tests/lib/orekitCases.mjs';
import { decodePrw, sds } from '../../../propagator/ffm/tests/lib/prwCodec.mjs';
import { fitParameterBounds } from '../../../propagator/ffm/catalog-configuration.mjs';

const EPOCH_JD = 2461254.5;  // 2026-08-02T00:00:00 UTC, the configuration epoch
const STEP_S = 300, HOURS = 48, SIGMA_M = 0.05, MAXIMUM_ROUNDS = 20;
const TERMINATION = { CONVERGED: 0, MAXIMUM_ITERATIONS: 1, STALLED: 2 };
const KINDS = ['DRAG_AREA_OVER_MASS', 'SRP_AREA_OVER_MASS'];
const FORCES = { degree: 70, order: 70, thirdBodies: true, srp: true, drag: true, solidTides: true, relativity: 2 };
const K = FFM_REFERENCE.constants;
const TIMES = Array.from({ length: (HOURS * 3600) / STEP_S }, (_, i) => (i + 1) * STEP_S);
const isoAt = (seconds) => new Date(Date.UTC(2026, 7, 2) + seconds * 1000).toISOString().replace('Z', '');

// One propagator/ffm run from a state and [B, AGOM] to every observation
// epoch; with the STM (and the parameter columns) when `stm`.
async function propagate(ffm, state, [b, agom], tolerance, stm) {
  const c = { ...FORCES, ...(stm ? { parameters: KINDS } : {}), samples: [[0, ...state], ...TIMES.map((t) => [t, 0, 0, 0, 0, 0, 0, isoAt(t)])] };
  const inputs = requestInputs(c, { tolerance, maxStep: 120, edit: (exec) => {
    exec.FORCES.DRAG_COEFFICIENT = (b * K.massKg) / K.areaM2;
    exec.FORCES.REFLECTIVITY_COEFFICIENT = (agom * K.massKg) / K.areaM2;
    exec.INTEGRATOR.INITIAL_STEP_SECONDS = 60;
    exec.INTEGRATOR.MINIMUM_STEP_SECONDS = 1e-4;
  } });
  const response = await ffm.invoke({ methodId: 'invoke', inputs });
  assert.equal(response.statusCode, 0, `propagator/ffm: ${response.errorCode}: ${response.errorMessage}`);
  const samples = decodePrw(response.outputs.find((o) => o.portId === 'response').payload).EXECUTION_RESULT.SAMPLES;
  assert.equal(samples.length, TIMES.length);
  return samples;
}

function request(truthPositions, seed, seedParameters) {
  const zero3 = [0, 0, 0];
  const envelope = unpack(encode({ request: {
    config: { initial_epoch: { jd_day: EPOCH_JD, seconds: 0 }, initial_state: [0, 0, 0, 0, 0, 0], initial_covariance: Array(36).fill(0),
      process_noise_spectral_density: Array(6).fill(0), state_convergence_tolerance: 0, rms_convergence_tolerance: 0, sigma_edit_threshold: 0,
      dynamic_model_correlation_time_seconds: 0, maximum_iterations: 0, reference_frame: 'ICRF', estimator: 'BATCH_WEIGHTED_LEAST_SQUARES', process_noise: 'NONE', flags: 0 },
    observations: TIMES.map((t) => ({ epoch: { jd_day: EPOCH_JD, seconds: t }, value: [0, 0, 0, 0], sigma: [1, 1, 1, 0],
      station_position_m: zero3, station_velocity_mps: zero3, station_east: zero3, station_north: zero3, station_up: zero3, remote_position_m: zero3,
      remote_velocity_mps: zero3, frequency_hz: 0, transmitter_delay_seconds: 0, receiver_delay_seconds: 0, transponder_delay_seconds: 0, elevation_rad: 0,
      station_latitude_rad: 0, station_height_m: 0, pressure_hpa: 0, temperature_k: 0, relative_humidity: 0, wavelength_m: 0, total_electron_content: 0,
      total_electron_content_rate_per_second: 0, turnaround_numerator: 1, turnaround_denominator: 1, kind: 'POSITION_VECTOR', value_count: 3, flags: 3,
      transmitter_index: 0, receiver_index: 0 })),
    propagator_port_id: 'propagator/ffm', propagator_capability: 'plugin_propagate plugin_compute_stm', trace_id: 'fit-batch-noise-floor',
    batch_options: { parameter_kinds: KINDS.map((k) => sds.prwDynamicParameter[k]), parameter_values: [0, 0], maximum_iterations: 40,
      correction_tolerance: 0.01, sigma_edit_threshold: 5 },
  } }));
  // Exact doubles: set through the object API, not JSON text.
  const r = envelope.request;
  r.config.initialState = seed;
  r.batchOptions.parameterValues = seedParameters;
  r.observations.forEach((o, i) => { o.value = [...truthPositions[i], 0]; o.sigma = [SIGMA_M, SIGMA_M, SIGMA_M, 0]; });
  const variances = [1e10, 1e10, 1e10, 100, 100, 100, (0.3 * seedParameters[0]) ** 2, (0.3 * seedParameters[1]) ** 2];
  r.batchOptions.aprioriCovariance = Array.from({ length: 64 }, (_, j) => (Math.floor(j / 8) === j % 8 ? variances[j % 8] : 0));
  const { lower, upper } = fitParameterBounds(KINDS);
  Object.assign(r.batchOptions, { parameterLowerBounds: lower, parameterUpperBounds: upper });
  return envelope;
}

async function main() {
  const started = Date.now();
  const estimator = await harness('../');
  const ffm = await harness('../../../propagator/ffm/');
  try {
    const leo = BATCH.cases.find((c) => c.name === 'LEO400-drag');
    const truthParameters = [(K.cd * K.areaM2) / K.massKg, (K.cr * K.areaM2) / K.massKg];
    const truth = (await propagate(ffm, leo.truth, truthParameters, 1e-13, false)).map(({ STATE: { STATE: { POSITION: p } } }) => [p.X, p.Y, p.Z]);
    const seed = leo.truth.map((v, i) => v + [100, -50, 30, 0.05, -0.03, 0.02][i]);
    const envelope = request(truth, seed, [truthParameters[0] * 0.8, truthParameters[1] * 1.25]);
    const A = api();
    let rounds = 0, result;
    for (;;) {
      const response = await estimator.invoke({ methodId: 'fit_batch', inputs: [{ portId: 'request', typeRef, payload: pack(envelope) }] });
      assert.equal(response.statusCode, 0, `fit_batch: ${response.errorCode}: ${response.errorMessage}`);
      result = unpack(response.outputs.find((o) => o.portId === 'result').payload).result;
      if (result.status !== 1) break;
      const queries = result.propagationRequests;
      const samples = await propagate(ffm, queries[0].seed.state, queries[0].parameterValues, 1e-10, true);
      rounds += 1;
      envelope.propagationAnswers.push(...queries.map((query, k) => {
        const s = samples[k], m = s.STM.VALUES, n = s.STM.DIMENSION, stm = [], sensitivity = [];
        for (let i = 0; i < 6; ++i) {
          for (let j = 0; j < 6; ++j) stm.push(m[i * n + j]);
          for (let j = 6; j < n; ++j) sensitivity.push(m[i * n + j]);
        }
        const p = s.STATE.STATE.POSITION, v = s.STATE.STATE.VELOCITY;
        return Object.assign(new A.PropagationAnswerT(), {
          query, sensitivity,
          sample: Object.assign(new A.EstimationPropagatorSampleT(), { epoch: query.targetEpoch, state: [p.X, p.Y, p.Z, v.X, v.Y, v.Z], stm }),
        });
      }));
    }
    const b = result.batchFit;
    const relB = Math.abs(b.estimate[6] - truthParameters[0]) / truthParameters[0];
    const relAgom = Math.abs(b.estimate[7] - truthParameters[1]) / truthParameters[1];
    const name = Object.keys(TERMINATION).find((key) => TERMINATION[key] === b.termination) ?? String(b.termination);
    console.log(`fit-batch noise floor: ${name} in ${rounds} rounds (${b.rejectedTrials} rejected trials), reduced chi-square ${b.reducedChiSquare.toFixed(3)}, ` +
      `B ${relB.toExponential(2)} and AGOM ${relAgom.toExponential(2)} from the truth (relative), ${((Date.now() - started) / 1000).toFixed(1)} s`);
    assert.equal(result.status, 0, `status ${result.status} (${name})`);
    assert.equal(b.termination, TERMINATION.CONVERGED, `termination ${name}`);
    assert.ok(rounds <= MAXIMUM_ROUNDS, `${rounds} rounds, more than ${MAXIMUM_ROUNDS}`);
    assert.ok(b.rejectedTrials >= 1, 'no rejected trial: the fit did not reach the noise floor');
    assert.ok(relB <= 1e-4, `B is ${relB} from the truth`);
    assert.ok(relAgom <= 1e-3, `AGOM is ${relAgom} from the truth`);
    console.log('fit-batch noise floor: PASS');
  } finally {
    estimator.destroy?.();
    ffm.destroy?.();
  }
}

main().then(() => process.exit(0), (error) => { console.error(`fit-batch noise floor: FAIL: ${error.message}`); process.exit(1); });

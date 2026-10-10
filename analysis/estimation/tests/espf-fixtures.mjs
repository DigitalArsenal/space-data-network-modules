// The ESPF / set-membership scenario shared by tests/espf.test.mjs and the
// tri-runtime parity plan: a LEO 400 km truth by full-force HPOP, RA/Dec
// from a fixed observer by this module's simulate_tracking, and the request
// envelopes of each estimator. Framing only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EPOCH_JD, runToCompletion, truthSamples } from './hpop-port.mjs';
import { api, encode, typeRef, unpack } from './wire.mjs';

export async function espfScenario(estimator, hpop) {
  const REFERENCE = JSON.parse(fs.readFileSync(new URL('./fixtures/orekit-batch-reference.json', import.meta.url), 'utf8'));
  const TRUTH0 = REFERENCE.cases.find((c) => c.name === 'LEO400-drag').apriori.slice(0, 6);
  const SECONDS = Array.from({ length: 12 }, (_, k) => 30 * (k + 1));
  const zero3 = [0, 0, 0];
  const template = (seconds, station) => ({
    epoch: { jd_day: EPOCH_JD, seconds }, value: [0, 0, 0, 0], sigma: [1e-5, 1e-5, 0, 0], station_position_m: station, station_velocity_mps: zero3,
    station_east: zero3, station_north: zero3, station_up: zero3, remote_position_m: zero3, remote_velocity_mps: zero3, frequency_hz: 0,
    transmitter_delay_seconds: 0, receiver_delay_seconds: 0, transponder_delay_seconds: 0, elevation_rad: 0, station_latitude_rad: 0,
    station_height_m: 0, pressure_hpa: 0, temperature_k: 0, relative_humidity: 0, wavelength_m: 0, total_electron_content: 0,
    total_electron_content_rate_per_second: 0, turnaround_numerator: 1, turnaround_denominator: 1, kind: 'RIGHT_ASCENSION_DECLINATION',
    value_count: 2, flags: 3, transmitter_index: 0, receiver_index: 0,
  });
  const config = (estimator, extra = {}) => ({
    initial_epoch: { jd_day: EPOCH_JD, seconds: 0 }, initial_state: [0, 0, 0, 0, 0, 0],
    initial_covariance: Array.from({ length: 36 }, (_, i) => (i % 7 === 0 ? (i < 21 ? 1e6 : 1) : 0)),
    process_noise_spectral_density: [0, 0, 0, 0, 0, 0], state_convergence_tolerance: 0, rms_convergence_tolerance: 0, sigma_edit_threshold: 1e9,
    dynamic_model_correlation_time_seconds: 0, maximum_iterations: 0, reference_frame: 'ICRF', estimator, process_noise: 'NONE', flags: 0, ...extra,
  });
  const OFFSET = [400, -250, 120, 0.4, -0.3, 0.2];

  // Truth by HPOP; RA/Dec from a fixed observer by this module's simulator.
  const truth = await truthSamples(hpop, TRUTH0, SECONDS);
  const mid = truth[5].state, rmid = Math.hypot(mid[0], mid[1], mid[2]);
  const STATION = mid.slice(0, 3).map((x) => (x / rmid) * 6378137);
  const simulation = await estimator.invoke({ methodId: 'simulate_tracking', inputs: [
    { portId: 'request', typeRef, payload: encode({ request: { config: config('EXTENDED_KALMAN_FILTER'), observations: SECONDS.map((t) => template(t, STATION)),
      error_models: [{ noise_sigma: 1e-5, bias: 0, bias_sigma: 0, correlation_time_seconds: 0, minimum_value: 0, maximum_value: 0, sigma_edit_threshold: 3,
        random_seed: 20261009, measurement_kind: 'RIGHT_ASCENSION_DECLINATION', troposphere: 'NONE', ionosphere: 'NONE', flags: 3 }],
      propagator_port_id: 'propagator/hpop', propagator_capability: 'plugin_propagate plugin_compute_stm' } }) },
    { portId: 'propagator_samples', typeRef, payload: encode({ propagator_samples: truth }) }] });
  assert.equal(simulation.statusCode, 0, simulation.errorMessage);
  const OBSERVATIONS = unpack(simulation.outputs[0].payload).simulatedObservations;

  function envelopeFor(kind, options, { observations = OBSERVATIONS, initial = TRUTH0.map((x, i) => x + OFFSET[i]), epochSeconds = 0, configExtra = {} } = {}) {
    const env = unpack(encode({ request: { config: config(kind, configExtra), observations: [], propagator_port_id: 'propagator/hpop',
      propagator_capability: 'plugin_propagate plugin_compute_stm', options: { nonlinear_propagation: true, ...options } } }));
    env.request.config.initialState = [...initial];
    env.request.config.initialEpoch.seconds = epochSeconds;
    // Sequential runs take the simulated records as extended observations.
    const A = api();
    env.request.observations = [];
    env.request.extendedObservations = observations.map((o) => Object.assign(new A.ExtendedObservationT(), { observation: o, values: o.value.slice(0, 2), sigmas: o.sigma.slice(0, 2) }));
    return env;
  }
  const maxRelative = (a, b) => Math.max(...a.map((x, i) => Math.abs(x - b[i]) / Math.max(1, Math.abs(b[i]))));
  return { truth, OBSERVATIONS, SECONDS, envelopeFor, maxRelative };
}

// Parity cases: each estimator's first query round and its complete replay;
// the 2026 restart from final_support. Short arcs: the cases prove identical
// bytes across runtimes, and WasmEdge's interpreter replays an ESPF 2026
// epoch (three 85-point MVEEs) in seconds, not milliseconds.
export async function espfCases(estimator, hpop) {
  const { envelopeFor, OBSERVATIONS, SECONDS } = await espfScenario(estimator, hpop);
  const cases = [];
  const capture = async (id, envelope, options = {}) => {
    const rounds = [];
    const result = await runToCompletion(estimator, hpop, envelope, { ...options, rounds });
    cases.push({ id: `${id}-query`, request: rounds[0] }, { id: `${id}-complete`, request: rounds.at(-1) });
    return result;
  };
  const opts = { ukf_alpha: 1, ukf_beta: 2, ukf_kappa: 0 };
  const three = { observations: OBSERVATIONS.slice(0, 3) };
  await capture('espf-2025-gaussian-limit', envelopeFor('ESPF_2025', { ...opts, espf: { gaussian_limit: true } }, three));
  await capture('espf-2025', envelopeFor('ESPF_2025', { espf: {} }, three));
  const first = await capture('espf-2026-first', envelopeFor('ESPF_2026', { espf: {} }, { observations: OBSERVATIONS.slice(0, 2) }));
  const restart = envelopeFor('ESPF_2026', { espf: {}, initial_support: {} }, { observations: OBSERVATIONS.slice(2, 3), epochSeconds: SECONDS[1] });
  restart.request.options.initialSupport = first.finalSupport;
  await capture('espf-2026-restart', restart);
  await capture('set-membership', envelopeFor('ELLIPSOIDAL_SET_MEMBERSHIP', { set_membership: { measurement_bound_scale: 5 } }, three), { stm: true });
  return cases;
}

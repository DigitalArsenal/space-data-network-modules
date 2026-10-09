// fit_batch against Orekit 13.1's BatchLSEstimator: requests, the
// propagator/hpop answers to its queries, and the replay loop. The
// authority and tolerances are in batch_fit.test.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing/browser';
import { api, encode, pack, typeRef, unpack } from './wire.mjs';
import { requestInputs } from '../../../propagator/hpop/tests/lib/orekitCases.mjs';
import { decodePrw, sds } from '../../../propagator/hpop/tests/lib/prwCodec.mjs';

export const REFERENCE = JSON.parse(fs.readFileSync(new URL('./fixtures/orekit-batch-reference.json', import.meta.url), 'utf8'));
const EPOCH_JD = 2461254.5;  // 2026-08-02T00:00:00 UTC, the label of the configuration epoch
const K = REFERENCE.constants;

export const harness = async (url) => {
  const dir = new URL(url, import.meta.url);
  return createBrowserModuleHarness({ wasmSource: fs.readFileSync(new URL('dist/isomorphic/module.wasm', dir)), manifest: JSON.parse(fs.readFileSync(new URL('plugin-manifest.json', dir), 'utf8')), surface: 'direct' });
};

// variant 'rtn' (POSITION_VELOCITY cases): the measurement covariances in
// the RTN axes of each measured state, as Orekit rotated them.
export function fitRequest(c, variant = 'sigmas') {
  const kind = sds.prwDynamicParameter[c.parameter];
  const pv = c.measurement === 'POSITION_VELOCITY';
  const full = c.name === 'GPS-srp';
  const observations = c.observations.map(([t]) => ({
    epoch: { jd_day: EPOCH_JD, seconds: t }, value: [0, 0, 0, 0], sigma: full ? [1, 1, 1, 0] : [5, 5, 5, 0],
    station_position_m: [0, 0, 0], station_velocity_mps: [0, 0, 0], station_east: [0, 0, 0], station_north: [0, 0, 0], station_up: [0, 0, 0],
    remote_position_m: [0, 0, 0], remote_velocity_mps: [0, 0, 0], frequency_hz: 0, transmitter_delay_seconds: 0, receiver_delay_seconds: 0,
    transponder_delay_seconds: 0, elevation_rad: 0, station_latitude_rad: 0, station_height_m: 0, pressure_hpa: 0, temperature_k: 0,
    relative_humidity: 0, wavelength_m: 0, total_electron_content: 0, total_electron_content_rate_per_second: 0,
    turnaround_numerator: 1, turnaround_denominator: 1, kind: pv ? 'POSITION_VELOCITY' : 'POSITION_VECTOR', value_count: pv ? 6 : 3, flags: 3, transmitter_index: 0, receiver_index: 0,
  }));
  const zero36 = Array(36).fill(0);
  const sigmas = pv ? [0, 7, 14, 21, 28, 35].map((k) => Math.sqrt(c.measurementCovariance[k])) : [];
  const envelope = unpack(encode({ request: {
    config: { initial_epoch: { jd_day: EPOCH_JD, seconds: 0 }, initial_state: [0, 0, 0, 0, 0, 0], initial_covariance: zero36, process_noise_spectral_density: [0, 0, 0, 0, 0, 0],
      state_convergence_tolerance: 0, rms_convergence_tolerance: 0, sigma_edit_threshold: 0, dynamic_model_correlation_time_seconds: 0, maximum_iterations: 0,
      reference_frame: 'ICRF', estimator: 'BATCH_WEIGHTED_LEAST_SQUARES', process_noise: 'NONE', flags: 0 },
    ...(pv ? { extended_observations: observations.map((observation) => ({ observation, values: [0, 0, 0, 0, 0, 0], sigmas })) } : { observations }),
    propagator_port_id: 'propagator/hpop', propagator_capability: 'plugin_propagate plugin_compute_stm', trace_id: c.name,
    batch_options: { parameter_kinds: [kind], parameter_values: [0], maximum_iterations: 20, correction_tolerance: 1e-3 },
  } }));
  // Exact doubles: set through the object API, not JSON text.
  const r = envelope.request;
  r.config.initialState = [...c.apriori];
  r.batchOptions.parameterValues = [c.aprioriParameter];
  if (pv) c.observations.forEach((row, i) => { r.extendedObservations[i].values = row.slice(2, 8); });
  else c.observations.forEach(([, , x, y, z], i) => { r.observations[i].value = [x, y, z, 0]; });
  if (full) r.batchOptions.observationCovariances = c.observations.flatMap(() => c.measurementCovariance);
  if (variant === 'rtn') Object.assign(r.batchOptions, { observationCovariances: c.rtnCovariances.flat(), covarianceAxes: 1 });
  return envelope;
}

// Routes one round of queries (one seed, every observation epoch) to HPOP.
async function answer(hpop, c, queries) {
  const A = api();
  const seed = queries[0].seed.state, parameter = queries[0].parameterValues[0];
  const iso = new Map(c.observations.map(([t, text]) => [t, text]));
  const hpopCase = { ...c.forces, parameters: [c.parameter],
    samples: [[0, ...seed, REFERENCE.epochUtc], ...queries.map((q) => [q.targetEpoch.seconds, 0, 0, 0, 0, 0, 0, iso.get(q.targetEpoch.seconds)])] };
  const inputs = requestInputs(hpopCase, { edit: (exec) => {
    if (c.parameter === 'DRAG_AREA_OVER_MASS') exec.FORCES.DRAG_COEFFICIENT = parameter * K.massKg / K.areaM2;
    else exec.FORCES.REFLECTIVITY_COEFFICIENT = parameter * K.massKg / K.areaM2;
  } });
  const response = await hpop.invoke({ methodId: 'invoke', inputs });
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  const samples = decodePrw(response.outputs.find((o) => o.portId === 'response').payload).EXECUTION_RESULT.SAMPLES;
  assert.equal(samples.length, queries.length);
  return queries.map((query, k) => {
    const s = samples[k], m = s.STM.VALUES, n = s.STM.DIMENSION;
    const stm = [], sensitivity = [];
    for (let i = 0; i < 6; ++i) {
      for (let j = 0; j < 6; ++j) stm.push(m[i * n + j]);
      for (let j = 6; j < n; ++j) sensitivity.push(m[i * n + j]);
    }
    const position = s.STATE.STATE.POSITION, velocity = s.STATE.STATE.VELOCITY;
    return Object.assign(new A.PropagationAnswerT(), {
      query,
      sample: Object.assign(new A.EstimationPropagatorSampleT(), { epoch: query.targetEpoch, state: [position.X, position.Y, position.Z, velocity.X, velocity.Y, velocity.Z], stm }),
      sensitivity,
    });
  });
}

// Runs a fit to completion; `requests` collects each fit_batch invocation.
export async function fit(estimator, hpop, c, envelope, requests = []) {
  for (let round = 0; ; ++round) {
    const request = { methodId: 'fit_batch', inputs: [{ portId: 'request', typeRef, payload: pack(envelope) }] };
    requests.push(request);
    const response = await estimator.invoke(request);
    assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
    const result = unpack(response.outputs.find((o) => o.portId === 'result').payload).result;
    if (result.status !== 1) return { result, rounds: round };
    assert.equal(result.propagationRequests.length, c.observations.length);
    envelope.propagationAnswers.push(...await answer(hpop, c, result.propagationRequests));
    assert.ok(round < 20, 'no convergence in 20 rounds');
  }
}

// Parity cases: each Orekit case's first query round and its final,
// complete replay.
export async function batchFitCases() {
  const estimator = await harness('../');
  const hpop = await harness('../../../propagator/hpop/');
  const cases = [];
  try {
    for (const c of REFERENCE.cases) {
      const requests = [];
      await fit(estimator, hpop, c, fitRequest(c, c.rtnCovariances ? 'rtn' : 'sigmas'), requests);
      cases.push({ id: `fit-batch-${c.name}-query`, request: requests[0] }, { id: `fit-batch-${c.name}-complete`, request: requests.at(-1) });
    }
  } finally { estimator.destroy?.(); hpop.destroy?.(); }
  return cases;
}

// fit_batch version 2 test plumbing: requests, the replay loop and two
// answerers of the inverted port. Representation only: every dynamical state
// comes from propagator/hpop's WASM; the identity answerer (state = seed,
// STM = I) is the static model of the closed-form tests and holds no physics.
import assert from 'node:assert/strict';
import { requestInputs } from '../../../propagator/hpop/tests/lib/orekitCases.mjs';
import { decodePrw } from '../../../propagator/hpop/tests/lib/prwCodec.mjs';
import { FULL_FORCE } from './hpop-port.mjs';
import { api, encode, pack, typeRef, unpack } from './wire.mjs';

export const EPOCH_JD = 2461254.5;  // 2026-08-02T00:00:00 UTC, the HPOP fixtures' month

// ISO 8601 UTC of an EstimationEpoch {jdDay (midnight), seconds}, to the
// nanosecond (a millisecond is 7.5 m along a LEO orbit).
export function isoOf(epoch) {
  const day = Math.round((epoch.jdDay ?? epoch.jd_day) - 0.5) - 2440587;  // days since 1970-01-01
  const seconds = epoch.seconds;
  const whole = Math.floor(seconds);
  const date = new Date(day * 86400000 + whole * 1000).toISOString().slice(0, 19);
  const nanos = Math.round((seconds - whole) * 1e9);
  return `${date}.${String(Math.min(nanos, 999999999)).padStart(9, '0')}Z`;
}

const zero3 = [0, 0, 0];
// One EstimationObservation (wire fields, SI) at seconds after EPOCH_JD.
export function observation(seconds, kind, valueCount, extra = {}) {
  return {
    epoch: { jd_day: EPOCH_JD, seconds }, value: [0, 0, 0, 0], sigma: [1, 1, 1, 0],
    station_position_m: zero3, station_velocity_mps: zero3, station_east: zero3, station_north: zero3, station_up: zero3,
    remote_position_m: zero3, remote_velocity_mps: zero3, frequency_hz: 0, transmitter_delay_seconds: 0, receiver_delay_seconds: 0,
    transponder_delay_seconds: 0, elevation_rad: 0, station_latitude_rad: 0, station_height_m: 0, pressure_hpa: 0, temperature_k: 0,
    relative_humidity: 0, wavelength_m: 0, total_electron_content: 0, total_electron_content_rate_per_second: 0,
    turnaround_numerator: 1, turnaround_denominator: 1, kind, value_count: valueCount, flags: 3, transmitter_index: 0, receiver_index: 0,
    ...extra,
  };
}

// A fit_batch envelope. `observations`: [{seconds, kind, values, sigmas,
// fields}] (extended observations); the rest are BatchFitOptions in object-API
// names, set after decoding so every double is exact.
export function fitEnvelope({ state, observations, kinds = [], values = [], options = {}, errorModels }) {
  const zero36 = Array(36).fill(0);
  const envelope = unpack(encode({ request: {
    config: { initial_epoch: { jd_day: EPOCH_JD, seconds: 0 }, initial_state: [0, 0, 0, 0, 0, 0], initial_covariance: zero36, process_noise_spectral_density: [0, 0, 0, 0, 0, 0],
      state_convergence_tolerance: 0, rms_convergence_tolerance: 0, sigma_edit_threshold: 0, dynamic_model_correlation_time_seconds: 0, maximum_iterations: 0,
      reference_frame: 'ICRF', estimator: 'BATCH_WEIGHTED_LEAST_SQUARES', process_noise: 'NONE', flags: 0 },
    extended_observations: observations.map((o) => ({ observation: observation(o.seconds, o.kind, o.values.length, o.fields), values: o.values.map(() => 0), sigmas: o.values.map(() => 1) })),
    ...(errorModels ? { error_models: errorModels } : {}),
    propagator_port_id: 'propagator/hpop', propagator_capability: 'plugin_propagate plugin_compute_stm', trace_id: 'fit_batch v2',
    batch_options: { parameter_kinds: kinds, parameter_values: kinds.map(() => 0), maximum_iterations: 20, correction_tolerance: 1e-3 },
  } }));
  const r = envelope.request;
  r.config.initialState = [...state];
  r.batchOptions.parameterValues = [...values];
  observations.forEach((o, i) => {
    r.extendedObservations[i].values = [...o.values];
    r.extendedObservations[i].sigmas = [...(o.sigmas ?? o.values.map(() => 1))];
  });
  Object.assign(r.batchOptions, options);
  return envelope;
}

export const measurementParameter = (fields) => Object.assign(new (api().MeasurementParameterT)(), fields);
export const covarianceBlock = (observations, covariance) => Object.assign(new (api().CovarianceBlockT)(), { observations, covariance });

// Runs fit_batch to completion. `answer(queries)` returns one
// PropagationAnswerT per query. Returns the result (or the refusal), every
// query the module asked and every invocation (`requests`, for parity).
export async function runFit(estimator, envelope, answer, { rounds = 60 } = {}) {
  const queried = [], requests = [];
  for (let round = 0; ; ++round) {
    const request = { methodId: 'fit_batch', inputs: [{ portId: 'request', typeRef, payload: pack(envelope) }] };
    requests.push(request);
    const response = await estimator.invoke(request);
    if (response.statusCode !== 0) return { error: `${response.errorCode}: ${response.errorMessage}`, queried, requests, rounds: round };
    const result = unpack(response.outputs.find((o) => o.portId === 'result').payload).result;
    if (result.status !== 1) return { result, queried, requests, rounds: round };
    queried.push(...result.propagationRequests);
    envelope.propagationAnswers.push(...await answer(result.propagationRequests));
    assert.ok(round < rounds, `no result in ${rounds} rounds`);
  }
}

function answerOf(query, state, stm, sensitivity) {
  const A = api();
  return Object.assign(new A.PropagationAnswerT(), {
    query,
    sample: Object.assign(new A.EstimationPropagatorSampleT(), { epoch: query.targetEpoch, state, stm }),
    sensitivity,
  });
}

// The static model x(t) = seed with STM = I and a fixed 6 x p parameter
// sensitivity (row-major).
export function identityAnswerer(sensitivity = []) {
  const identity = Array.from({ length: 36 }, (_, i) => (i % 7 === 0 ? 1 : 0));
  return async (queries) => queries.map((q) => answerOf(q, [...q.seed.state], identity, sensitivity));
}

// propagator/hpop at full force for one round of queries (one seed, any
// epochs): the PRW DYNAMIC_PARAMETERS `names` take the seed's
// parameter_values. Mass and area are 1 kg and 1 m^2, so B = Cd*A/m is the
// drag coefficient and AGOM = Cr*A/m the reflectivity coefficient. `edit`
// adjusts the execution (forces, ECOM2). One HPOP execution per round, one
// sample per distinct epoch.
export const ECOM2_NAMES = ['ECOM2_D0', 'ECOM2_Y0', 'ECOM2_B0', 'ECOM2_D2_COS', 'ECOM2_D2_SIN', 'ECOM2_D4_COS', 'ECOM2_D4_SIN', 'ECOM2_B1_COS', 'ECOM2_B1_SIN', 'ECOM2_B3_COS', 'ECOM2_B3_SIN'];
export const ECOM2_FIELDS = ['D0_M_S2', 'Y0_M_S2', 'B0_M_S2', 'D2_COS_M_S2', 'D2_SIN_M_S2', 'D4_COS_M_S2', 'D4_SIN_M_S2', 'B1_COS_M_S2', 'B1_SIN_M_S2', 'B3_COS_M_S2', 'B3_SIN_M_S2'];
export function applyParameters(exec, names, values) {
  names.forEach((name, i) => {
    const v = values[i];
    if (name === 'DRAG_AREA_OVER_MASS') exec.FORCES.DRAG_COEFFICIENT = v;
    else if (name === 'SRP_AREA_OVER_MASS') exec.FORCES.REFLECTIVITY_COEFFICIENT = v;
    else if (name === 'IN_TRACK_ACCELERATION') Object.assign(exec.FORCES, { IN_TRACK_ACCELERATION_M_S2: v, HAS_IN_TRACK_ACCELERATION_M_S2: true });
    else if (name === 'DRAG_AREA_OVER_MASS_RATE') Object.assign(exec.FORCES, { DRAG_AREA_OVER_MASS_RATE_M2_KG_S: v, HAS_DRAG_AREA_OVER_MASS_RATE_M2_KG_S: true });
    else if (ECOM2_NAMES.includes(name)) exec.FORCES.ECOM2[ECOM2_FIELDS[ECOM2_NAMES.indexOf(name)]] = v;
    else throw new Error(`unknown parameter ${name}`);
  });
}

// One full-force HPOP execution from `state` at EPOCH_JD + `fromSeconds`
// to the given epochs: [{state, stm (n x n), n}] in the order of `epochs`.
// Unless estimated, B = 0.01 and AGOM = 0.01 m^2/kg (`coefficients`).
export async function hpopRun(hpop, { state, from, epochs, names = [], values = [], forces = FULL_FORCE, edit, stm = false, coefficients = { B: 0.01, AGOM: 0.01 } }) {
  const key = (e) => `${e.jdDay ?? e.jd_day}|${e.seconds}`;
  const distinct = [...new Map(epochs.map((e) => [key(e), e])).values()]
    .sort((a, b) => ((a.jdDay ?? a.jd_day) - (b.jdDay ?? b.jd_day)) * 86400 + a.seconds - b.seconds);
  const c = { ...forces, epochUtc: isoOf(from), samples: [[0, ...state], ...distinct.map((e) => [0, 0, 0, 0, 0, 0, 0, isoOf(e)])], ...(names.length ? { parameters: names } : {}) };
  const inputs = requestInputs(c, { edit: (exec) => {
    exec.INITIAL.MASS_KG = exec.FORCES.INITIAL_MASS_KG = 1;
    exec.FORCES.AREA_M2 = 1;
    exec.FORCES.DRAG_COEFFICIENT = coefficients.B;
    exec.FORCES.REFLECTIVITY_COEFFICIENT = coefficients.AGOM;
    edit?.(exec);
    applyParameters(exec, names, values);
    if (stm) exec.INCLUDE_STM = true;
  } });
  const response = await hpop.invoke({ methodId: 'invoke', inputs });
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  const samples = decodePrw(response.outputs.find((o) => o.portId === 'response').payload).EXECUTION_RESULT.SAMPLES;
  assert.equal(samples.length, distinct.length);
  const byKey = new Map(distinct.map((e, k) => {
    const s = samples[k], p = s.STATE.STATE.POSITION, v = s.STATE.STATE.VELOCITY;
    return [key(e), { state: [p.X, p.Y, p.Z, v.X, v.Y, v.Z], stm: s.STM ? s.STM.VALUES : null, n: s.STM ? s.STM.DIMENSION : 6 }];
  }));
  return epochs.map((e) => byKey.get(key(e)));
}

export function hpopAnswerer(hpop, { names = [], forces = FULL_FORCE, edit, coefficients } = {}) {
  return async (queries) => {
    const q0 = queries[0];
    const runs = await hpopRun(hpop, { state: q0.seed.state, from: q0.seed.epoch, epochs: queries.map((q) => q.targetEpoch), names, values: q0.parameterValues, forces, edit, stm: true, coefficients });
    return queries.map((q, k) => {
      const { state, stm: m, n } = runs[k];
      const stm = [], sensitivity = [];
      for (let i = 0; i < 6; ++i) {
        for (let j = 0; j < 6; ++j) stm.push(m[i * n + j]);
        for (let j = 6; j < n; ++j) sensitivity.push(m[i * n + j]);
      }
      return answerOf(q, state, stm, sensitivity);
    });
  };
}

// Small dense linear algebra for the closed-form references (row-major).
export function inverse(a, n) {
  const m = a.map((v) => v), inv = Array.from({ length: n * n }, (_, i) => (i % (n + 1) === 0 ? 1 : 0));
  for (let c = 0; c < n; ++c) {
    let p = c;
    for (let r = c + 1; r < n; ++r) if (Math.abs(m[r * n + c]) > Math.abs(m[p * n + c])) p = r;
    for (let k = 0; k < n; ++k) { [m[c * n + k], m[p * n + k]] = [m[p * n + k], m[c * n + k]]; [inv[c * n + k], inv[p * n + k]] = [inv[p * n + k], inv[c * n + k]]; }
    const d = m[c * n + c];
    for (let k = 0; k < n; ++k) { m[c * n + k] /= d; inv[c * n + k] /= d; }
    for (let r = 0; r < n; ++r) {
      if (r === c) continue;
      const f = m[r * n + c];
      if (f === 0) continue;
      for (let k = 0; k < n; ++k) { m[r * n + k] -= f * m[c * n + k]; inv[r * n + k] -= f * inv[c * n + k]; }
    }
  }
  return inv;
}

// d' P^-1 d by Cholesky of P (n x n).
export function mahalanobis(d, p, n) {
  const l = Array(n * n).fill(0);
  for (let i = 0; i < n; ++i) for (let j = 0; j <= i; ++j) {
    let s = p[i * n + j];
    for (let k = 0; k < j; ++k) s -= l[i * n + k] * l[j * n + k];
    l[i * n + j] = i === j ? Math.sqrt(s) : s / l[j * n + j];
  }
  let sum = 0;
  const z = [];
  for (let i = 0; i < n; ++i) { let s = d[i]; for (let k = 0; k < i; ++k) s -= l[i * n + k] * z[k]; z.push(s / l[i * n + i]); sum += z[i] * z[i]; }
  return sum;
}

// Deterministic standard normal deviates (xorshift128+ and Box-Muller).
export function normals(seed) {
  let s0 = BigInt(seed) | 1n, s1 = 0x9e3779b97f4a7c15n;
  const mask = (1n << 64n) - 1n;
  const next = () => {
    let x = s0; const y = s1; s0 = y;
    x ^= (x << 23n) & mask; x ^= x >> 17n; x ^= y ^ (y >> 26n); s1 = x & mask;
    return Number(((s0 + s1) & mask) >> 11n) / 2 ** 53;
  };
  return () => {
    const u = Math.max(next(), 1e-300), v = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

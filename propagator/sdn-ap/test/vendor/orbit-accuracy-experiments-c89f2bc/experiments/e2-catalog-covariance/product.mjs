// One E2 product: pseudo-observations from an object's element sets
// (analysis/epoch-state: SGP4 at each set's epoch, in GCRF), the batch fit of
// state and dynamic parameters (analysis/estimation fit_batch, answered by
// propagator/ffm), and its propagation with covariance to the scoring
// epochs. This file routes records between the modules; it computes nothing.
import { decodeOemStream, mpeFrame } from '../../harness/records.mjs';
import { EST_TYPE, decodeResult, positionObservation, seedStruct } from './estimation-wire.mjs';
import { decodeSamples, executionFrame } from './ffm.mjs';

// Space-Track epoch text (UTC, microseconds, no zone) -> Unix seconds,
// keeping the microseconds that Date.parse would drop.
export function unixSeconds(text) {
  const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?/.exec(text);
  return Date.parse(`${m[1]}Z`) / 1000 + Number(`0.${m[2] ?? '0'}`);
}

// GCRF epoch states for element sets: [{epoch (ISO UTC from the module), state [m, m/s]}]
// in input order; a refused set gives null.
export async function epochStates(epochState, sets) {
  const records = sets.map((s) => ({ entityId: `NORAD:${s.norad}`, epochUnix: unixSeconds(s.epoch), ...s.elements }));
  const response = await epochState.invoke('derive', [mpeFrame(records)]);
  const report = JSON.parse(Buffer.from(response.outputs.find((f) => f.portId === 'report').payload).toString('utf8'));
  const refused = new Set((report.refused ?? report.failures ?? []).map((r) => r.index));
  const states = decodeOemStream(new Uint8Array(response.outputs.find((f) => f.portId === 'states').payload));
  const out = [];
  let k = 0;
  for (let i = 0; i < sets.length; ++i) {
    if (refused.has(i)) { out.push(null); continue; }
    const line = states[k++].EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES[0];
    out.push({ epoch: line.EPOCH.replace(/Z$/, ''), state: [line.X, line.Y, line.Z, line.X_DOT, line.Y_DOT, line.Z_DOT].map((v) => v * 1000) });
  }
  if (k !== states.length) throw new Error('analysis/epoch-state: state count does not match its report');
  return out;
}

// ISO UTC text -> EstimationEpoch {jd_day (midnight), seconds}. Labels only:
// the estimator orders and matches epochs, the propagator integrates them.
export function estEpoch(iso) {
  const ms = Date.parse(`${iso.slice(0, 19)}Z`);
  const day = Math.floor(ms / 86400000);
  const frac = /\.(\d+)/.exec(iso)?.[1] ?? '0';
  return { jd_day: day + 2440587.5, seconds: (ms - day * 86400000) / 1000 + Number(`0.${frac}`) };
}

// Batch fit: the entry point E2's C2/C4 (and any lane fitting state and
// dynamic parameters to full-state observations, e.g. operator ephemerides)
// uses. observations: [{epoch ISO, state [m, m/s], covariance? [36]}], each
// a full-state observation with its own 6x6 covariance or else
// settings.covarianceRtn, in the axes settings.covarianceAxes names ('RTN'
// of the observed state, the default, or 'INERTIAL' GCRF); reference: {epoch ISO, state}, the
// product epoch and the first guess.
// settings: {parameters [{kind, value}], apriori (n x n) | null, covarianceRtn [36], fit options, forces, integrator, fixed}.
// Returns {fit, rounds, ffmCalls} or throws on a module failure.
export async function fitProduct({ estimation, ffm, codec, inputs }, reference, observations, settings) {
  const isoByLabel = new Map(observations.map((o) => [JSON.stringify(estEpoch(o.epoch)), o.epoch]));
  const request = {
    config: {
      initial_epoch: estEpoch(reference.epoch), initial_state: reference.state, initial_covariance: Array(36).fill(0),
      process_noise_spectral_density: Array(6).fill(0), state_convergence_tolerance: 0, rms_convergence_tolerance: 0, sigma_edit_threshold: 0,
      dynamic_model_correlation_time_seconds: 0, maximum_iterations: 0, reference_frame: 'ICRF', estimator: 'BATCH_WEIGHTED_LEAST_SQUARES', process_noise: 'NONE', flags: 0,
    },
    extended_observations: observations.map((o) => ({
      observation: { ...positionObservation(estEpoch(o.epoch), [0, 0, 0]), kind: 'POSITION_VELOCITY', value_count: 6 },
      values: o.state, sigmas: [1, 1, 1, 1, 1, 1],
    })),
    propagator_port_id: 'propagator/ffm', propagator_capability: 'plugin_propagate plugin_compute_stm',
    batch_options: {
      parameter_kinds: settings.parameters.map((p) => ({ DRAG_AREA_OVER_MASS: 1, DRAG_AREA_OVER_MASS_RATE: 2, SRP_AREA_OVER_MASS: 3, IN_TRACK_ACCELERATION: 4 })[p.kind]),
      parameter_values: settings.parameters.map((p) => p.value),
      ...(settings.apriori ? { apriori_covariance: settings.apriori } : {}),
      observation_covariances: observations.flatMap((o) => o.covariance ?? settings.covarianceRtn),
      covariance_axes: (settings.covarianceAxes ?? 'RTN') === 'RTN' ? 1 : 0,
      maximum_iterations: settings.maximumIterations, correction_tolerance: settings.correctionTolerance, sigma_edit_threshold: settings.sigmaEditThreshold,
    },
  };
  const answers = [];
  let ffmCalls = 0;
  for (let round = 0; ; ++round) {
    const response = await estimation.invoke('fit_batch', [{ portId: 'request', typeRef: EST_TYPE, payload: codec.encode({ request, propagation_answers: answers }) }]);
    const out = decodeResult(response.outputs.find((o) => o.portId === 'result').payload);
    if (out.status !== 1) return { fit: out.fit, status: out.status, rounds: round, ffmCalls };
    // One seed per round: one FFM call with every observation epoch.
    const q0 = out.queries[0];
    const parameters = settings.parameters.map((p, i) => ({ kind: p.kind, value: q0.parameter_values[i] }));
    const samples = decodeSamples(await ffm.invoke('invoke', [
      executionFrame({ epoch: reference.epoch, state: q0.seed.state, samples: out.queries.map((q) => isoByLabel.get(JSON.stringify(q.target_epoch))),
        forces: settings.forces, parameters, fixed: settings.fixed, stm: true, covariance: null, noise: null, integrator: settings.integrator }),
      ...inputs,
    ]));
    ++ffmCalls;
    out.queries.forEach((q, k) => {
      const s = samples[k], n = s.n, stm = [], sensitivity = [];
      for (let i = 0; i < 6; ++i) {
        for (let j = 0; j < 6; ++j) stm.push(s.stm[i * n + j]);
        for (let j = 6; j < n; ++j) sensitivity.push(s.stm[i * n + j]);
      }
      answers.push({
        query: { sequence: q.sequence, seed: seedStruct(q), target_epoch: q.target_epoch, parameter_values: q.parameter_values },
        sample: { epoch: q.target_epoch, state: s.state, stm },
        sensitivity,
      });
    });
    if (round > settings.maximumIterations + 1) throw new Error('fit_batch kept asking for propagation');
  }
}

// Propagates a product to the scoring epochs with its covariance; with
// noise {q, intervalSeconds} the white-acceleration noise is added.
// Returns [{epoch, position [m], covariance3 [9] (m^2)}].
// propagator/ffm tests positive semidefiniteness by LDL' in km units with
// an absolute tolerance of 1e-12 of the largest entry, and refuses a pivot
// below it that still has a cross term. A fitted covariance whose velocity,
// given the position, is known to better than that trips it. conditioned()
// adds twice that tolerance to the diagonal (in SI: 2e-12 max|P_km| x 1e6 on
// the state rows): about 1e-9 m^2 and 1e-9 m^2/s^2, which no reported
// number resolves.
export function conditioned(covariance) {
  const n = Math.round(Math.sqrt(covariance.length));
  let scale = 0;
  covariance.forEach((v, k) => { scale = Math.max(scale, Math.abs(v) * (Math.floor(k / n) < 6 ? 1e-3 : 1) * (k % n < 6 ? 1e-3 : 1)); });
  const out = [...covariance];
  for (let i = 0; i < n; ++i) out[i * n + i] += 2e-12 * scale * (i < 6 ? 1e6 : 1);
  return out;
}

export async function propagateProduct({ ffm, inputs }, product, epochs, settings, { covariance, noise }) {
  const parameters = settings.parameters.map((p, i) => ({ kind: p.kind, value: product.estimate[6 + i] }));
  const samples = decodeSamples(await ffm.invoke('invoke', [
    executionFrame({ epoch: product.epoch, state: product.estimate.slice(0, 6), samples: epochs, forces: settings.forces, parameters, fixed: settings.fixed,
      stm: false, covariance, noise, integrator: settings.integrator }),
    ...inputs,
  ]));
  return samples.map((s) => {
    const n = s.n, c = s.covariance;
    return { epoch: s.epoch, position: s.state.slice(0, 3), covariance3: [0, 1, 2].flatMap((i) => [0, 1, 2].map((j) => c[i * n + j])) };
  });
}

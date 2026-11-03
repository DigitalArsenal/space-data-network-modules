// analysis/estimation `fit_batch` version 3 (0.6.0, schema extension v6) answered by propagator/ffm: one batch least-squares fit of
// the GCRF state at the reference epoch and the dynamic parameters, as a product calls it (estimation README, "Batch fit with dynamic
// parameters"; "The solver (version 3)"):
// - one round at the stated measurement sigmas (no down-weighted first round, no prior re-centering between rounds);
// - each dynamic parameter's domain from propagator/ffm's table (FIT_PARAMETER_DOMAINS, catalog-configuration.mjs), passed as the
//   required parameter_lower_bounds and parameter_upper_bounds (NaN: unbounded on that side);
// - the host rule for refusals: when propagator/ffm returns an error for a round, every query of that round is answered refused with
//   FFM's error text, and the fit takes the round as a rejected trial;
// - ok only when the fit's termination is CONVERGED (status OK). MAXIMUM_ITERATIONS and STALLED report the best evaluated point and
//   are not ok; a fit-failed request (for example a refused seed) is not ok, with the module's text.
// Encoding, decoding and routing only: the solver is analysis/estimation's, the dynamics propagator/ffm's.
import fs from 'node:fs';
import path from 'node:path';
import * as flatbuffers from 'flatbuffers';
import createFlatc from 'flatc-wasm/module';
import { EST_TYPE, decodeResult, positionObservation, seedStruct } from '../../e2-catalog-covariance/estimation-wire.mjs';
import { estEpoch } from '../../e2-catalog-covariance/product.mjs';
import { decodeSamples, executionFrame } from './frame.mjs';

// PRW DYNAMIC_PARAMETERS ordinals (the opaque parameter_kinds fit_batch echoes).
const KIND = { DRAG_AREA_OVER_MASS: 1, DRAG_AREA_OVER_MASS_RATE: 2, SRP_AREA_OVER_MASS: 3, IN_TRACK_ACCELERATION: 4 };
const STATUS = { OK: 0, NEEDS_PROPAGATION: 1, NOT_CONVERGED: -5 };
const TERMINATION = ['CONVERGED', 'MAXIMUM_ITERATIONS', 'STALLED'];
const NAN = '__fit_v3_nan__';

/** flatc with the estimation module's own schema: encode(value) where NaN numbers are written as flatc's `nan`. */
export async function estimationCodecV3(modulesDir, sdkSchemas) {
  const errors = [];
  const flatc = await createFlatc({ print: () => {}, printErr: (s) => errors.push(s) });
  flatc.FS.mkdir('/schema');
  flatc.FS.mkdir('/out');
  for (const name of fs.readdirSync(sdkSchemas).filter((n) => n.endsWith('.fbs'))) flatc.FS.writeFile(`/schema/${name}`, fs.readFileSync(path.join(sdkSchemas, name)));
  flatc.FS.writeFile('/schema/Estimation.fbs', fs.readFileSync(path.join(modulesDir, 'analysis/estimation/schemas/Estimation.fbs')));
  return {
    encode(value) {
      errors.length = 0;
      const text = JSON.stringify(value, (_, v) => (typeof v === 'number' && Number.isNaN(v) ? NAN : v)).replaceAll(`"${NAN}"`, 'nan');
      flatc.FS.writeFile('/in.json', text);
      const rc = flatc.callMain(['--no-warnings', '--strict-json', '-I', '/schema', '-o', '/out', '--binary', '/schema/Estimation.fbs', '/in.json']);
      if (rc !== 0) throw new Error(`flatc: cannot encode the $EST request (exit ${rc}): ${errors.join(' ').slice(0, 200)}`);
      return Uint8Array.from(flatc.FS.readFile('/out/in.bin'));
    },
  };
}

// Extension v6's BatchFitResult suffix (slots 20-23) and EstimationResult.error_message (slot 8): read directly from the binary.
function decodeV3(bytes) {
  const out = decodeResult(bytes);
  const bb = new flatbuffers.ByteBuffer(new Uint8Array(bytes));
  const field = (table, slot) => bb.__offset(table, 4 + 2 * slot);
  const root = bb.readInt32(bb.position()) + bb.position();
  const result = bb.__indirect(root + field(root, 1));
  const eo = field(result, 8);
  out.errorMessage = eo ? bb.__string(result + eo) : null;
  const fo = field(result, 12);
  if (fo && out.fit) {
    const t = bb.__indirect(result + fo);
    const at = (slot) => field(t, slot);
    out.fit.termination = TERMINATION[at(20) ? bb.readUint8(t + at(20)) : 0];
    out.fit.rejectedTrials = at(21) ? bb.readUint32(t + at(21)) : 0;
    out.fit.refusedTrials = at(22) ? bb.readUint32(t + at(22)) : 0;
    out.fit.refusal = at(23) ? bb.__string(t + at(23)) : null;
  }
  return out;
}

/** Each parameter's [lower, upper] from propagator/ffm's FIT_PARAMETER_DOMAINS (NaN: unbounded). A kind the table lacks fails fast. */
export function boundsFrom(domains, kinds) {
  const d = kinds.map((k) => { if (!domains[k]) throw new Error(`no fit domain for ${k} in propagator/ffm's table`); return domains[k]; });
  return { lower: d.map((x) => x[0]), upper: d.map((x) => x[1]) };
}

/**
 * One fit. ctx {estimation, ffm, codec (estimationCodecV3), inputs (FFM's environment frames), domains (FIT_PARAMETER_DOMAINS)};
 * points [{time ISO, position [m] GCRF}]; reference {epoch ISO, state [m, m/s]} (first guess, at or before every point);
 * settings {sigmaM, parameters [{kind, value}] (seeds, the a priori mean), fixed {b, agom, t}, apriori [(6+p)^2] | [],
 * maximumIterations (propagation rounds, every trial counted), correctionTolerance, sigmaEditThreshold, forces, integrator}.
 * Returns { ok, termination, status, estimate, state, parameters, covariance, ... } or { ok: false, error }.
 */
export async function fitV3(ctx, points, reference, settings) {
  const { estimation, ffm, codec, inputs, domains } = ctx;
  const kinds = settings.parameters.map((p) => p.kind);
  const { lower, upper } = boundsFrom(domains, kinds);
  const variance = settings.sigmaM ** 2;
  const sorted = [...points].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  const isoByLabel = new Map(sorted.map((p) => [JSON.stringify(estEpoch(p.time)), p.time]));
  const request = {
    config: {
      initial_epoch: estEpoch(reference.epoch), initial_state: reference.state, initial_covariance: Array(36).fill(0),
      process_noise_spectral_density: Array(6).fill(0), state_convergence_tolerance: 0, rms_convergence_tolerance: 0, sigma_edit_threshold: 0,
      dynamic_model_correlation_time_seconds: 0, maximum_iterations: 0, reference_frame: 'ICRF', estimator: 'BATCH_WEIGHTED_LEAST_SQUARES', process_noise: 'NONE', flags: 0,
    },
    extended_observations: sorted.map((p) => ({ observation: positionObservation(estEpoch(p.time), [0, 0, 0]), values: p.position, sigmas: [1, 1, 1] })),
    propagator_port_id: 'propagator/ffm', propagator_capability: 'plugin_propagate plugin_compute_stm',
    batch_options: {
      parameter_kinds: kinds.map((k) => KIND[k]), parameter_values: settings.parameters.map((p) => p.value),
      apriori_covariance: settings.apriori ?? [],
      observation_covariances: sorted.flatMap(() => [variance, 0, 0, 0, variance, 0, 0, 0, variance]),
      covariance_axes: 0, parameter_lower_bounds: lower, parameter_upper_bounds: upper,
      maximum_iterations: settings.maximumIterations, correction_tolerance: settings.correctionTolerance, sigma_edit_threshold: settings.sigmaEditThreshold,
    },
  };
  const answers = [];
  let ffmCalls = 0, refusedRounds = 0;
  for (let round = 0; ; ++round) {
    if (round > settings.maximumIterations + 2) throw new Error('fit_batch kept asking for propagation');
    let out;
    try {
      const response = await estimation.invoke('fit_batch', [{ portId: 'request', typeRef: EST_TYPE, payload: codec.encode({ request, propagation_answers: answers }) }]);
      out = decodeV3(response.outputs.find((o) => o.portId === 'result').payload);
    } catch (error) { return { ok: false, error: String(error.message).slice(0, 300), ffmCalls, refusedRounds }; }
    if (out.status !== STATUS.NEEDS_PROPAGATION) {
      const f = out.fit;
      if (!f || !f.estimate?.length) return { ok: false, error: out.errorMessage ?? `fit_batch status ${out.status}`, status: out.status, ffmCalls, refusedRounds };
      const p = kinds.length;
      const ok = out.status === STATUS.OK && f.termination === 'CONVERGED';
      return {
        ok, ...(ok ? {} : { error: f.termination === 'CONVERGED' ? `fit_batch status ${out.status}` : f.termination }), status: out.status, termination: f.termination,
        epoch: reference.epoch, state: f.estimate.slice(0, 6), parameters: kinds.map((kind, i) => ({ kind, value: f.estimate[6 + i] })), boundStatus: f.boundStatus.slice(0, p),
        reducedChiSquare: f.reducedChiSquare, chiSquare: f.chiSquare, weightedRms: f.weightedRms, measurements: f.measurementCount, degreesOfFreedom: f.degreesOfFreedom,
        rejected: f.rejectedObservationIndices.length, iterations: f.iterations, rejectedTrials: f.rejectedTrials, refusedTrials: f.refusedTrials, refusal: f.refusal,
        ffmCalls, refusedRounds, covariance: Array.from(f.covariance ?? []),
      };
    }
    // One FFM run per round from the round's seed; one sample per distinct epoch.
    const q0 = out.queries[0];
    const parameters = kinds.map((kind, i) => ({ kind, value: q0.parameter_values[i] }));
    const epochs = [...new Set(out.queries.map((q) => isoByLabel.get(JSON.stringify(q.target_epoch))))];
    let samples = null, refusal = null;
    try {
      samples = decodeSamples(await ffm.invoke('invoke', [
        executionFrame({ epoch: reference.epoch, state: q0.seed.state, samples: epochs, forces: settings.forces, parameters, fixed: settings.fixed ?? {}, stm: true, covariance: null, noise: null, integrator: settings.integrator }),
        ...inputs,
      ]));
    } catch (error) { refusal = String(error.message).slice(0, 300); }
    ++ffmCalls;
    const query = (q) => ({ sequence: q.sequence, seed: seedStruct(q), target_epoch: q.target_epoch, parameter_values: q.parameter_values });
    if (refusal !== null) {
      ++refusedRounds;
      for (const q of out.queries) answers.push({ query: query(q), refused: true, refusal });
      continue;
    }
    const byEpoch = new Map(epochs.map((e, i) => [e, samples[i]]));
    for (const q of out.queries) {
      const s = byEpoch.get(isoByLabel.get(JSON.stringify(q.target_epoch))), n = s.n, stm = [], sensitivity = [];
      for (let i = 0; i < 6; ++i) {
        for (let j = 0; j < 6; ++j) stm.push(s.stm[i * n + j]);
        for (let j = 6; j < n; ++j) sensitivity.push(s.stm[i * n + j]);
      }
      answers.push({ query: query(q), sample: { epoch: q.target_epoch, state: s.state, stm }, sensitivity });
    }
  }
}

/** The fitted product carried by propagator/ffm to sample epochs (ISO UTC, ascending) with the fit's forces and parameters (T included
 *  when fitted or fixed), optionally with its covariance over state and parameters: [{epoch, state [m, m/s], covariance, n}]. */
export async function propagateV3(ctx, product, samples, settings, covariance = null) {
  return decodeSamples(await ctx.ffm.invoke('invoke', [
    executionFrame({ epoch: product.epoch, state: product.state, samples, forces: settings.forces, parameters: product.parameters, fixed: settings.fixed ?? {},
      stm: false, covariance, noise: null, integrator: settings.integrator }),
    ...ctx.inputs,
  ]));
}

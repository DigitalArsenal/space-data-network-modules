// Tri-runtime parity of run_relative_navigation, relative_state and the
// innovation-recovery EKF (extension v5): the identical module bytes, in the
// Chrome/V8 lane and the native WasmEdge lane, at host widths 1/2/4/8, answer
// byte-identical requests identically. The owner waived the container
// WasmEdge leg (no Docker). Every request is a typed $EST FlatBuffer built
// with the generated object API; the measurements come from propagator/ffm
// (relnav-truth.mjs) with the planted maneuvers FFM-1 impulses.
//
// node tests/relnav-parity.mjs   (run through headless-run: the browser lane)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing/browser';
import { formatParityReport, normalizeParityFixture, runParityHarness } from 'space-data-module-sdk/testing';
import { moduleUnderTest } from './build-under-test.mjs';
import { EPOCH_JD, J2, FIELD_RADIUS_M, MU, answerQueries, deputyInitialState, ffmArc, keplerState, openFfm } from './relnav-truth.mjs';
import { api, pack, typeRef, unpack } from './wire.mjs';

const A = api();
const ICRF = 2;  // orbpro.propagator.ReferenceFrame.ICRF
const DAY_SECONDS = 86400;

// Deterministic noise (test tooling): a 64-bit LCG and Box-Muller.
function generator(seed) {
  let s = BigInt(seed);
  const uniform = () => { s = (s * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n); return (Number(s >> 11n) + 0.5) / 2 ** 53; };
  return () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
}

const epochOf = (seconds) => new A.EstimationEpochT(EPOCH_JD, seconds);
const chiefOf = (c) => Object.assign(new A.ChiefReferenceT(), { semiMajorAxisM: c.semiMajorAxisM, eccentricity: c.eccentricity, inclinationRad: c.inclinationRad, trueAnomalyRad: c.trueAnomalyRad, argumentOfPerigeeRad: c.argumentOfPerigeeRad });
const diagonal = (values) => values.flatMap((v, i) => Array.from({ length: values.length }, (_, j) => (i === j ? v : 0)));

async function main() {
  const { wasm, manifest, hash } = moduleUnderTest();
  const estimator = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(wasm), manifest: JSON.parse(fs.readFileSync(manifest, 'utf8')), surface: 'direct' });
  const ffm = await openFfm();
  const call = async (methodId, envelope) => {
    const response = await estimator.invoke({ methodId, inputs: [{ portId: 'request', typeRef, payload: pack(envelope) }] });
    assert.equal(response.statusCode, 0, `${methodId}: ${response.errorCode} ${response.errorMessage}`);
    return unpack(response.outputs.find((o) => o.portId === 'result').payload);
  };
  const cases = [];
  const addCase = (id, methodId, envelope) => cases.push({ id, request: { methodId, inputs: [{ portId: 'request', typeRef, payload: pack(envelope) }] } });

  // ---- relative navigation: two arcs of two objects each, 2 h at 60 s ----
  const times = Array.from({ length: 120 }, (_, k) => 60 * (k + 1));
  const arcs = [];
  for (const [name, elements, model] of [['circular', { a: 6878137, e: 1e-4, incDeg: 51.6 }, null], ['e06', { a: 17195000, e: 0.6, incDeg: 63.4, nuDeg: 330 }, null]]) {
    const chief0 = keplerState(elements), deputy0 = deputyInitialState(chief0, 1000);
    const chief = await ffmArc(ffm, chief0, times);
    const deputy = await ffmArc(ffm, deputy0, times, { maneuver: { impulse: { seconds: 3630, deltaVRtn: [0, 0.1, 0] } } });
    const convert = async (curvilinear) => {
      const request = new A.RelativeStateRequestT();
      request.gravitationalParameterM3S2 = MU;
      request.chiefStates = [...chief0, ...chief.flat()];
      request.deputyStates = [...deputy0, ...deputy.flat()];
      request.curvilinear = curvilinear;
      const envelope = new A.EstimationEnvelopeT();
      envelope.relativeStateRequest = request;
      if (name === 'circular') addCase(`relative-state-${curvilinear ? 'curvilinear' : 'rectilinear'}`, 'relative_state', envelope);
      return (await call('relative_state', envelope)).relativeStateResult;
    };
    const rectilinear = await convert(false), curvilinear = await convert(true);
    arcs.push({ name, states: rectilinear.states, curvilinearStates: curvilinear.states, chiefs: rectilinear.chiefs });
  }

  const noise = generator(20261024);
  function relativeRequest({ arc, model, recovery, curvilinear = false, outlierAt = -1, psd = 1e-9 }) {
    const sigma = [1, 1, 1, 1e-3, 1e-3, 1e-3];
    const covariance = diagonal(sigma.map((s) => s * s));
    const config = new A.RelativeNavConfigT();
    config.model = model;
    config.measurementModel = A.RelativeMeasurementModel.FULL_STATE;
    config.epoch = epochOf(0);
    config.gravitationalParameterM3S2 = MU;
    config.j2 = J2;
    config.equatorialRadiusM = FIELD_RADIUS_M;
    config.processNoise = A.ProcessNoiseKind.STATE_NOISE_COMPENSATION;
    config.accelerationPsd = [psd, psd, psd];
    config.chief = chiefOf(arc.chiefs[0]);
    config.curvilinear = curvilinear;
    config.recovery = Object.assign(new A.InnovationRecoveryOptionsT(), recovery);
    const source = curvilinear ? arc.curvilinearStates : arc.states;
    const row = (k) => source.slice(6 * k, 6 * k + 6);
    const measured = (k) => row(k).map((x, i) => x + sigma[i] * noise() * (k === outlierAt ? 40 : 1));
    config.state = measured(0).map((x, i) => x + (i < 3 ? 5 : 5e-3) * 0);
    config.covariance = diagonal(sigma.map((s) => 100 * s * s));
    const observations = times.map((t, k) => Object.assign(new A.RelativeObservationT(), { epoch: epochOf(t), state: measured(k + 1), covariance, chief: chiefOf(arc.chiefs[k + 1]) }));
    const envelope = new A.EstimationEnvelopeT();
    envelope.relativeRequest = Object.assign(new A.RelativeNavRequestT(), { config, observations });
    return envelope;
  }
  const predictive = { enabled: true, strategy: A.RecoveryStrategy.PREDICTIVE_CONSISTENCY, nisProbability: 0.999, confirmationCount: 2, covarianceInflation: 4, maxGapSeconds: 120 };
  const persistence = { ...predictive, strategy: A.RecoveryStrategy.PERSISTENCE };
  const circular = arcs[0], eccentric = arcs[1];
  addCase('relnav-hcw-predictive-impulse', 'run_relative_navigation', relativeRequest({ arc: circular, model: A.RelativeModel.HILL_CLOHESSY_WILTSHIRE, recovery: predictive }));
  addCase('relnav-ssj2-persistence-impulse', 'run_relative_navigation', relativeRequest({ arc: circular, model: A.RelativeModel.SCHWEIGHART_SEDWICK_J2, recovery: persistence }));
  addCase('relnav-th-e06-predictive-outlier', 'run_relative_navigation', relativeRequest({ arc: eccentric, model: A.RelativeModel.TSCHAUNER_HEMPEL, recovery: predictive, outlierAt: 30, psd: 1e-8 }));
  addCase('relnav-ya-e06-persistence-impulse', 'run_relative_navigation', relativeRequest({ arc: eccentric, model: A.RelativeModel.YAMANAKA_ANKERSEN, recovery: persistence, psd: 1e-8 }));
  addCase('relnav-ya-e06-curvilinear-predictive', 'run_relative_navigation', relativeRequest({ arc: eccentric, model: A.RelativeModel.YAMANAKA_ANKERSEN, recovery: predictive, curvilinear: true, psd: 1e-8 }));
  addCase('relnav-hcw-recovery-off', 'run_relative_navigation', relativeRequest({ arc: circular, model: A.RelativeModel.HILL_CLOHESSY_WILTSHIRE, recovery: { enabled: false } }));

  // ---- absolute EKF with innovation recovery: first query round and the complete replay ----
  const iss = keplerState({ a: 6780000, e: 5e-4, incDeg: 51.6 });
  const issTimes = Array.from({ length: 45 }, (_, k) => 120 * (k + 1));
  const issArc = await ffmArc(ffm, iss, issTimes, { maneuver: { impulse: { seconds: 3000, deltaVRtn: [0, 0.2, 0] } } });
  const sigmaPv = [5, 5, 5, 5e-3, 5e-3, 5e-3];
  function absoluteEnvelope(recovery) {
    const config = new A.EstimationConfigT();
    config.initialEpoch = epochOf(0);
    config.initialState = iss.map((x, i) => x + (i < 3 ? 20 : 0.02) * (i % 2 ? 1 : -1));
    config.initialCovariance = diagonal(sigmaPv.map((s) => 100 * s * s));
    config.processNoiseSpectralDensity = [1e-7, 1e-7, 1e-7, 0, 0, 0];
    config.sigmaEditThreshold = 3;
    config.referenceFrame = ICRF;
    config.estimator = A.EstimatorKind.EXTENDED_KALMAN_FILTER;
    config.processNoise = A.ProcessNoiseKind.STATE_NOISE_COMPENSATION;
    const options = Object.assign(new A.SequentialOptionsT(), { nonlinearPropagation: true, innovationRecovery: Object.assign(new A.InnovationRecoveryOptionsT(), recovery) });
    const extendedObservations = issTimes.map((t, k) => {
      const o = new A.EstimationObservationT();
      Object.assign(o, { epoch: epochOf(t), value: [0, 0, 0, 0], sigma: [1, 1, 1, 1], stationPositionM: [0, 0, 0], stationVelocityMps: [0, 0, 0], stationEast: [0, 0, 0], stationNorth: [0, 0, 0], stationUp: [0, 0, 0], remotePositionM: [0, 0, 0], remoteVelocityMps: [0, 0, 0], turnaroundNumerator: 1, turnaroundDenominator: 1, kind: A.MeasurementKind.POSITION_VELOCITY, valueCount: 6, flags: 3 });
      return Object.assign(new A.ExtendedObservationT(), { observation: o, values: issArc[k].map((x, i) => x + sigmaPv[i] * noise() * (k === 20 ? 40 : 1)), sigmas: sigmaPv });
    });
    const request = Object.assign(new A.EstimationRequestT(), { config, extendedObservations, propagatorPortId: 'propagator/ffm', propagatorCapability: 'plugin_propagate plugin_compute_stm', options });
    return Object.assign(new A.EstimationEnvelopeT(), { request });
  }
  const legacyPort = pack(Object.assign(new A.EstimationEnvelopeT(), { propagatorSamples: [] }));
  for (const [name, recovery] of [['predictive', predictive], ['persistence', persistence]]) {
    const envelope = absoluteEnvelope(recovery);
    const rounds = [];
    for (let round = 0; ; ++round) {
      const input = { methodId: 'run_estimation', inputs: [{ portId: 'request', typeRef, payload: pack(envelope) }, { portId: 'propagator_samples', typeRef, payload: legacyPort }] };
      rounds.push(input);
      const response = await estimator.invoke(input);
      assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
      const result = unpack(response.outputs.find((o) => o.portId === 'result').payload).result;
      if (result.status !== 1) { assert.equal(result.recoveryHistory.length, issTimes.length); break; }
      envelope.propagationAnswers.push(...await answerQueries(ffm, result.propagationRequests, { stm: true }));
      assert.ok(round < 400);
    }
    cases.push({ id: `ekf-recovery-${name}-query`, request: rounds[0] }, { id: `ekf-recovery-${name}-complete`, request: rounds.at(-1) });
  }
  for (const h of [estimator, ffm]) { h.destroy?.(); h.dispose?.(); }

  const plan = await normalizeParityFixture({
    name: 'relative navigation and innovation recovery, extension v5',
    threadEnvVar: 'SDM_WORKER_COUNT',
    threadCounts: [1, 2, 4, 8],
    cases: cases.map((c) => ({ ...c, request: { ...c.request, inputs: c.request.inputs.map(({ payload, ...p }) => ({ ...p, payloadHex: Buffer.from(payload).toString('hex') })) } })),
  });
  const report = await runParityHarness({ wasmPath: wasm, plan, lanes: ['browser', 'wasmedge'], timeoutMs: 300000, log: console.log });
  console.log(formatParityReport(report));
  const receipt = { ...report, wasmPath: `tests/.generated/module-under-test/${hash}/dist/isomorphic/module.wasm`, dockerLane: 'waived by the owner 2026-10-22 (no Docker)' };
  fs.writeFileSync(fileURLToPath(new URL('../conformance/relative-nav-recovery-parity.json', import.meta.url)), `${JSON.stringify(receipt, null, 2)}\n`);
  assert.equal(report.ok, true, JSON.stringify(report.failures));
}
await main();

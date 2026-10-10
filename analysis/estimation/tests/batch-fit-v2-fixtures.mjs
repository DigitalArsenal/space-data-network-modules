// fit_batch version 2 scenarios shared by the tests and the tri-runtime
// parity plan, so parity replays exactly the requests the tests check.
// Authorities and tolerances are stated in batch_fit_v2.test.mjs and
// measurement_parameters.test.mjs.
import assert from 'node:assert/strict';
import { REFERENCE, answer, fitRequest, harness } from './batch-fit-fixtures.mjs';
import { covarianceBlock, fitEnvelope, hpopAnswerer, identityAnswerer, isoOf, measurementParameter, runFit } from './batch-fit-v2-lib.mjs';
import { campaign } from './tracking-pipeline.mjs';
import { sds } from '../../../propagator/hpop/tests/lib/prwCodec.mjs';

export const STATE = [7000e3, 100e3, -50e3, 100, 7400, 1000];
export const LEO = REFERENCE.cases.find((c) => c.name === 'LEO400-drag');

// (R kron diag(s^2)): R m x m, s per component.
export function kron(r, m, s) {
  const d = s.length, n = m * d, c = Array(n * n).fill(0);
  for (let j = 0; j < m; ++j) for (let k = 0; k < m; ++k) for (let a = 0; a < d; ++a) c[(j * d + a) * n + k * d + a] = r[j * m + k] * s[a] * s[a];
  return c;
}

// Three full states with equicorrelated errors (rho = -0.6): not positive definite.
export const BLOCK = { s: [10, 20, 30, 0.1, 0.2, 0.3], rho: -0.6, floor: 1e-3,
  offsets: [[3, -4, 5, 0.01, -0.02, 0.03], [-1, 2, -3, -0.03, 0.01, 0.02], [7, 1, -2, 0.02, 0.02, -0.01]] };
export function blockEnvelope(regularize) {
  const { s, rho, floor, offsets } = BLOCK;
  const r = [1, rho, rho, rho, 1, rho, rho, rho, 1];
  const observations = offsets.map((o, j) => ({ seconds: 60 * j, kind: 'POSITION_VELOCITY', values: STATE.map((x, i) => x + o[i]) }));
  return fitEnvelope({ state: STATE, observations, options: { covarianceBlocks: [covarianceBlock([0, 1, 2], kron(r, 3, s))],
    ...(regularize ? { covarianceRegularization: 1, correlationFloor: floor } : {}) } });
}

// Four full states, a weak a priori and two consider parameters (a dynamic
// parameter with sensitivity G, sigma 0.5; a 2 m bias on component 0, sigma 3 m).
export const CONSIDER = { s: [5, 6, 7, 0.05, 0.06, 0.07], p0: [1e6, 1e6, 1e6, 1e3, 1e3, 1e3], g: [3, -1, 2, 0.01, 0.02, -0.03],
  offsets: [[1, 2, 3, 0.01, 0.02, 0.03], [-2, 1, 0, -0.02, 0, 0.01], [3, -3, 1, 0, -0.01, -0.02], [0, 1, -2, 0.03, 0.01, 0]] };
export function considerEnvelope() {
  const { s, p0, offsets } = CONSIDER;
  const observations = offsets.map((o, j) => ({ seconds: 60 * j, kind: 'POSITION_VELOCITY', values: STATE.map((x, i) => x + o[i]), sigmas: s }));
  const apriori = Array(49).fill(0);
  p0.forEach((v, i) => { apriori[i * 8] = v * v; });
  apriori[48] = 0.25;
  return fitEnvelope({ state: STATE, observations, kinds: [1], values: [0.01], options: {
    aprioriCovariance: apriori, parameterConsider: [true],
    measurementParameters: [measurementParameter({ kind: 0, component: 0, observations: [0, 1, 2, 3], value: 2, sigma: 3, consider: true })],
  } });
}

// The Orekit LEO drag case from a moved first guess.
export function leoEnvelope(offset = [0, 0, 0, 0, 0, 0], b0 = LEO.aprioriParameter, options = {}) {
  const envelope = fitRequest(LEO, 'sigmas');
  envelope.request.config.initialState = LEO.apriori.map((x, i) => x + offset[i]);
  envelope.request.batchOptions.parameterValues = [b0];
  Object.assign(envelope.request.batchOptions, options);
  return envelope;
}
export const orekitAnswerer = (hpop) => (queries) => answer(hpop, LEO, queries);

// ---------------------------------------------------------------------------
// The tracking campaign (measurement_parameters.test.mjs states it).
export const F0 = 437e6;
export const DRIFT = 0.5, LAG = 0.82, RADAR_LAG = 0.05;
export function secondsOf(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?Z?$/.exec(iso);
  const day = (Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(2026, 7, 2)) / 86400000;
  return day * 86400 + (+m[4]) * 3600 + (+m[5]) * 60 + (+m[6]) + (m[7] ? Number(`0${m[7]}`) : 0);
}
// Passes of one sensor: runs of records with gaps under 300 s.
function passes(records) {
  const out = [];
  for (const r of [...records].sort((a, b) => secondsOf(a.OB_TIME) - secondsOf(b.OB_TIME))) {
    const last = out.at(-1);
    if (!last || secondsOf(r.OB_TIME) - secondsOf(last.at(-1).OB_TIME) > 300) out.push([r]);
    else last.push(r);
  }
  return out;
}
export async function campaignFit(hpop) {
  const truth = { state: LEO.truth, names: ['DRAG_AREA_OVER_MASS'], values: [0.01] };
  let rfPasses = [], radarPass = null;
  const data = await campaign({
    hpop, truth, hours: 12, seed: 20261010, emitterHz: F0,
    stations: [{ id: 'A', lat: 42.6, lon: -71.5, h: 100 }, { id: 'B', lat: 40.4, lon: -4.2, h: 700 }, { id: 'C', lat: 35.7, lon: 139.7, h: 40 }, { id: 'D', lat: -33.9, lon: 151.2, h: 50 }],
    sensors: [
      { id: 'radar-A', station: 'A', kind: 'RADAR', models: [{ type: 'RANGE', sigma: 5, bias: 12 }] },
      { id: 'radar-B', station: 'B', kind: 'RADAR', models: [{ type: 'RANGE', sigma: 5, bias: -8 }] },
      { id: 'rf-C', station: 'C', kind: 'PASSIVE_RF', models: [{ type: 'DOPPLER', sigma: 20, bias: 300 }] },
      { id: 'rf-D', station: 'D', kind: 'PASSIVE_RF', models: [{ type: 'DOPPLER', sigma: 20, bias: 300 }] },
    ],
    edit: (records) => {
      rfPasses = [...passes(records.rf.filter((r) => r.ID_SENSOR === 'rf-C')), ...passes(records.rf.filter((r) => r.ID_SENSOR === 'rf-D'))];
      [radarPass] = passes(records.radar.filter((r) => r.ID_SENSOR === 'radar-A'));
      assert.ok(rfPasses.length >= 3, `${rfPasses.length} RF passes`);
      const first = secondsOf(rfPasses[0][0].OB_TIME);
      for (const r of rfPasses[0]) r.FREQUENCY += (DRIFT * (secondsOf(r.OB_TIME) - first)) / 1e6;
      for (const r of rfPasses[1]) r.OB_TIME = isoOf({ jdDay: 2461254.5, seconds: secondsOf(r.OB_TIME) - LAG });
      for (const r of radarPass) r.OB_TIME = isoOf({ jdDay: 2461254.5, seconds: secondsOf(r.OB_TIME) - RADAR_LAG });
    },
  });
  // Ranges (m) and one-way Doppler shifts (Hz), sensor position and
  // velocity from association, light time on, Sagnac off (GCRF geometry).
  const observations = [], index = new Map();
  const geometry = (r) => { const g = data.geometry.get(r.ID); return { station_position_m: g.position, station_velocity_mps: g.velocity }; };
  for (const r of data.radar) {
    index.set(r.ID, observations.length);
    observations.push({ seconds: secondsOf(r.OB_TIME), kind: 'RANGE', values: [r.RANGE * 1e3], sigmas: [r.RANGE_UNC * 1e3], fields: { ...geometry(r), flags: 2 } });
  }
  for (const r of data.rf) {
    index.set(r.ID, observations.length);
    observations.push({ seconds: secondsOf(r.OB_TIME), kind: 'DOPPLER', values: [r.FREQUENCY * 1e6 - F0], sigmas: [r.FREQUENCY_UNC * 1e6], fields: { ...geometry(r), frequency_hz: F0, flags: 2 } });
  }
  const ids = (records) => records.map((r) => index.get(r.ID)).sort((a, b) => a - b);
  const parameters = [], expected = [];
  const add = (fields, value) => { parameters.push(measurementParameter({ value: 0, sigma: 0, ...fields })); expected.push(value); };
  add({ kind: 0, component: 0, observations: ids(data.radar.filter((r) => r.ID_SENSOR === 'radar-A')) }, 12);
  add({ kind: 0, component: 0, observations: ids(data.radar.filter((r) => r.ID_SENSOR === 'radar-B')) }, -8);
  rfPasses.forEach((pass) => add({ kind: 0, component: 0, observations: ids(pass) }, 300));
  add({ kind: 1, component: 0, observations: ids(rfPasses[0]) }, DRIFT);
  add({ kind: 2, observations: ids(rfPasses[1]) }, LAG);
  add({ kind: 2, observations: ids(radarPass) }, RADAR_LAG);
  const start = LEO.truth.map((x, i) => x + [400, -300, 200, 0.3, -0.2, 0.1][i]);
  const envelope = fitEnvelope({ state: start, observations, kinds: [sds.prwDynamicParameter.DRAG_AREA_OVER_MASS], values: [0.02],
    options: { parameterLowerBounds: [0], measurementParameters: parameters, maximumIterations: 30 } });
  return { data, envelope, parameters, expected, rfPasses, truthVector: [...LEO.truth, 0.01, ...expected],
    answer: hpopAnswerer(hpop, { names: ['DRAG_AREA_OVER_MASS'] }) };
}

// Parity cases: each scenario's first query round and its complete replay.
export async function batchFitV2Cases() {
  const estimator = await harness('../');
  const hpop = await harness('../../../propagator/hpop/');
  const cases = [];
  const record = async (id, envelope, answerer) => {
    const run = await runFit(estimator, envelope, answerer);
    assert.equal(run.error, undefined, `${id}: ${run.error}`);
    cases.push({ id: `${id}-query`, request: run.requests[0] }, { id: `${id}-complete`, request: run.requests.at(-1) });
  };
  try {
    await record('fit-batch-v2-regularized-block', blockEnvelope(true), identityAnswerer());
    await record('fit-batch-v2-consider', considerEnvelope(), identityAnswerer(CONSIDER.g));
    await record('fit-batch-v2-logarithm-radial-start', leoEnvelope([50e3, 0, 0, 0, 0, 0], 0.02, { parameterTransforms: [1] }), orekitAnswerer(hpop));
    await record('fit-batch-v2-bound-damped-along-track-start', leoEnvelope([0, 20e3, 0, 0, 0, 0], 0.036, { parameterLowerBounds: [0], levenbergMarquardt: true }), orekitAnswerer(hpop));
    const c = await campaignFit(hpop);
    await record('fit-batch-v2-measurement-campaign', c.envelope, c.answer);
  } finally { estimator.destroy?.(); hpop.destroy?.(); }
  return cases;
}

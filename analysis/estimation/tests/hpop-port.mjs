// The inverted propagation port answered by propagator/hpop with every force
// it carries (EGM2008 70 x 70, Sun and Moon from DE440, cannonball radiation
// pressure, NRLMSISE-00 drag with CSSI space weather, IERS 2010 solid tides
// and relativity), through HPOP's own test request builder and its 2026-08
// EOP, kernel and space-weather fixtures. Framing only: every state comes
// from the HPOP WASM. Epoch labels are UTC.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing/browser';
import { requestInputs } from '../../../propagator/hpop/tests/lib/orekitCases.mjs';
import { decodePrw } from '../../../propagator/hpop/tests/lib/prwCodec.mjs';
import { api, encode, pack, typeRef, unpack } from './wire.mjs';

export const FULL_FORCE = { degree: 70, order: 70, thirdBodies: true, srp: true, drag: true, solidTides: true, relativity: 2, spaceWeather: 'cssi' };
export const EPOCH_JD = 2461254.5;  // 2026-08-02T00:00:00 UTC (the HPOP fixtures' month)
const J2000_MS = Date.UTC(2000, 0, 1, 12);
export const isoOf = (epoch) => new Date(J2000_MS + ((epoch.jdDay ?? epoch.jd_day) - 2451545.0) * 86400000 + (epoch.seconds) * 1000).toISOString();

export const module = (relative) => {
  const dir = new URL(relative, import.meta.url);
  return createBrowserModuleHarness({ wasmSource: fs.readFileSync(new URL('dist/isomorphic/module.wasm', dir)), manifest: JSON.parse(fs.readFileSync(new URL('plugin-manifest.json', dir), 'utf8')), surface: 'direct' });
};

// One HPOP execution per query; STM only when asked (SMF, EKF).
export async function answerQueries(hpop, queries, { stm = false, forces = FULL_FORCE } = {}) {
  const A = api();
  const answers = [];
  for (const query of queries) {
    const seed = query.seed.state;
    const c = { ...forces, epochUtc: isoOf(query.seed.epoch), samples: [[0, ...seed], [1, 0, 0, 0, 0, 0, 0, isoOf(query.targetEpoch)]] };
    const inputs = requestInputs(c, { edit: (exec) => { if (stm) Object.assign(exec, { INCLUDE_STM: true }); } });
    const response = await hpop.invoke({ methodId: 'invoke', inputs });
    assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
    const s = decodePrw(response.outputs.find((o) => o.portId === 'response').payload).EXECUTION_RESULT.SAMPLES[0];
    const p = s.STATE.STATE.POSITION, v = s.STATE.STATE.VELOCITY;
    const m = s.STM ? s.STM.VALUES : null, n = s.STM ? s.STM.DIMENSION : 6;
    const matrix = [];
    for (let i = 0; i < 6; ++i) for (let j = 0; j < 6; ++j) matrix.push(m ? m[i * n + j] : 0);
    answers.push(Object.assign(new A.PropagationAnswerT(), {
      query,
      sample: Object.assign(new A.EstimationPropagatorSampleT(), { epoch: query.targetEpoch, state: [p.X, p.Y, p.Z, v.X, v.Y, v.Z], stm: matrix }),
    }));
  }
  return answers;
}

// Runs run_estimation to completion, answering every round through HPOP.
// `rounds` collects each invocation (parity cases). Returns the result.
export async function runToCompletion(estimator, hpop, envelope, { stm = false, rounds = [], limit = 2000 } = {}) {
  for (let round = 0; ; ++round) {
    const request = { methodId: 'run_estimation', inputs: [{ portId: 'request', typeRef, payload: pack(envelope) }, { portId: 'propagator_samples', typeRef, payload: encode({ propagator_samples: [] }) }] };
    rounds.push(request);
    const response = await estimator.invoke(request);
    assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
    const result = unpack(response.outputs.find((o) => o.portId === 'result').payload).result;
    if (result.status !== 1) return result;
    envelope.propagationAnswers.push(...await answerQueries(hpop, result.propagationRequests, { stm }));
    assert.ok(round < limit, 'continuation does not finish');
  }
}

// HPOP truth samples (state and identity STM) at the given epochs from one
// initial state at EPOCH_JD.
export async function truthSamples(hpop, state, seconds, forces = FULL_FORCE) {
  const c = { ...forces, epochUtc: isoOf({ jdDay: EPOCH_JD, seconds: 0 }), samples: [[0, ...state], ...seconds.map((t) => [t, 0, 0, 0, 0, 0, 0, isoOf({ jdDay: EPOCH_JD, seconds: t })])] };
  const response = await hpop.invoke({ methodId: 'invoke', inputs: requestInputs(c) });
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  const identity = Array.from({ length: 36 }, (_, i) => (i % 7 === 0 ? 1 : 0));
  return decodePrw(response.outputs.find((o) => o.portId === 'response').payload).EXECUTION_RESULT.SAMPLES.map((s, k) => {
    const p = s.STATE.STATE.POSITION, v = s.STATE.STATE.VELOCITY;
    return { epoch: { jd_day: EPOCH_JD, seconds: seconds[k] }, state: [p.X, p.Y, p.Z, v.X, v.Y, v.Z], stm: identity };
  });
}

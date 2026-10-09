// Samples on the variational path are visited in time order, each span
// integrated once (prw_execution.cpp, evaluateInOrder), and adaptive steps end
// on the Earth's shadow boundaries (lib/shadow_events.h).
//
// (1) A request with unordered, repeated and backward samples returns each in
// the request's order, equal to what a request for that epoch alone returns,
// to the integration tolerance (the sequence restarts its steps at every
// sample; a single request does not), and the covariance carried span by span
// is P0 carried by the returned STM. (2) The plain path, with 300 s steps,
// agrees with the variational path through LEO penumbrae to the integration
// tolerance (before the boundaries were located it was 21 cm off). (3) A
// backward request on a forward-only integrator is refused rather than
// answered with the initial state.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';
import { REFERENCE, isoUtc, requestInputs } from './lib/orekitCases.mjs';
import { decodePrw, makeTable, sds } from './lib/prwCodec.mjs';

const WASM = new URL('../dist/isomorphic/module.wasm', import.meta.url);
const MANIFEST = new URL('../plugin-manifest.json', import.meta.url);
const harness = () => createBrowserModuleHarness({ wasmSource: fs.readFileSync(WASM), manifest: JSON.parse(fs.readFileSync(MANIFEST, 'utf8')), surface: 'direct' });
const result = (response) => {
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  return decodePrw(response.outputs.find((o) => o.portId === 'response').payload).EXECUTION_RESULT;
};
// LEO400 with the 20x20 field, Sun, Moon, radiation pressure and drag: a
// penumbra crossing every 45 minutes.
const C = REFERENCE.cases.find((c) => c.orbit === 'LEO400' && c.forces.startsWith('F6'));
const at = (hours) => new Date(Date.parse(`${REFERENCE.epochUtc}Z`) + hours * 3600e3).toISOString().replace('Z', '');
const position = (sample) => { const p = sample.STATE.STATE.POSITION; return [p.X, p.Y, p.Z]; };
const distance = (a, b) => Math.hypot(...a.map((x, i) => x - b[i]));
const relative = (a, b) => Math.max(...a.map((x, i) => Math.abs(x - b[i]))) / Math.max(...b.map(Math.abs));
const P0 = [1e6, 1e6, 1e6, 1, 1, 1].flatMap((v, i) => Array.from({ length: 6 }, (_, j) => (i === j ? v : 0)));  // 1 km, 1 m/s
const mul = (a, b, n) => Array.from({ length: n * n }, (_, k) => { let v = 0; const i = Math.floor(k / n), j = k % n; for (let m = 0; m < n; ++m) v += a[i * n + m] * b[m * n + j]; return v; });
const transpose = (a, n) => Array.from({ length: n * n }, (_, k) => a[(k % n) * n + Math.floor(k / n)]);

test('samples in any order equal requests for each epoch alone', async (t) => {
  const h = await harness(); t.after(() => h.destroy());
  const hours = [12, 3, 24, -2, 3, -0.5];
  const many = result(await h.invoke({ methodId: 'invoke', inputs: requestInputs(C, { edit: (exec) => {
    exec.SAMPLE_EPOCHS = hours.map((x) => isoUtc(at(x))); exec.TARGET_EPOCH = isoUtc(at(6));
    exec.INCLUDE_STM = true; exec.INITIAL_COVARIANCE = makeTable('PRWStateMatrix', { DIMENSION: 6, VALUES: P0 });
  } }) }));
  assert.equal(many.SAMPLES.length, hours.length);
  for (const [k, x] of [[-1, 6], ...hours.entries()]) {
    const sample = k < 0 ? many.FINAL_SAMPLE : many.SAMPLES[k];
    assert.equal(sample.STATE.STATE.EPOCH.slice(0, 13), new Date(Date.parse(`${at(x)}Z`) + 69.184e3).toISOString().slice(0, 13), `sample ${k} is in the request's order`);
    const alone = result(await h.invoke({ methodId: 'invoke', inputs: requestInputs(C, { edit: (exec) => {
      exec.SAMPLE_EPOCHS = [isoUtc(at(x))]; exec.TARGET_EPOCH = isoUtc(at(x)); exec.INCLUDE_STM = true;
    } }) })).FINAL_SAMPLE;
    const gap = distance(position(sample), position(alone));
    t.diagnostic(`${x} h: ${gap.toExponential(2)} m from the epoch alone, STM ${relative([...sample.STM.VALUES], [...alone.STM.VALUES]).toExponential(1)}`);
    assert.ok(gap <= 0.05, `${x} h: ${gap} m`);
    assert.ok(relative([...sample.STM.VALUES], [...alone.STM.VALUES]) <= 1e-5, `${x} h: STM`);
    const phi = [...sample.STM.VALUES], p = [...sample.COVARIANCE.VALUES], expected = mul(mul(phi, P0, 6), transpose(phi, 6), 6);
    assert.ok(relative(p, expected) <= 1e-9, `${x} h: P is Phi P0 Phi^T`);
  }
  const forward = [3, 6, 12, 24].map((x) => (x === 6 ? many.FINAL_SAMPLE : many.SAMPLES[hours.indexOf(x)]).ACCEPTED_STEPS).map(Number);
  assert.deepEqual([...forward].sort((a, b) => a - b), forward, 'accepted steps accumulate along the arc');
});

test('the plain path steps across penumbrae at 300 s and agrees with the variational path', async (t) => {
  const h = await harness(); t.after(() => h.destroy());
  const plain = result(await h.invoke({ methodId: 'invoke', inputs: requestInputs(C, { maxStep: 300, edit: (exec) => { exec.SAMPLE_EPOCHS = []; } }) })).FINAL_SAMPLE;
  const fine = result(await h.invoke({ methodId: 'invoke', inputs: requestInputs(C, { tolerance: 1e-14, maxStep: 10, edit: (exec) => { exec.SAMPLE_EPOCHS = [exec.TARGET_EPOCH]; } }) })).FINAL_SAMPLE;
  const gap = distance(position(plain), position(fine));
  t.diagnostic(`plain at 300 s against variational at 10 s, 1e-14: ${gap.toExponential(2)} m after 24 h; ${plain.ACCEPTED_STEPS} steps`);
  assert.ok(gap <= 0.03, `${gap} m`);
});

test('a backward request on a forward-only integrator is refused', async (t) => {
  const h = await harness(); t.after(() => h.destroy());
  for (const method of ['RK4', 'RKDP87', 'BS']) {
    const response = await h.invoke({ methodId: 'invoke', inputs: requestInputs(C, { edit: (exec) => {
      exec.SAMPLE_EPOCHS = []; exec.TARGET_EPOCH = isoUtc(at(-1));
      exec.INTEGRATOR.ALGORITHM = sds.prwSolverAlgorithm[method]; exec.INTEGRATOR.INITIAL_STEP_SECONDS = 10;
    } }) });
    assert.notEqual(response.statusCode, 0, `${method} answered a backward request`);
    assert.match(response.errorMessage, /did not reach the target epoch/, method);
  }
});

// (d) The module's minimum-volume enclosing ellipsoid (evaluate_teag, WASM)
// against an independent numpy implementation run locally
// (tests/fixtures/mvee_numpy_reference.py; its output is the committed
// fixture). Nine clouds in 2 to 6 dimensions, 13 to 120 points, Gaussian,
// uniform and skewed, scaled over three orders of magnitude and offset by
// ~1e3. Both solvers stop at a duality gap of 1e-12 (the module at 1e-12
// here); the MVEE is unique, so they must agree to the precision that gap
// allows. Measured: about 1e-12; required: log det(S) / 2, every shape entry
// relative to sqrt(S_ii S_jj) and every centre coordinate relative to the
// largest semi-axis within 1e-9.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing/browser';
import { encode, typeRef, unpack } from './wire.mjs';

const reference = JSON.parse(fs.readFileSync(new URL('./fixtures/mvee-numpy-reference.json', import.meta.url), 'utf8'));

test('(d) MVEE agrees with the independent numpy implementation', async () => {
  const harness = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(new URL('../dist/isomorphic/module.wasm', import.meta.url)), surface: 'direct' });
  try {
    for (const c of reference.cases) {
      const response = await harness.invoke({ methodId: 'evaluate_teag', inputs: [{ portId: 'request', typeRef,
        payload: encode({ teag_request: { dimension: c.dimension, points: c.points, mvee: true, mvee_tolerance: 1e-12 } }) }] });
      assert.equal(response.statusCode, 0, response.errorMessage);
      const r = unpack(response.outputs[0].payload).teagResult, d = c.dimension;
      let shape = 0, center = 0;
      const axis = Math.sqrt(Math.max(...Array.from({ length: d }, (_, i) => c.shape[i * d + i])));
      for (let i = 0; i < d; ++i) {
        center = Math.max(center, Math.abs(r.mveeCenter[i] - c.center[i]) / axis);
        for (let j = 0; j < d; ++j) shape = Math.max(shape, Math.abs(r.mveeShape[i * d + j] - c.shape[i * d + j]) / Math.sqrt(c.shape[i * d + i] * c.shape[j * d + j]));
      }
      const logDet = Math.abs(r.mveeLogVolume - (d / 2) * Math.log(Math.PI) + lgammaHalf(d) - 0.5 * c.log_det);
      console.log(`MVEE ${d}-D ${c.kind} n=${c.points.length / d}: shape ${shape.toExponential(2)}, centre ${center.toExponential(2)}, half log det ${logDet.toExponential(2)}, module iterations ${r.mveeIterations}`);
      assert.ok(shape <= 1e-9 && center <= 1e-9 && logDet <= 1e-9, JSON.stringify({ shape, center, logDet }));
    }
  } finally { harness.destroy?.(); harness.dispose?.(); }
});

// log Gamma(d/2 + 1) for the unit-ball volume c_d = pi^(d/2) / Gamma(d/2 + 1):
// (d/2)! for even d; sqrt(pi) prod_{j=1..m} (j - 1/2), m = (d + 1)/2, for odd d.
function lgammaHalf(d) {
  let v = 0;
  if (d % 2 === 0) { for (let j = 2; j <= d / 2; ++j) v += Math.log(j); return v; }
  v = 0.5 * Math.log(Math.PI);
  for (let j = 1; j <= (d + 1) / 2; ++j) v += Math.log(j - 0.5);
  return v;
}

// VCM parity on the execution path (PRW SDS 1.240.0): dynamic parameters in
// the STM and covariance, and EME2000 ("J2K") states.
//
// The Jacobians themselves are checked against Orekit in
// orekit_reference.test.mjs (C1 cases). Here: (1) the covariance HPOP returns
// with parameters is P0 carried by the STM it returns, [[Phi, S], [0, I]],
// with the parameter block unchanged; (2) finite-difference parameter columns
// agree with the analytic ones to their differencing accuracy; (3) a request
// in EME2000 returns the GCRF answer rotated by the IAU 2000 frame bias
// (state, STM and covariance); (4) malformed parameter requests are refused.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';
import { REFERENCE, requestInputs } from './lib/orekitCases.mjs';
import { decodePrw, makeTable, sds } from './lib/prwCodec.mjs';

const WASM = new URL('../dist/isomorphic/module.wasm', import.meta.url);
const MANIFEST = new URL('../plugin-manifest.json', import.meta.url);
const harness = () => createBrowserModuleHarness({ wasmSource: fs.readFileSync(WASM), manifest: JSON.parse(fs.readFileSync(MANIFEST, 'utf8')), surface: 'direct' });
// GPS with field, Sun, Moon, radiation pressure and in-track thrust, two
// hours (two samples): AGOM and T as parameters.
const C = REFERENCE.cases.find((c) => c.orbit === 'GPS' && c.forces.startsWith('C1'));
const shorten = (exec) => { exec.SAMPLE_EPOCHS = exec.SAMPLE_EPOCHS.slice(0, 2); exec.TARGET_EPOCH = exec.SAMPLE_EPOCHS[1]; };
const result = (response) => {
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  return decodePrw(response.outputs.find((o) => o.portId === 'response').payload).EXECUTION_RESULT;
};
const mul = (a, b, n) => Array.from({ length: n * n }, (_, k) => { let v = 0; const i = Math.floor(k / n), j = k % n; for (let m = 0; m < n; ++m) v += a[i * n + m] * b[m * n + j]; return v; });
const transpose = (a, n) => Array.from({ length: n * n }, (_, k) => a[(k % n) * n + Math.floor(k / n)]);
// SI: 1 m, 1 mm/s, AGOM 1e-3 m^2/kg (with a position-AGOM correlation), T 1e-9 m/s^2.
const P0 = (() => {
  const n = 8, p = Array(n * n).fill(0), d = [1, 1, 1, 1e-6, 1e-6, 1e-6, 1e-6, 1e-18];
  d.forEach((v, i) => { p[i * n + i] = v; });
  p[0 * n + 6] = p[6 * n + 0] = 0.5e-3;
  return p;
});

test('covariance with parameters is P0 carried by the returned augmented STM', async (t) => {
  const h = await harness(); t.after(() => h.destroy());
  const n = 8, p0 = P0();
  const r = result(await h.invoke({ methodId: 'invoke', inputs: requestInputs(C, { edit: (exec) => {
    shorten(exec); exec.INITIAL_COVARIANCE = makeTable('PRWStateMatrix', { DIMENSION: n, VALUES: p0 });
  } }) }));
  assert.deepEqual([...r.DYNAMIC_PARAMETERS], C.parameters.map((p) => sds.prwDynamicParameter[p]));
  for (const s of r.SAMPLES) {
    const phi = [...s.STM.VALUES], p = [...s.COVARIANCE.VALUES];
    assert.equal(s.STM.DIMENSION, n); assert.equal(s.COVARIANCE.DIMENSION, n);
    for (let k = 0; k < 2; ++k) for (let j = 0; j < n; ++j) assert.equal(phi[(6 + k) * n + j], j === 6 + k ? 1 : 0, 'parameter rows are the identity');
    const expected = mul(mul(phi, p0, n), transpose(phi, n), n);
    const scale = Math.max(...expected.map(Math.abs));
    const gap = Math.max(...p.map((v, i) => Math.abs(v - expected[i])));
    assert.ok(gap <= 1e-9 * scale, `P(t) differs from Phi P0 Phi^T by ${gap} of ${scale}`);
    for (let i = 6; i < n; ++i) for (let j = 6; j < n; ++j) assert.ok(Math.abs(p[i * n + j] - p0[i * n + j]) <= 1e-12 * Math.abs(p0[i * n + i]), 'parameter block unchanged');
  }
});

test('finite-difference parameter columns agree with the analytic ones', async (t) => {
  const h = await harness(); t.after(() => h.destroy());
  const run = async (technique) => result(await h.invoke({ methodId: 'invoke', inputs: requestInputs(C, { technique, edit: shorten }) })).SAMPLES.at(-1).STM.VALUES;
  const a = await run('ANALYTIC'), f = await run('FINITE_DIFFERENCE'), n = 8;
  for (let k = 0; k < 2; ++k) {
    const col = (m) => [0, 1, 2].map((i) => m[i * n + 6 + k]);
    const ca = col(a), cf = col(f), rel = Math.hypot(...ca.map((x, i) => x - cf[i])) / Math.hypot(...ca);
    t.diagnostic(`${C.parameters[k]}: finite difference vs analytic ${rel.toExponential(2)}`);
    assert.ok(rel < 1e-3, `${C.parameters[k]} column: ${rel}`);
  }
});

// IAU 2000 frame bias GCRF -> mean J2000 (IERS Conventions 2003 eq. 28; ERFA
// eraBi00/eraBp00): Rx(-deps) Ry(dpsi sin eps0) Rz(dra0).
const bias = (() => {
  const as = Math.PI / 648000, dpsi = -0.041775 * as, deps = -0.0068192 * as, dra = -0.0146 * as, eps0 = 84381.448 * as;
  const rz = (a) => [[Math.cos(a), Math.sin(a), 0], [-Math.sin(a), Math.cos(a), 0], [0, 0, 1]];
  const ry = (a) => [[Math.cos(a), 0, -Math.sin(a)], [0, 1, 0], [Math.sin(a), 0, Math.cos(a)]];
  const rx = (a) => [[1, 0, 0], [0, Math.cos(a), Math.sin(a)], [0, -Math.sin(a), Math.cos(a)]];
  const m3 = (a, b) => a.map((row, i) => b[0].map((_, j) => row.reduce((v, x, k) => v + x * b[k][j], 0)));
  return m3(rx(-deps), m3(ry(dpsi * Math.sin(eps0)), rz(dra)));
})();
const rotate = (b, v) => b.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);

test('an EME2000 request is the GCRF answer rotated by the frame bias', async (t) => {
  const h = await harness(); t.after(() => h.destroy());
  const n = 8, p0 = P0();
  const gcrf = result(await h.invoke({ methodId: 'invoke', inputs: requestInputs(C, { edit: (exec) => {
    shorten(exec); exec.INITIAL_COVARIANCE = makeTable('PRWStateMatrix', { DIMENSION: n, VALUES: p0 });
  } }) }));
  const R = Array(n * n).fill(0);
  for (let i = 0; i < n; ++i) R[i * n + i] = 1;
  for (const o of [0, 3]) for (let i = 0; i < 3; ++i) for (let j = 0; j < 3; ++j) R[(o + i) * n + o + j] = bias[i][j];
  const p0e = mul(mul(R, p0, n), transpose(R, n), n);
  const eme = result(await h.invoke({ methodId: 'invoke', inputs: requestInputs({ ...C, frame: 'EME2000' }, { edit: (exec) => {
    shorten(exec);
    const s = exec.INITIAL.STATE, r = rotate(bias, [s.POSITION.X, s.POSITION.Y, s.POSITION.Z]), v = rotate(bias, [s.VELOCITY.X, s.VELOCITY.Y, s.VELOCITY.Z]);
    s.POSITION = makeTable('FRMVector3', { X: r[0], Y: r[1], Z: r[2] }); s.VELOCITY = makeTable('FRMVector3', { X: v[0], Y: v[1], Z: v[2] });
    exec.INITIAL_COVARIANCE = makeTable('PRWStateMatrix', { DIMENSION: n, VALUES: p0e });
  } }) }));
  const g = gcrf.SAMPLES.at(-1), e = eme.SAMPLES.at(-1);
  const pos = (s) => [s.STATE.STATE.POSITION.X, s.STATE.STATE.POSITION.Y, s.STATE.STATE.POSITION.Z];
  const expected = rotate(bias, pos(g)), gap = Math.hypot(...pos(e).map((x, i) => x - expected[i]));
  t.diagnostic(`state ${gap.toExponential(2)} m`);
  assert.ok(gap < 1e-6, `EME2000 position differs from the rotated GCRF one by ${gap} m`);
  for (const [field, tol] of [['STM', 1e-9], ['COVARIANCE', 1e-9]]) {
    const want = mul(mul(R, [...g[field].VALUES], n), transpose(R, n), n), got = [...e[field].VALUES];
    const scale = Math.max(...want.map(Math.abs)), d = Math.max(...got.map((x, i) => Math.abs(x - want[i])));
    assert.ok(d <= tol * scale, `${field}: ${d} of ${scale}`);
  }
});

test('malformed parameter requests are refused', async (t) => {
  const h = await harness(); t.after(() => h.destroy());
  const refuse = async (edit, pattern) => {
    const response = await h.invoke({ methodId: 'invoke', inputs: requestInputs(C, { edit: (exec) => { shorten(exec); edit(exec); } }) });
    assert.notEqual(response.statusCode, 0);
    assert.match(`${response.errorCode}: ${response.errorMessage}`, pattern);
  };
  const P = sds.prwDynamicParameter;
  await refuse((exec) => { exec.DYNAMIC_PARAMETERS = [P.SRP_AREA_OVER_MASS, P.SRP_AREA_OVER_MASS]; }, /must not repeat/);
  await refuse((exec) => { exec.DYNAMIC_PARAMETERS = [P.DRAG_AREA_OVER_MASS]; }, /Drag parameters need drag/);
  await refuse((exec) => { exec.INITIAL_COVARIANCE = makeTable('PRWStateMatrix', { DIMENSION: 6, VALUES: Array(36).fill(0) }); }, /six plus their number/);
});

// The TEAG primitives of evaluate_teag, end to end through the WASM artifact,
// against independent references (docs/espf-spec.md, section T):
// (a) the closed forms of Jah 2026, "The ESPF as a Tropical Hamilton-Jacobi
//     System" (preprints 202603.2110 v1), section 4, eqs. 8-14;
// (c) the algebra of possibility theory: idempotence and Popperian
//     monotonicity of the conjunctive update (TEAG Proposition 3.12), the
//     alpha-cut intersection (TEAG Proposition 3.8), N(A) = 1 - Pi(A^c),
//     maxitivity; and the documented counterexample to monotonicity after
//     max-rescaling (TEAG eq. 1);
// (d) the minimum-volume enclosing ellipsoid against analytic cases, Smolyak
//     Clenshaw-Curtis counts, and the Minkowski outer bound's containment.
// The MVEE against an independent numpy implementation is mvee.test.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing/browser';
import { encode, typeRef, unpack } from './wire.mjs';

const harness = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(new URL('../dist/isomorphic/module.wasm', import.meta.url)), surface: 'direct' });
test.after(() => { harness.destroy?.(); harness.dispose?.(); });

export const teagInvocation = (teag_request) => ({ methodId: 'evaluate_teag', inputs: [{ portId: 'request', typeRef, payload: encode({ teag_request }) }] });
async function teag(request) {
  const response = await harness.invoke(teagInvocation(request));
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  return unpack(response.outputs.find((o) => o.portId === 'result').payload).teagResult;
}

// ---------------------------------------------------------------- (a) ----
// ESPF-HJ section 4: Phi0(h) = (h - h0)^2 / (2 s0^2) (eq. 8), PhiS(h) =
// (h - y)^2 / (2 sn^2) (eq. 9); the front roots h-, h+ (eqs. 11, 12), the
// well width W (eq. 13) and the medioid (eq. 14).
const closedForm = ({ h0, y, s0, sn }) => ({
  inner: (sn * h0 + s0 * y) / (sn + s0),
  outer: (sn * h0 - s0 * y) / (sn - s0),
  width: (2 * sn * s0 * Math.abs(h0 - y)) / (sn * sn - s0 * s0),
  medioid: (sn * sn * h0 - s0 * s0 * y) / (sn * sn - s0 * s0),
});
const grid = (from, to, step) => Array.from({ length: Math.round((to - from) / step) + 1 }, (_, i) => from + i * step);
async function scalar(p, h) {
  const prior = h.map((x) => (x - p.h0) ** 2 / (2 * p.s0 ** 2));
  const psi = h.map((x) => (x - p.y) ** 2 / (2 * p.sn ** 2));
  const fields = await teag({ dimension: 1, points: h, prior_impossibility: prior, surprisal: psi });
  // The surviving well {Phi0 <= PhiS} (section 4.3, sn > s0): zones 0 and +1.
  const well = fields.zones.map((z, i) => (z >= 0 ? i : -1)).filter((i) => i >= 0);
  const medoid = await teag({ dimension: 1, points: h, subset: well, metric_shape: [1] });
  return { fields, well, medoid };
}

test('(a) scalar active front, well width and medioid equal the closed forms exactly on dyadic cases', async () => {
  for (const p of [{ h0: 0, y: 3, s0: 1, sn: 2, step: 0.25, from: -6, to: 6 }, { h0: 1, y: -2, s0: 0.5, sn: 1.5, step: 0.125, from: -4, to: 6 }]) {
    const h = grid(p.from, p.to, p.step), cf = closedForm(p);
    const { fields, well, medoid } = await scalar(p, h);
    const front = fields.zones.map((z, i) => (z === 0 ? h[i] : null)).filter((v) => v !== null);
    assert.deepEqual(front, [Math.min(cf.inner, cf.outer), Math.max(cf.inner, cf.outer)], JSON.stringify({ front, cf }));
    assert.equal(h[well.at(-1)] - h[well[0]], cf.width);
    assert.equal(h[medoid.medoid], cf.medioid);
    assert.equal(medoid.medoidRadius, cf.width / 2);
    // The posterior is the max-plus envelope, its minimum the inner root.
    fields.posteriorImpossibility.forEach((v, i) => assert.equal(v, Math.max((h[i] - p.h0) ** 2 / (2 * p.s0 ** 2), (h[i] - p.y) ** 2 / (2 * p.sn ** 2))));
    const argmin = fields.posteriorImpossibility.indexOf(Math.min(...fields.posteriorImpossibility));
    assert.equal(h[argmin], cf.inner);
    assert.equal(fields.normalizationShift, fields.posteriorImpossibility[argmin]);
  }
});

test('(a) scalar closed forms on a non-dyadic case, to the grid resolution', async () => {
  const p = { h0: 0.3, y: 2.1, s0: 0.7, sn: 1.9 }, step = 1 / 512;
  const h = grid(-8, 8, step), cf = closedForm(p);
  const { fields, well, medoid } = await scalar(p, h);
  const changes = [];
  for (let i = 1; i < h.length; ++i) if (fields.zones[i] !== fields.zones[i - 1]) changes.push((h[i] + h[i - 1]) / 2);
  const roots = [Math.min(cf.inner, cf.outer), Math.max(cf.inner, cf.outer)];
  assert.equal(changes.length, 2);
  changes.forEach((c, k) => assert.ok(Math.abs(c - roots[k]) <= step, JSON.stringify({ c, root: roots[k] })));
  assert.ok(Math.abs(h[well.at(-1)] - h[well[0]] - cf.width) <= 2 * step);
  assert.ok(Math.abs(h[medoid.medoid] - cf.medioid) <= step);
  // sn = s0: one root only; the outer root escapes to infinity (section 4.2).
  const equal = await scalar({ h0: 0.3, y: 2.1, s0: 1.3, sn: 1.3 }, h);
  let flips = 0;
  for (let i = 1; i < h.length; ++i) if (equal.fields.zones[i] !== equal.fields.zones[i - 1] && equal.fields.zones[i] !== 0 && equal.fields.zones[i - 1] !== 0) ++flips;
  assert.ok(flips <= 1);
});

// ---------------------------------------------------------------- (c) ----
const random = (seed) => () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

test('(c) the conjunctive update is idempotent and Popperian-monotone; rescaling is not monotone', async () => {
  const r = random(20261009);
  for (let trial = 0; trial < 20; ++trial) {
    const n = 40, prior = Array.from({ length: n }, () => (r() < 0.2 ? 0 : 5 * r())), psi = Array.from({ length: n }, () => 6 * r());
    const once = await teag({ prior_impossibility: prior, surprisal: psi });
    const twice = await teag({ prior_impossibility: once.posteriorImpossibility, surprisal: psi });
    assert.deepEqual(twice.posteriorImpossibility, once.posteriorImpossibility);
    once.posteriorImpossibility.forEach((v, i) => assert.ok(v >= prior[i] && v >= psi[i]));
  }
  // Max-rescaling (TEAG eq. 1) can raise a possibility above its prior when
  // the evidence conflicts with every hypothesis (docs/espf-spec.md G1).
  const conflict = await teag({ prior_impossibility: [0, 1], surprisal: [2, 1.5] });
  assert.deepEqual(conflict.posteriorImpossibility, [2, 1.5]);
  assert.equal(conflict.normalizationShift, 1.5);
  assert.deepEqual(conflict.rescaledImpossibility, [0.5, 0]);
  assert.ok(conflict.rescaledImpossibility[1] < 1, 'possibility rose from e^-1 to 1 under rescaling');
});

test('(c) alpha-cut intersection, necessity duality and maxitivity', async () => {
  const r = random(7);
  for (let trial = 0; trial < 20; ++trial) {
    const n = 30, prior = Array.from({ length: n }, () => (r() < 0.25 ? 0 : 4 * r())), psi = Array.from({ length: n }, () => 4 * r());
    const alphas = [0.9, 0.5, 0.2, 0.05];
    const post = await teag({ prior_impossibility: prior, surprisal: psi });
    // Cuts of the unnormalized posterior, the prior and the compatibility.
    const [cp, cpr, cps] = await Promise.all([post.posteriorImpossibility, prior, psi].map((f) => teag({ prior_impossibility: f, alpha_levels: alphas })));
    const cuts = (res) => alphas.map((_, k) => res.alphaCuts.slice(res.alphaCutOffsets[k], k + 1 < alphas.length ? res.alphaCutOffsets[k + 1] : undefined));
    const [P, A, E] = [cp, cpr, cps].map(cuts);
    alphas.forEach((_, k) => assert.deepEqual(P[k], A[k].filter((i) => E[k].includes(i))));
    // Events on the rescaled posterior.
    const masks = [], m = 6;
    for (let e = 0; e < m; ++e) masks.push(Array.from({ length: n }, () => (r() < 0.4 ? 1 : 0)));
    const complement = masks.map((mk) => mk.map((v) => 1 - v));
    const union = masks[0].map((v, i) => v | masks[1][i]), inter = masks[0].map((v, i) => v & masks[1][i]);
    const all = [...masks, ...complement, union, inter];
    const ev = await teag({ prior_impossibility: prior, surprisal: psi, events: all.flat(), event_count: all.length });
    for (let e = 0; e < m; ++e) {
      assert.equal(ev.eventNecessity[e], 1 - ev.eventPossibility[m + e]);
      assert.ok(ev.eventNecessity[e] <= ev.eventPossibility[e]);
    }
    assert.equal(ev.eventPossibility[2 * m], Math.max(ev.eventPossibility[0], ev.eventPossibility[1]));
    assert.equal(ev.eventNecessity[2 * m + 1], Math.min(ev.eventNecessity[0], ev.eventNecessity[1]));
    assert.equal(Math.max(...ev.eventPossibility.slice(0, m).map((v, e) => Math.max(v, ev.eventPossibility[m + e]))), 1);
  }
});

test('(c) Choquet surprisal, information content and the PCRB basin follow their definitions', async () => {
  // TEAG Definition 4.4: S = sup_i min(q_i / 2, pi_i); I = 1 - exp(-S).
  const q = [0.2, 3.0, 1.0, 1.4], prior = [0, Math.log(4), Math.log(2), 0];
  const res = await teag({ dimension: 1, prior_impossibility: prior, whitened_squared_innovation: q, effective_dimension: 6 });
  assert.equal(res.choquetSurprisal, 0.7);  // min(0.7, 1) at i = 3; the others give 0.1, 0.25, about 0.5
  assert.equal(res.information, 1 - Math.exp(-0.7));
  // TEAG Definition 3.15 with r- = 1: r* = ((1 - I) M / M_surv)^(1/n).
  const unit = res.rescaledImpossibility.filter((v) => v <= 0.5).length;
  assert.equal(res.basinUnitSurvivors, unit);
  assert.ok(Math.abs(res.basinRadius - ((1 - res.information) * 4 / unit) ** (1 / 6)) < 1e-14);
  assert.equal(res.basinThreshold, 0.5 * res.basinRadius ** 2);
  assert.ok(Math.abs(res.pcrbFloor - 3 * Math.log(1 - res.information)) < 1e-15);
});

// ---------------------------------------------------------------- (d) ----
const mvee = (dimension, points, extra = {}) => teag({ dimension, points: points.flat(), mvee: true, mvee_tolerance: 1e-10, ...extra });
const close = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${what}: ${a} vs ${b}`);

test('(d) MVEE of analytic point sets', async () => {
  // Box vertices: the MVEE of the cube's vertices is the ball through them
  // (symmetry), so a box with half-sides a_i has shape diag(n a_i^2).
  const a = [3, 0.5, 2];
  const box = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) box.push([sx * a[0] + 1, sy * a[1] - 2, sz * a[2] + 0.5]);
  const b = await mvee(3, box);
  [1, -2, 0.5].forEach((c, i) => close(b.mveeCenter[i], c, 1e-8, 'box centre'));
  for (let i = 0; i < 3; ++i) for (let j = 0; j < 3; ++j) close(b.mveeShape[i * 3 + j], i === j ? 3 * a[i] * a[i] : 0, 1e-7, `box shape ${i}${j}`);
  // Regular simplex: the circumscribed ball (radius 1 for unit vertices).
  const n = 4, simplex = [];
  for (let k = 0; k <= n; ++k) simplex.push(Array.from({ length: n + 1 }, (_, i) => (i === k ? 1 : 0)));
  // Project the standard simplex in R^(n+1) to R^n: orthonormal basis of the
  // hyperplane sum x = 1 by Gram-Schmidt of e_i - e_(n+1)... use the explicit
  // vertices instead: v_k = sqrt((n+1)/n) (e_k - c) restricted to n coordinates.
  const vertices = simplex.map((v) => v.map((x) => x - 1 / (n + 1)));
  const basis = [];
  for (let k = 0; k < n; ++k) {
    let u = Array.from({ length: n + 1 }, (_, i) => (i === k ? 1 : 0) - (i === n ? 1 : 0));
    for (const w of basis) { const d = u.reduce((s, x, i) => s + x * w[i], 0); u = u.map((x, i) => x - d * w[i]); }
    const l = Math.hypot(...u); basis.push(u.map((x) => x / l));
  }
  const pts = vertices.map((v) => basis.map((w) => v.reduce((s, x, i) => s + x * w[i], 0)));
  const r2 = pts[0].reduce((s, x) => s + x * x, 0);
  const sm = await mvee(n, pts);
  for (let i = 0; i < n; ++i) for (let j = 0; j < n; ++j) close(sm.mveeShape[i * n + j], i === j ? r2 : 0, 1e-7, 'simplex');
  // Points on a rotated ellipse: the ellipse itself.
  const th = 0.7, A = 5, B = 1.5, ell = [];
  for (let k = 0; k < 64; ++k) { const t = 2 * Math.PI * k / 64; const x = A * Math.cos(t), y = B * Math.sin(t); ell.push([Math.cos(th) * x - Math.sin(th) * y, Math.sin(th) * x + Math.cos(th) * y]); }
  const e = await mvee(2, ell);
  const S = [[A * A * Math.cos(th) ** 2 + B * B * Math.sin(th) ** 2, (A * A - B * B) * Math.sin(th) * Math.cos(th)], [(A * A - B * B) * Math.sin(th) * Math.cos(th), A * A * Math.sin(th) ** 2 + B * B * Math.cos(th) ** 2]];
  for (let i = 0; i < 2; ++i) for (let j = 0; j < 2; ++j) close(e.mveeShape[i * 2 + j], S[i][j], 1e-7, 'ellipse');
  close(e.mveeLogVolume, Math.log(Math.PI * A * B), 1e-8, 'ellipse log volume');
  // Every point inside after the final scaling (containment is enforced).
  assert.ok(e.mveeGap <= 1e-10);
});

test('(d) Smolyak Clenshaw-Curtis grids: counts, nodes and their MVEE', async () => {
  const count = async (n, level) => (await teag({ smolyak_dimension: n, smolyak_level: level })).smolyakPoints.length / n;
  assert.equal(await count(6, 1), 1);
  assert.equal(await count(6, 2), 13);                 // 2n + 1
  assert.equal(await count(6, 3), 2 * 36 + 12 + 1);    // 2n^2 + 2n + 1 = 85
  assert.equal(await count(7, 3), 113);                // not 106 (2603.10065) nor 2n^2 + 1 (TEAG 5.1): docs G3
  assert.equal(await count(2, 4), 29);                 // standard Smolyak CC count
  const g = (await teag({ smolyak_dimension: 6, smolyak_level: 3 })).smolyakPoints;
  const nodes = new Set([1, Math.SQRT1_2, 0, -Math.SQRT1_2, -1].map((v) => v.toFixed(15)));
  g.forEach((v) => assert.ok(nodes.has((v === 0 ? 0 : v).toFixed(15)), v));
  // The level-3 grid's MVEE is the ball of radius sqrt(2) (symmetry).
  const pts = []; for (let k = 0; k < g.length / 6; ++k) pts.push(g.slice(6 * k, 6 * k + 6));
  const e = await mvee(6, pts);
  for (let i = 0; i < 6; ++i) for (let j = 0; j < 6; ++j) close(e.mveeShape[i * 6 + j], i === j ? 2 : 0, 1e-8, 'Smolyak MVEE');
});

test('(d) the minimum-trace Minkowski outer bound contains the sum and has trace (sqrt tr A + sqrt tr B)^2', async () => {
  const A = [4, 1, 0, 1, 2, 0.3, 0, 0.3, 1], B = [0.5, 0, 0.1, 0, 3, 0, 0.1, 0, 0.25];
  const S = (await teag({ shape_a: A, shape_b: B })).minkowskiShape;
  const tr = (M) => M[0] + M[4] + M[8];
  close(tr(S), (Math.sqrt(tr(A)) + Math.sqrt(tr(B))) ** 2, 1e-14, 'trace');
  const quad = (M, u) => u.reduce((s, ui, i) => s + ui * u.reduce((t, uj, j) => t + M[i * 3 + j] * uj, 0), 0);
  // Support functions: h_S(u) >= h_A(u) + h_B(u) for every direction u.
  for (let k = 0; k < 2000; ++k) {
    const t = Math.acos(1 - 2 * (k + 0.5) / 2000), p = Math.PI * (1 + Math.sqrt(5)) * k;
    const u = [Math.sin(t) * Math.cos(p), Math.sin(t) * Math.sin(p), Math.cos(t)];
    assert.ok(Math.sqrt(quad(S, u)) >= Math.sqrt(quad(A, u)) + Math.sqrt(quad(B, u)) - 1e-12);
  }
});

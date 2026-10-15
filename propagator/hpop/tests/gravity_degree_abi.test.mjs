// The gravity degree and order of the diagnostic force-model exports reach the
// field, and a force model in the wrong units is refused instead of flown.
//
// Exports: plugin_set_force_model (mu, degree, order and the J2/J3/J4 switches
// in its array) and plugin_set_gravity (EGM2008 truncation), propagated with
// plugin_propagate and turned back into GCRF with the module's own inverse,
// plugin_init_states_ecef.
//
// 1. Against Orekit 13.1 (tests/fixtures/orekit/orekit-reference.json) and
//    GMAT R2022a (tests/fixtures/gmat/gmat-reference.json) on their LEO400 and
//    SSO700 initial states, EGM2008 coefficients, GM 398600.4415 km^3/s^2 and
//    epoch 2026-08-02T00:00:00 UTC: the change of the inertial (GCRF) right
//    ascension of the ascending node over 24 h, for point mass, J2 (2x0), the
//    zonals to 20 (20x0) and the 20x20 field. A setting whose degree or order
//    is dropped answers with another setting's regression: over the day, J2 to
//    20x0 moves the node 7.1e-5 rad on LEO400 and 20x0 to 20x20 another
//    5.4e-6 rad, so the tolerance must sit below the smaller.
//    Tolerance 1.5e-6 rad (10 m out of plane at LEO). Measured with 1.3.1:
//    at most 2.1e-7 rad (20x20 on SSO700). What remains is the diagnostic
//    path's own Earth orientation (no EOP input; the PRW path reads it and is
//    held to millimetres in orekit_reference.test.mjs) and its RK78 at 1e-12.
// 2. One revolution of the orbit OrbPro's GMAT-parity demo flies (circular,
//    a 7078 km, i 51.6 deg): the J2-only regression against the classical
//    first-order secular rate, dOmega/dt = -3/2 n J2 (Re/p)^2 cos i, which is
//    -3 pi J2 (Re/a)^2 cos i per revolution at e = 0; tolerance 0.5 % for the
//    second-order J2^2 terms it leaves out (J2 (Re/a)^2 = 8.8e-4; measured
//    0.19 %). Then the J2-to-4x0 change against J4's first-order secular rate,
//    dOmega/dt = 15/16 n J4 (Re/p)^4 cos i (4 - 7 sin^2 i) at e = 0;
//    tolerance 5 % for the J2-J4 cross terms and J3's one-revolution residue
//    (measured 1.9 %). 4x4 must then differ from 4x0: the tesseral and
//    sectorial terms the order admits move this node 2.5e-5 rad in the
//    revolution, and the same 4x4 field reached through the force-model array
//    (the inline field) must agree with it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { createHPOPPropagator } from '../index.js';

const HPOP_ERR_BAD_ARGUMENT = -4;
const RK78 = 2;
const orekit = JSON.parse(fs.readFileSync(new URL('./fixtures/orekit/orekit-reference.json', import.meta.url), 'utf8'));
const gmat = JSON.parse(fs.readFileSync(new URL('./fixtures/gmat/gmat-reference.json', import.meta.url), 'utf8'));

const plugin = await createHPOPPropagator();
const ex = plugin.exports;
test.after(async () => { await plugin.destroy?.(); });

const f64 = (ptr, n) => new Float64Array(ex.memory.buffer, ptr, n);
const scratch = (n) => ex.malloc(n * 8);
const forcePtr = scratch(15);
const statePtr = scratch(7);
const outPtr = scratch(7);
const jdOfUtc = (iso) => Date.parse(`${iso}Z`) / 86400000 + 2440587.5;
const wrap = (x) => Math.atan2(Math.sin(x), Math.cos(x));
/** Right ascension of the ascending node of a GCRF [x, y, z, vx, vy, vz]. */
const node = (s) => Math.atan2(s[1] * s[5] - s[2] * s[4], -(s[2] * s[3] - s[0] * s[5]));

/** [mu, degree, order, J2, J3, J4], everything else off. */
function setForceModel(mu, degree = 0, order = 0, j2 = 0, j3 = 0, j4 = 0) {
  f64(forcePtr, 15).set([mu, degree, order, j2, j3, j4, 0, 0, 0, 0, 1000, 20, 20, 2.2, 1.3]);
  return ex.plugin_set_force_model(forcePtr);
}

/**
 * Seed one entity at `epochJD` with a GCRF km state, configure, and return the
 * GCRF states (km) at `offsetsSec` through plugin_propagate's ECEF output.
 */
function fly({ mu, array = [], gravity }, epochJD, state, offsetsSec) {
  assert.equal(ex.plugin_init(), 0);
  ex.plugin_set_integrator(RK78);
  assert.equal(setForceModel(mu, ...array), 0);
  if (gravity) ex.plugin_set_gravity(gravity[0], gravity[1], 0);
  f64(statePtr, 7).set([epochJD, ...state]);
  assert.equal(ex.plugin_init_states(statePtr, 1), 1);
  const buf = scratch(offsetsSec.length * 7);
  try {
    offsetsSec.forEach((t, i) => {
      assert.equal(ex.plugin_propagate(epochJD + t / 86400, 0, outPtr), 0, `propagate at +${t} s`);
      f64(buf + i * 56, 7).set(f64(outPtr, 7));
    });
    ex.plugin_init_states_ecef(buf, offsetsSec.length);
    return offsetsSec.map((_, i) => Array.from(f64(buf + i * 56 + 8, 6)));
  } finally {
    ex.free(buf);
  }
}

const SETTINGS = [
  { forces: 'F0-point-mass', config: {} },
  { forces: 'F1-J2', config: { gravity: [2, 0] } },
  { forces: 'F1-J2', label: 'J2 switch', config: { array: [0, 0, 1, 0, 0] } },
  { forces: 'F2-zonal20', config: { gravity: [20, 0] } },
  { forces: 'F3-field20x20', config: { gravity: [20, 20] } },
  { forces: 'F3-field20x20', label: 'force-model array 20x20', config: { array: [20, 20, 1, 1, 1] } },
];
const NODE_TOLERANCE_RAD = 1.5e-6;

for (const [name, reference] of [['Orekit 13.1', orekit], ['GMAT R2022a', gmat]]) {
  test(`each gravity setting regresses the node over 24 h as ${name} does (LEO400, SSO700)`, () => {
    const epochJD = jdOfUtc(reference.epochUtc);
    const mu = reference.constants.gm / 1e9;
    for (const orbit of ['LEO400', 'SSO700']) {
      const regressions = {};
      for (const { forces, label, config } of SETTINGS) {
        const c = reference.cases.find((k) => k.orbit === orbit && k.forces === forces);
        if (!c) continue;  // GMAT has no 20x0 case
        const s0 = c.samples[0].slice(1, 7).map((v) => v / 1000);
        const last = c.samples.at(-1);
        const [h0, h1] = fly({ mu, ...config }, epochJD, s0, [0, last[0]]);
        const expected = wrap(node(last.slice(1, 7)) - node(c.samples[0].slice(1, 7)));
        const measured = wrap(node(h1) - node(h0));
        const where = `${orbit} ${forces}${label ? ` (${label})` : ''}`;
        assert.ok(Math.abs(measured - expected) <= NODE_TOLERANCE_RAD,
          `${where}: dOmega(24 h) ${measured.toExponential(6)} rad, ${name} ${expected.toExponential(6)}`);
        regressions[forces] ??= measured;
      }
      // The settings are distinguishable at this tolerance, so the assertions
      // above cannot pass with a degree or order ignored.
      const j2ToField = Math.abs(regressions['F3-field20x20'] - regressions['F1-J2']);
      assert.ok(j2ToField > 10 * NODE_TOLERANCE_RAD, `${orbit}: J2 to 20x20 moved the node ${j2ToField} rad`);
    }
  });
}

test('one revolution at 7078 km, 51.6 deg: J2, J4 and the 4x4 field each move the node by their own amount', () => {
  const constantsPtr = scratch(5);
  assert.equal(ex.plugin_get_body_constants(constantsPtr, 5), 5);
  const [mu, re, j2, , j4] = Array.from(f64(constantsPtr, 5));
  ex.free(constantsPtr);

  const a = 7078.0, inc = (51.6 * Math.PI) / 180, epochJD = 2460000.5;
  const v = Math.sqrt(mu / a);
  const state = [a, 0, 0, 0, v * Math.cos(inc), v * Math.sin(inc)];
  const period = 2 * Math.PI * Math.sqrt(a ** 3 / mu);
  const perRevolution = (config) => {
    const [s0, s1] = fly({ mu, ...config }, epochJD, state, [0, period]);
    return wrap(node(s1) - node(s0));
  };

  const q = re / a, cosI = Math.cos(inc), sin2I = Math.sin(inc) ** 2;
  const j2Secular = -3 * Math.PI * j2 * q ** 2 * cosI;
  const j4Secular = 2 * Math.PI * (15 / 16) * j4 * q ** 4 * cosI * (4 - 7 * sin2I);

  const pointMass = perRevolution({});
  const j2Only = perRevolution({ gravity: [2, 0] });
  const j2Switch = perRevolution({ array: [0, 0, 1, 0, 0] });
  const zonal4 = perRevolution({ gravity: [4, 0] });
  const field4x4 = perRevolution({ gravity: [4, 4] });
  const array4x4 = perRevolution({ array: [4, 4, 1, 1, 1] });
  console.log(`[gravity] dOmega/rev: point mass ${pointMass.toExponential(4)}, J2 ${j2Only.toExponential(5)} ` +
    `(secular ${j2Secular.toExponential(5)}), 4x0 - 2x0 ${(zonal4 - j2Only).toExponential(4)} ` +
    `(J4 secular ${j4Secular.toExponential(4)}), 4x4 ${field4x4.toExponential(5)}, array 4x4 ${array4x4.toExponential(5)}`);

  assert.ok(Math.abs(pointMass) < 1e-7, `point mass leaves the node alone: ${pointMass}`);
  for (const [label, value] of [['set_gravity 2x0', j2Only], ['J2 switch', j2Switch]]) {
    const relative = Math.abs(value - j2Secular) / Math.abs(j2Secular);
    assert.ok(relative <= 5e-3, `${label}: ${value.toExponential(5)} vs ${j2Secular.toExponential(5)} (${relative})`);
  }
  const j4Relative = Math.abs(zonal4 - j2Only - j4Secular) / Math.abs(j4Secular);
  assert.ok(j4Relative <= 0.05, `4x0 - 2x0 ${(zonal4 - j2Only).toExponential(4)} vs J4 secular ${j4Secular.toExponential(4)}`);
  assert.ok(Math.abs(field4x4 - zonal4) > 5e-6, `order 4 must change the regression: 4x4 ${field4x4}, 4x0 ${zonal4}`);
  assert.ok(Math.abs(field4x4 - array4x4) <= 1e-7, `4x4 by set_gravity ${field4x4} vs by the array ${array4x4}`);
});

test('a force model whose mu is not Earth GM in km^3/s^2 is refused, and nothing propagates until one is accepted', () => {
  const v = Math.sqrt(398600.4418 / 7078);
  assert.equal(ex.plugin_init(), 0);
  f64(statePtr, 7).set([2460000.5, 7078, 0, 0, 0, v, 0]);
  assert.equal(ex.plugin_init_states(statePtr, 1), 1);
  assert.equal(setForceModel(398600.4418, 0, 0, 1), 0);
  assert.equal(ex.plugin_propagate(2460000.5 + 0.01, 0, outPtr), 0);

  // Cesium's GRAVITATIONALPARAMETER: the same GM in m^3/s^2.
  for (const wrong of [3.986004418e14, 1, -398600.4418, Number.NaN]) {
    assert.equal(setForceModel(wrong, 0, 0, 1), HPOP_ERR_BAD_ARGUMENT, `mu ${wrong}`);
    assert.equal(ex.plugin_propagate(2460000.5 + 0.02, 0, outPtr), -1, `propagation after mu ${wrong}`);
  }
  const v2 = scratch(17);
  f64(v2, 17).set([3.986004418e14, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1000, 20, 20, 2.2, 1.3, 2, 4]);
  assert.equal(ex.plugin_set_force_model_v2(v2, 17), HPOP_ERR_BAD_ARGUMENT);
  f64(v2, 1)[0] = 398600.4415;
  assert.equal(ex.plugin_set_force_model_v2(v2, 17), 0);
  ex.free(v2);
  assert.equal(ex.plugin_propagate(2460000.5 + 0.03, 0, outPtr), 0);

  assert.equal(setForceModel(3.986004418e14), HPOP_ERR_BAD_ARGUMENT);
  assert.equal(setForceModel(0), 0, 'zero selects the module GM');
  assert.equal(ex.plugin_propagate(2460000.5 + 0.04, 0, outPtr), 0);
  assert.equal(setForceModel(3.986004418e14), HPOP_ERR_BAD_ARGUMENT);
  assert.equal(ex.plugin_init(), 0, 'plugin_init clears the refusal');
  f64(statePtr, 7).set([2460000.5, 7078, 0, 0, 0, v, 0]);
  assert.equal(ex.plugin_init_states(statePtr, 1), 1);
  assert.equal(ex.plugin_propagate(2460000.5 + 0.05, 0, outPtr), 0);
});

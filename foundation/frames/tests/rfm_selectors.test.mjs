// All physics executes in the production SDK artifact. JS only encodes the
// invoke records and compares results to independent references, including
// test-only matrix/vector arithmetic on the published reference constants.
// Source, units, frames, epoch, tolerance and rationale:
// RFM_SELECTORS_VERIFICATION.md and rfm_selector_harness.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createStandaloneHarness } from 'space-data-module-sdk/testing/isomorphic';
import {
  CASES, AS2R, cookbookEop, invokeResult, matrixOf, matrixValues, measuredError, transpose,
  apply, vectorOf, state, objectState, systems, siteOrigin, earthOrigin,
  frmOperationCode, frmResultStatus, rfmAxisType,
} from './rfm_selector_harness.mjs';

const WASM_PATH = new URL('../dist/isomorphic/module.wasm', import.meta.url);
const WASMEDGE_BINARY = process.env.SDN_FRAME_WASMEDGE_BINARY;
const RUNTIME = WASMEDGE_BINARY ? 'wasmedge' : 'browser';

test(`ratified RFM selectors through production FRM invoke (${RUNTIME})`, { concurrency: false }, async t => {
  assert.ok(fs.existsSync(WASM_PATH), 'run npm ci and npm run build before this test');
  const harness = await createStandaloneHarness(RUNTIME, WASM_PATH, {
    surface: 'direct', enableThreads: false, wasmEdgeBinary: WASMEDGE_BINARY,
  });
  t.after(() => harness.destroy());
  for (const reference of CASES) {
    await t.test(`${reference.wire}: ${reference.name} published/closed-form orientation and inverse`, async () => {
      assert.equal(rfmAxisType[reference.selector], reference.wire, 'ratified wire ordinal changed');
      const result = await invokeResult(harness, reference);
      const error = measuredError(matrixOf(result), reference.expected);
      t.diagnostic(`AUTH ${reference.name} forward max DCM error=${error.toExponential(8)}; tolerance=${reference.tolerance}; ${reference.source}`);
      assert.ok(error <= reference.tolerance, `forward error ${error}`);
      const { source, target } = systems(reference);
      const inverse = matrixOf(await invokeResult(harness, reference, { source: target, target: source }));
      const inverseError = measuredError(inverse, transpose(reference.expected));
      t.diagnostic(`AUTH ${reference.name} inverse max DCM error=${inverseError.toExponential(8)}`);
      assert.ok(inverseError <= reference.tolerance, `inverse error ${inverseError}`);
      if (reference.family !== 'orbital') {
        assert.equal(result.EOP_DATA_SET_CID(), 'sofa-cookbook-rfm-selectors');
      }
    });
    await t.test(`${reference.wire}: ${reference.name} transforms position through FRM STATE_TRANSFORM`, async () => {
      // Metres. Orbital frame origin is (2,0,0), so both cases have relative
      // vector (4,5,6). Local source and target share exactly the same site.
      const position = reference.family === 'orbital' ? [6, 5, 6] : [4, 5, 6];
      const result = await invokeResult(harness, reference, {
        operation: frmOperationCode.STATE_TRANSFORM, state: state(position),
      });
      assert.equal(result.STATUS(), frmResultStatus.OK, result.ERROR_MESSAGE());
      const output = result.TARGET_STATE();
      assert.ok(output, 'missing transformed state');
      const error = measuredError(vectorOf(output.POSITION()), apply(reference.expected, [4, 5, 6]));
      // A shared Earth site translates through ~6e6 m root coordinates, so
      // allow 10 nm cancellation roundoff; TOD/orbit cases need no large shift.
      const tolerance = reference.family === 'local' ? 1e-8 : 2e-11;
      t.diagnostic(`AUTH ${reference.name} state position max error=${error.toExponential(8)} m; tolerance=${tolerance} m`);
      assert.ok(error <= tolerance, `position error ${error} m`);
    });
  }

  await t.test('IERS2003 converts 2006 pole offsets to the 2000A convention', async () => {
    const reference = CASES[1];
    const actual = matrixOf(await invokeResult(harness, reference, { eop: [cookbookEop({
      IAU_CONVENTION: 3,
      X_CELESTIAL_POLE_OFFSET_RADIANS_HP: .0001750 * AS2R + (.000712264729708 - .000712264729525),
      Y_CELESTIAL_POLE_OFFSET_RADIANS_HP: -.0002259 * AS2R + (.000044385250265 - .000044385248875),
    })] }));
    // SOFA's original 2006 offsets were based on Xys06a (angles), whereas
    // this module's existing Earth chain uses Xy06 (series). Adjust the
    // offsets by the independently PRINTED corrected CIP coordinates in
    // §5.3 and §5.6 so both inputs describe the same observed pole. Otherwise
    // their published ~1 microarcsecond series/angles difference is real.
    const error = measuredError(actual, reference.expected);
    t.diagnostic(`AUTH IERS2003 IAU2006 offsets max DCM error=${error.toExponential(8)}; tolerance=1e-12`);
    assert.ok(error <= 1e-12);
  });

  await t.test('IERS1996 interpolates explicit observed nutation offsets', async () => {
    const reference = CASES[0];
    const eop = [
      cookbookEop({ NUTATION_DPSI_RADIANS: -.06 * AS2R, NUTATION_DEPS_RADIANS: -.008 * AS2R }),
      cookbookEop({ DATE: '2007-04-06T00:00:00Z', MJD: 54196,
        NUTATION_DPSI_RADIANS: -.050131 * AS2R, NUTATION_DEPS_RADIANS: -.004716 * AS2R }),
    ];
    // Noon arithmetic mean is exactly the cookbook's -.0550655/-.006358 arcsec.
    const error = measuredError(matrixOf(await invokeResult(harness, reference, { eop })), reference.expected);
    t.diagnostic(`AUTH IERS1996 interpolated offsets max DCM error=${error.toExponential(8)}; tolerance=1e-12`);
    assert.ok(error <= 1e-12);
  });

  await t.test('each Earth/local selector refuses missing EOP', async () => {
    for (const reference of CASES.filter(c => c.family !== 'orbital')) {
      const result = await invokeResult(harness, reference, { eop: false });
      assert.equal(result.STATUS(), frmResultStatus.MISSING_EOP_DATA, reference.name);
    }
  });

  await t.test('orbital selectors follow the referenced object origin and reject missing/degenerate states', async () => {
    for (const reference of CASES.filter(c => c.family === 'orbital')) {
      const result = await invokeResult(harness, reference, {
        operation: frmOperationCode.STATE_TRANSFORM, state: state([2, 0, 0], [3, 4, 0]),
      });
      assert.equal(result.STATUS(), frmResultStatus.OK, result.ERROR_MESSAGE());
      assert.ok(measuredError(vectorOf(result.TARGET_STATE().POSITION()), [0, 0, 0]) <= 1e-15);
      assert.ok(measuredError(vectorOf(result.TARGET_STATE().VELOCITY()), [0, 0, 0]) <= 1e-15);
      for (const object of [false, objectState([2, 0, 0], [3, 0, 0]), objectState([0, 0, 0], [3, 4, 0]),
        objectState([2, 0, 0], [NaN, 4, 0]), objectState([2, 0, 0], [3, 4, 0], 'different-object')]) {
        const refused = await invokeResult(harness, reference, { object });
        assert.notEqual(refused.STATUS(), frmResultStatus.OK, `${reference.name} must refuse invalid object state`);
      }
      const { target } = systems(reference);
      target.ORIGIN = earthOrigin();
      assert.notEqual((await invokeResult(harness, reference, { target })).STATUS(), frmResultStatus.OK,
        `${reference.name} requires the object's SPACE_OBJECT origin`);
    }
  });

  await t.test('orbital rates and velocity transforms follow the independent inverse-square solution', async () => {
    // r=(2,0,0)m, v=(3,4,0)m/s, mu=10m³/s² gives a=(-2.5,0,0)m/s².
    // h_z=8m²/s. RTN/LVLH rotate at h/r²=2rad/s. VNC's velocity
    // direction rotates at (v cross a)_z/v²=10/25=.4rad/s.
    // These exact derivatives are computed by differentiating the explicit
    // basis rows in the fixture, and use passive Rdot=-[omega_target]x R.
    const references = [
      { index: 5, omega: .4, rate: [-.32, .24, 0, -.24, -.32, 0, 0, 0, 0],
        velocity: [.92, -.56, 3] },
      { index: 6, omega: 2, rate: [0, 2, 0, -2, 0, 0, 0, 0, 0],
        velocity: [9, -6, 3] },
      { index: 7, omega: 2, rate: [-2, 0, 0, 0, 0, 0, 0, -2, 0],
        velocity: [-6, -3, -9] },
    ];
    for (const reference of references) {
      const fixture = CASES[reference.index];
      const result = await invokeResult(harness, fixture);
      assert.equal(result.STATUS(), frmResultStatus.OK, result.ERROR_MESSAGE());
      const rateError = measuredError(matrixValues(result.ROTATION_DCM_RATE()), reference.rate);
      const omegaError = measuredError(vectorOf(result.ANGULAR_VELOCITY_RAD_S()), [0, 0, reference.omega]);
      assert.ok(rateError <= 1e-14, `${fixture.name} rate error ${rateError}`);
      assert.ok(omegaError <= 1e-14, `${fixture.name} angular velocity error ${omegaError}`);
      const transformed = await invokeResult(harness, fixture, {
        operation: frmOperationCode.STATE_TRANSFORM, state: state([6, 5, 6], [2, 6, 3]),
      });
      assert.equal(transformed.STATUS(), frmResultStatus.OK, transformed.ERROR_MESSAGE());
      // Relative input p=(4,5,6), v=(-1,2,3); v_target=R v+Rdot p.
      const velocityError = measuredError(vectorOf(transformed.TARGET_STATE().VELOCITY()), reference.velocity);
      assert.ok(velocityError <= 1e-13, `${fixture.name} velocity error ${velocityError}`);
      t.diagnostic(`AUTH ${fixture.name} rate error=${rateError.toExponential(8)} s^-1; omega error=${omegaError.toExponential(8)} rad/s; velocity error=${velocityError.toExponential(8)} m/s`);
    }
  });

  await t.test('explicit topocentric selectors reject malformed site geometry', async () => {
    for (const reference of CASES.filter(c => c.family === 'local')) {
      const wrongBody = siteOrigin();
      wrongBody.SITE_BODY_ID = 301;
      for (const origin of [earthOrigin(), wrongBody, siteOrigin(91), siteOrigin(NaN)]) {
        const { target } = systems(reference);
        target.ORIGIN = origin;
        assert.notEqual((await invokeResult(harness, reference, { target })).STATUS(), frmResultStatus.OK,
          `${reference.name} must refuse malformed site`);
      }
    }
  });
});

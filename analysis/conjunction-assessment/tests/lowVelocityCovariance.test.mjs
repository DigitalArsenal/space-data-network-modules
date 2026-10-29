// End-to-end uncertainty provenance, through the published CQR/WASM surface.
// Independent closed form: isotropic inertial position covariance 0.02 I km²
// per object at JD 2461314.5 UTC, 0.05 km separation: Md²=0.05²/0.04=0.0625.
// OEM position/velocity covariance is linearly interpolated from 0.5x to 1.5x
// that value. TEME axes; km, km/s, km², km²/s, km²/s². Tolerances cover the
// Julian-date resolution, Hermite interpolation and binary64 frame rotations.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createConjunctionCommandHarness } from './lib/conjunctionCommandHarness.mjs';
import { decodeCqr, earthFrame, encodeCqr, gpSource, initCqrFlatc, publishedSchema, screeningControls } from './lib/cqr.mjs';
import { syntheticGp } from './lib/syntheticCatalog.mjs';
import { uncertaintyModelFrame } from '../scripts/uncertainty-model.mjs';

const jd0 = 2461314.5;
const iso = jd => new Date((jd - 2440587.5) * 86400000).toISOString();
const frame = { REFERENCE_FRAME_type: 'CelestialFrameWrapper', REFERENCE_FRAME: { frame: 'TEMEOFDATE' } };
function track(id, secondary) {
  const states = [];
  for (let t = -120; t <= 120; t += 30) states.push({
    EPOCH: iso(jd0 + t / 86400),
    X: 7000 + (secondary ? 0.05 + 1e-6 * t * t : 0), Y: 7.5 * t, Z: 0,
    X_DOT: secondary ? 2e-6 * t : 0, Y_DOT: 7.5, Z_DOT: 0,
  });
  const covariances = [-120, 120].map(t => {
    const scale = 1 + t / 240;
    return { EPOCH: iso(jd0 + t / 86400),
      CX_X: scale * .02, CY_Y: scale * .02, CZ_Z: scale * .02,
      CX_DOT_X: scale * 1e-7, CY_DOT_Y: scale * 1e-7, CZ_DOT_Z: scale * 1e-7,
      CX_DOT_X_DOT: scale * 2e-10, CY_DOT_Y_DOT: scale * 2e-10, CZ_DOT_Z_DOT: scale * 2e-10,
    };
  });
  // Synthetic catalog identifiers are fixture metadata, not real spacecraft.
  return { OBJECT_ID: id, OBJECT_NAME: id, NORAD_CATALOG_ID: secondary ? 900002 : 900001, EPHEMERIS: { EPHEMERIS_DATA_BLOCK: [{
    CENTER_NAME: 'EARTH', CENTER_NAIF_ID: 399, TIME_SYSTEM: 'UTC',
    REFERENCE_FRAME: frame, COV_REFERENCE_FRAME: frame,
    EPHEMERIS_DATA_LINES: states, COVARIANCE_MATRIX_LINES: covariances,
  }] } };
}
const pair = () => ({
  PRIMARY: track('low-speed-primary', false), SECONDARY: track('low-speed-secondary', true),
  CONTROLS: { ...screeningControls({ startJd: jd0 - 60 / 86400, durationSeconds: 120, coarseStepSec: 5 }), ALGORITHM: 'FOSTER' },
  PRIMARY_RADIUS_M: 5, SECONDARY_RADIUS_M: 5, EVALUATION_FRAME: earthFrame('TEME'),
});
function verify(e) {
  assert.ok(Math.abs(e.MISS_DISTANCE_M - 50) < .001, `miss ${e.MISS_DISTANCE_M}`);
  assert.ok(e.RELATIVE_SPEED_M_S < 3e-6, `relative speed ${e.RELATIVE_SPEED_M_S}`);
  assert.equal(e.PRIMARY_COVARIANCE_BASIS, 'SOURCE_EPHEMERIS');
  assert.equal(e.SECONDARY_COVARIANCE_BASIS, 'SOURCE_EPHEMERIS');
  for (const sigma of [e.PRIMARY_SIGMA_RTN_M, e.SECONDARY_SIGMA_RTN_M])
    for (const axis of ['X', 'Y', 'Z']) assert.ok(Math.abs(sigma[axis] - Math.sqrt(.02) * 1000) < .001);
  assert.equal(e.HAS_MAHALANOBIS_3D_SQUARED, true);
  assert.ok(Math.abs(e.MAHALANOBIS_3D_SQUARED - .0625) < 1e-6);
  // A fallback cannot be mislabeled as a plane method or replaced by a
  // covariance-free statistic. The embedded CDM carries its actual method.
  assert.equal(e.PROBABILITY, undefined);
  const cdm = e.CONJUNCTION_MESSAGE;
  assert.ok(cdm);
  for (const object of [cdm.OBJECT1, cdm.OBJECT2]) {
    assert.equal(object.COVARIANCE.length, 21);
    for (const i of [0, 2, 5]) assert.ok(Math.abs(object.COVARIANCE[i] - .02) < 1e-6);
    for (const i of [6, 11, 17]) assert.ok(Math.abs(object.COVARIANCE[i] - 1e-7) < 1e-11);
    for (const i of [9, 14, 20]) assert.ok(Math.abs(object.COVARIANCE[i] - 2e-10) < 1e-12);
  }
  assert.ok(!cdm.COLLISION_PROBABILITY_METHOD || /SDMC|NC/.test(cdm.COLLISION_PROBABILITY_METHOD));
}

for (const runtimeKind of (process.env.CQR_TEST_RUNTIME ? [process.env.CQR_TEST_RUNTIME] : ['browser', 'wasmedge'])) {
  // Unresolved peaks use the full finite observation interval. The WasmEdge
  // interpreter needs more time for its unchanged 65,536 two-body samples;
  // retain the window, sample count and assertions in both runtime lanes.
  test(`${runtimeKind}: low-speed pair and catalog retain interpolated uncertainty`, { timeout: 540000 }, async t => {
    const flatc = await initCqrFlatc();
    const h = await createConjunctionCommandHarness({ runtimeKind });
    t.after(() => h.destroy?.());
    const p = pair();
    for (const methodId of ['assess_conjunction', 'screen_catalog']) {
      const request = methodId === 'assess_conjunction' ? { PAIR_REQUEST: p } : { CATALOG_REQUEST: {
        PRIMARIES: [p.PRIMARY], SECONDARIES: [p.SECONDARY], CONTROLS: p.CONTROLS, EVALUATION_FRAME: p.EVALUATION_FRAME,
      } };
      const r = await h.invoke({ methodId, inputs: [{ portId: 'request', payload: encodeCqr(flatc, request) }] });
      assert.equal(r.statusCode, 0, `${r.errorCode}: ${r.errorMessage}`);
      const records = r.outputs.filter(f => f.portId === 'result').map(f => decodeCqr(flatc, f.payload));
      const events = methodId === 'assess_conjunction' ? records.map(r => r.EVENT_RESULT) : records.flatMap(r => r.CATALOG_RESULT?.EVENTS ?? []);
      assert.equal(events.length, 1, methodId);
      verify(events[0]);
      // The same preserved 6x6 covariance must survive the external CDM
      // serializers. These accept the existing embedded CDM without inventing Pc.
      if (methodId === 'assess_conjunction') {
        const bytes = flatc.generateBinary(publishedSchema('CDM'), JSON.stringify(events[0].CONJUNCTION_MESSAGE), { sizePrefix: false });
        for (const syntax of ['kvn', 'xml']) {
          const written = await h.invoke({ methodId: `write_cdm_${syntax}`, inputs: [{ portId: 'cdm', payload: bytes }] });
          assert.equal(written.statusCode, 0, written.errorMessage);
          const parsed = await h.invoke({ methodId: `parse_cdm_${syntax}`, inputs: [{ portId: syntax, payload: written.outputs.find(f => f.portId === syntax).payload }] });
          assert.equal(parsed.statusCode, 0, parsed.errorMessage);
          const record = JSON.parse(flatc.generateJSON(publishedSchema('CDM'), { path: '/roundtrip.bin', data: parsed.outputs.find(f => f.portId === 'cdm').payload }, { defaultsJson: true }));
          for (const key of ['OBJECT1', 'OBJECT2'])
            for (let i = 0; i < 21; ++i) assert.ok(Math.abs(record[key].COVARIANCE[i] - events[0].CONJUNCTION_MESSAGE[key].COVARIANCE[i]) < 1e-12);
          assert.equal(record.COLLISION_PROBABILITY_METHOD, events[0].CONJUNCTION_MESSAGE.COLLISION_PROBABILITY_METHOD);
        }
      }
    }
    // A singular position covariance has no invertible 3-D Mahalanobis
    // metric. It must not be reported as a measured zero.
    const singular = pair();
    for (const source of [singular.PRIMARY, singular.SECONDARY])
      for (const row of source.EPHEMERIS.EPHEMERIS_DATA_BLOCK[0].COVARIANCE_MATRIX_LINES)
        for (const key of Object.keys(row)) if (key !== 'EPOCH') row[key] = 0;
    const invalid = await h.invoke({ methodId: 'assess_conjunction', inputs: [{ portId: 'request', payload: encodeCqr(flatc, { PAIR_REQUEST: singular }) }] });
    assert.equal(invalid.statusCode, 0, invalid.errorMessage);
    const unavailable = decodeCqr(flatc, invalid.outputs[0].payload).EVENT_RESULT;
    assert.equal(unavailable.HAS_MAHALANOBIS_3D_SQUARED, false);
    assert.equal(unavailable.PROBABILITY, undefined);
    assert.equal(unavailable.PRIMARY_COVARIANCE_BASIS, 'SOURCE_EPHEMERIS');

    // Two synthetic identities with identical elements are co-located: their
    // range is 0 at every instant, so no time is the closest approach. The
    // pair methods say so apart from "no close approach", with the range.
    const [gp] = syntheticGp({ planes: 1, perPlane: 1, epoch: iso(jd0 - 1) });
    const modelCovariance = Array(21).fill(0);
    for (const i of [0, 2, 5]) modelCovariance[i] = .02;
    for (const i of [9, 14, 20]) modelCovariance[i] = 2e-10;
    const model = uncertaintyModelFrame({ kind: 'gp-error-model',
      regimes: [{ id: 'synthetic', altitudeKm: [0, 1e9], eccentricity: [0, 1] }],
      ageBinsDays: [[0, 7]], strata: [{ regimeIndex: 0, ageIndex: 0, covariance: modelCovariance }] });
    const withModel = (request) => [{ portId: 'request', payload: encodeCqr(flatc, { PAIR_REQUEST: request }) }, { portId: 'uncertainty_model', payload: model }];
    const colocated = pair();
    colocated.PRIMARY = gpSource(gp);
    colocated.SECONDARY = gpSource({ ...gp, NORAD_CAT_ID: gp.NORAD_CAT_ID + 1,
      OBJECT_ID: 'synthetic-coincident-secondary', OBJECT_NAME: 'synthetic-coincident-secondary' });
    const refused = await h.invoke({ methodId: 'assess_conjunction', inputs: withModel(colocated) });
    assert.equal(refused.statusCode, 422, refused.errorMessage);
    assert.equal(refused.errorCode, 'constant-range');
    assert.match(refused.errorMessage, /constant over the window at 0\.000 m/);

    // Exercise the distinct empirical-model adapter without private fixtures,
    // on a slow real encounter: two invented element sets, epoch 0.01 day
    // before jd0 (inside the model's first age bin), alike but for inclination
    // (53 and 53.0038 deg), both at the node about jd0, so they pass 1.8 m
    // apart at 0.50 m/s, inside the window. At that speed the short-term
    // encounter assumptions fail and the fallback method is carried by the
    // CDM; the narrower CQR plane-method enum cannot represent it.
    const element = (name, norad, inclination) => ({ OBJECT_NAME: name, OBJECT_ID: name, NORAD_CAT_ID: norad,
      EPOCH: iso(jd0 - .01).slice(0, 23), ELEMENT_SET_NO: 999, REV_AT_EPOCH: 1, CLASSIFICATION_TYPE: 'U', BSTAR: 0,
      MEAN_MOTION_DOT: 0, MEAN_MOTION_DDOT: 0, MEAN_MOTION: 15.05, ECCENTRICITY: .0001, INCLINATION: inclination,
      RA_OF_ASC_NODE: 40, ARG_OF_PERICENTER: 0, MEAN_ANOMALY: 360 - 15.05 * .01 * 360 });
    const modeled = pair();
    modeled.PRIMARY = gpSource(element('synthetic-slow-primary', 900031, 53));
    modeled.SECONDARY = gpSource(element('synthetic-slow-secondary', 900032, 53.0038));
    const modeledResult = await h.invoke({ methodId: 'assess_conjunction', inputs: withModel(modeled) });
    assert.equal(modeledResult.statusCode, 0, modeledResult.errorMessage);
    const empirical = decodeCqr(flatc, modeledResult.outputs[0].payload).EVENT_RESULT;
    const intoWindow = (empirical.TCA.JULIAN_DATE - jd0) * 86400 + 60;
    assert.ok(intoWindow > 1 && intoWindow < 119, `TCA ${intoWindow} s into the window`);
    assert.ok(empirical.MISS_DISTANCE_M < 100, `miss ${empirical.MISS_DISTANCE_M} m`);
    assert.ok(Math.abs(empirical.RELATIVE_SPEED_M_S - .5) < .05, `relative speed ${empirical.RELATIVE_SPEED_M_S} m/s`);
    assert.equal(empirical.PROBABILITY, undefined);
    for (const key of ['PRIMARY_COVARIANCE_BASIS', 'SECONDARY_COVARIANCE_BASIS'])
      assert.equal(empirical[key], 'EMPIRICAL_MODEL');
    for (const sigma of [empirical.PRIMARY_SIGMA_RTN_M, empirical.SECONDARY_SIGMA_RTN_M])
      for (const axis of ['X', 'Y', 'Z']) assert.ok(Math.abs(sigma[axis] - Math.sqrt(.02) * 1000) < .001);
    assert.equal(empirical.HAS_MAHALANOBIS_3D_SQUARED, true);
    // Isotropic 0.02 km² per object: Md² = miss² / 0.04 km² (the decoded
    // record carries 11 significant digits).
    const md2 = (empirical.MISS_DISTANCE_M / 1000) ** 2 / .04;
    assert.ok(Math.abs(empirical.MAHALANOBIS_3D_SQUARED - md2) <= 1e-6 * md2, `Md² ${empirical.MAHALANOBIS_3D_SQUARED} vs ${md2}`);
    for (const object of [empirical.CONJUNCTION_MESSAGE.OBJECT1, empirical.CONJUNCTION_MESSAGE.OBJECT2])
      assert.deepEqual(object.COVARIANCE, modelCovariance);

    // Independent radial integral for a centered Gaussian disk:
    // Pc = 1-exp(-R²/(2 sigma²)), R=.01 km, sigma²=.04 km².
    const ordinary = pair();
    for (const [index, source] of [ordinary.PRIMARY, ordinary.SECONDARY].entries()) {
      for (const row of source.EPHEMERIS.EPHEMERIS_DATA_BLOCK[0].COVARIANCE_MATRIX_LINES)
        row.CX_X = row.CY_Y = row.CZ_Z = .02;
      for (const row of source.EPHEMERIS.EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES) {
        row.X = 7000; row.X_DOT = 0;
        if (index === 1) { row.Y = -row.Y; row.Y_DOT = -row.Y_DOT; }
      }
    }
    const normal = await h.invoke({ methodId: 'assess_conjunction', inputs: [{ portId: 'request', payload: encodeCqr(flatc, { PAIR_REQUEST: ordinary }) }] });
    assert.equal(normal.statusCode, 0, normal.errorMessage);
    const accepted = decodeCqr(flatc, normal.outputs[0].payload).EVENT_RESULT;
    assert.equal(accepted.PROBABILITY.ALGORITHM, 'FOSTER');
    assert.ok(Math.abs(accepted.PROBABILITY.PROBABILITY + Math.expm1(-.00125)) < 2e-9,
      JSON.stringify({ probability: accepted.PROBABILITY.PROBABILITY, time: accepted.TCA, radius: accepted.COMBINED_RADIUS_M, sigma: accepted.PRIMARY_SIGMA_RTN_M, miss: accepted.MISS_DISTANCE_M }));
    assert.equal(accepted.HAS_MAHALANOBIS_3D_SQUARED, true);
  });
}

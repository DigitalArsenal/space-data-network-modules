// Element-set events take covariance from an empirical prediction-error model
// (uncertainty_model, analysis/gp-error-model): the stratum of each object's
// regime and prediction age gives its RTN covariance, a covariance method's
// probability follows, and the event says where it came from and whether the
// calibration gate passed. Outside the model, or with ALFANO_MAXIMUM, events
// keep the Alfano maximum.
//
// The pair is SOCRATES's GRUS-1E x STARLINK-3043 (tests/fixtures/socrates),
// 14 m apart at 2026-03-12T04:44:40.733Z, 2.68 days from both epochs. The
// expected probability is integrated here over the 10 m disk in the encounter
// plane: each object's RTN covariance rotated by its own state, summed,
// projected normal to the relative velocity.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createConjunctionCommandHarness } from './lib/conjunctionCommandHarness.mjs';
import { decodeCqr, earthFrame, encodeCqr, initCqrFlatc, screeningControls, gpSource, gpRecord, publishedSchema } from './lib/cqr.mjs';
import { uncertaintyModelFrame } from '../scripts/uncertainty-model.mjs';

const [GRUS, STARLINK] = JSON.parse(fs.readFileSync(new URL('./fixtures/socrates/gp_47935,49179.json', import.meta.url)));
const TCA = Date.parse('2026-03-12T04:44:40.733Z') / 86400000 + 2440587.5;
const SIGMA_KM = [0.1, 1.0, 0.1];
const covariance = [SIGMA_KM[0] ** 2, 0, SIGMA_KM[1] ** 2, 0, 0, SIGMA_KM[2] ** 2, 0, 0, 0, 1e-6, 0, 0, 0, 0, 1e-6, 0, 0, 0, 0, 0, 1e-6];
const model = (ages = [[0, 7]]) => ({ kind: 'gp-error-model', regimes: [{ id: 'all', altitudeKm: [0, 1e9], eccentricity: [0, 1] }],
  ageBinsDays: ages, strata: [{ regimeIndex: 0, ageIndex: 0, covariance }] });
const calibrated = { strata: [{ regimeIndex: 0, ageIndex: 0, label: 'CALIBRATED', reference: 'held-out reference states (test)' }] };

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => a.map((x) => x / Math.sqrt(dot(a, a)));
const km = (v) => [v.X, v.Y, v.Z].map((x) => x / 1000);
function expectedPc(e, radiusKm) {
  const states = [e.PRIMARY_STATE.STATE, e.SECONDARY_STATE.STATE].map((s) => ({ r: km(s.POSITION), v: km(s.VELOCITY) }));
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const { r, v } of states) {
    const R = unit(r), N = unit(cross(r, v)), T = cross(N, R);
    [R, T, N].forEach((a, k) => { for (let i = 0; i < 3; ++i) for (let j = 0; j < 3; ++j) C[i][j] += SIGMA_KM[k] ** 2 * a[i] * a[j]; });
  }
  const dr = states[1].r.map((x, i) => x - states[0].r[i]), u = unit(states[1].v.map((x, i) => x - states[0].v[i]));
  const perp = dr.map((x, i) => x - dot(dr, u) * u[i]);
  const e1 = unit(perp), e2 = cross(u, e1), miss = Math.sqrt(dot(perp, perp));
  const q = (a, b) => dot(a, [0, 1, 2].map((i) => dot(C[i], b)));
  const [sxx, sxy, syy] = [q(e1, e1), q(e1, e2), q(e2, e2)];
  const det = sxx * syy - sxy * sxy;
  let pc = 0;
  const nr = 400, nt = 720;
  for (let i = 0; i < nr; ++i) for (let j = 0; j < nt; ++j) {
    const rho = (i + 0.5) / nr * radiusKm, th = (j + 0.5) / nt * 2 * Math.PI;
    const x = rho * Math.cos(th) - miss, y = rho * Math.sin(th);
    pc += Math.exp(-0.5 * (syy * x * x - 2 * sxy * x * y + sxx * y * y) / det) * rho;
  }
  return pc * (radiusKm / nr) * (2 * Math.PI / nt) / (2 * Math.PI * Math.sqrt(det));
}

const flatc = await initCqrFlatc();
const pair = (algorithm) => encodeCqr(flatc, { PAIR_REQUEST: { PRIMARY: gpSource(GRUS), SECONDARY: gpSource(STARLINK),
  CONTROLS: { ...screeningControls({ startJd: TCA - 60 / 86400, durationSeconds: 120, coarseStepSec: 5 }), ALGORITHM: algorithm },
  PRIMARY_RADIUS_M: 5, SECONDARY_RADIUS_M: 5, EVALUATION_FRAME: earthFrame('TEME') } });
async function assess(h, algorithm, frame) {
  const inputs = [{ portId: 'request', payload: pair(algorithm) }];
  if (frame) inputs.push({ portId: 'uncertainty_model', payload: frame });
  const r = await h.invoke({ methodId: 'assess_conjunction', inputs });
  assert.equal(r.statusCode, 0, r.errorMessage);
  return decodeCqr(flatc, r.outputs[0].payload).EVENT_RESULT;
}

test('an element-set pair takes the model covariance at its prediction age, with the gate\'s label', async () => {
  const h = await createConjunctionCommandHarness({ runtimeKind: 'browser' });
  try {
    const e = await assess(h, 'FOSTER', uncertaintyModelFrame(model(), calibrated, 'test'));
    assert.equal(e.PROBABILITY.ALGORITHM, 'FOSTER');
    assert.equal(e.PROBABILITY.UNCERTAINTY_SOURCE, 'SYNTHESIZED_COVARIANCE');
    assert.equal(e.PRIMARY_COVARIANCE_BASIS, 'EMPIRICAL_MODEL');
    assert.equal(e.SECONDARY_COVARIANCE_BASIS, 'EMPIRICAL_MODEL');
    assert.equal(e.PROBABILITY.CALIBRATION, 'Calibrated');
    assert.equal(e.PROBABILITY.CALIBRATION_REFERENCE, 'held-out reference states (test)');
    assert.equal(e.PROBABILITY.CROSS_CORRELATION, 'INDEPENDENT');
    assert.equal(e.HAS_DILUTION_THRESHOLD_M, false);
    for (const s of [e.PRIMARY_SIGMA_RTN_M, e.SECONDARY_SIGMA_RTN_M])
      assert.deepEqual([s.X, s.Y, s.Z].map(Math.round), [100, 1000, 100]);
    const expected = expectedPc(e, 0.010);
    assert.ok(Math.abs(e.PROBABILITY.PROBABILITY / expected - 1) < 1e-3, `Pc ${e.PROBABILITY.PROBABILITY} vs ${expected}`);

    const unlabelled = await assess(h, 'FOSTER', uncertaintyModelFrame(model()));
    assert.equal(unlabelled.PROBABILITY.CALIBRATION, 'Uncalibrated');
    assert.equal(unlabelled.PROBABILITY.CALIBRATION_REFERENCE ?? '', '');
    assert.equal(unlabelled.PROBABILITY.PROBABILITY, e.PROBABILITY.PROBABILITY);
  } finally {
    await h.destroy?.();
  }
});

test('outside the model\'s ages, or with ALFANO_MAXIMUM, the event keeps the Alfano maximum', async () => {
  const h = await createConjunctionCommandHarness({ runtimeKind: 'browser' });
  try {
    for (const e of [await assess(h, 'FOSTER', uncertaintyModelFrame(model([[0, 1]]), calibrated)),
      await assess(h, 'ALFANO_MAXIMUM', uncertaintyModelFrame(model(), calibrated))]) {
      assert.equal(e.PROBABILITY.UNCERTAINTY_SOURCE, 'MAXIMUM_PROBABILITY_ONLY');
      assert.equal(e.PRIMARY_COVARIANCE_BASIS, 'NONE');
    }
  } finally {
    await h.destroy?.();
  }
});

test('catalog and refinement screens label their events the same way', async () => {
  const h = await createConjunctionCommandHarness({ runtimeKind: 'browser' });
  try {
    const frame = uncertaintyModelFrame(model(), calibrated, 'test');
    const reference = await assess(h, 'FOSTER', frame);
    const controls = { ...screeningControls({ startJd: TCA - 0.5, durationDays: 1, thresholdKm: 5 }), ALGORITHM: 'FOSTER' };
    const catalog = await h.invoke({ methodId: 'screen_catalog', inputs: [
      { portId: 'request', payload: encodeCqr(flatc, { CATALOG_REQUEST: { CONTROLS: controls, EVALUATION_FRAME: earthFrame('TEME') } }) },
      ...[GRUS, STARLINK].map((g) => ({ portId: 'catalog', payload: flatc.generateBinary(publishedSchema('OMM'), JSON.stringify(gpRecord(g)), { sizePrefix: false }) })),
      { portId: 'uncertainty_model', payload: frame }] });
    assert.equal(catalog.statusCode, 0, catalog.errorMessage);
    const INSTANCE = { MODULE_ID: 'conjunction-assessment', INSTANCE_ID: 'empirical', GENERATION: 1 };
    const prepared = await h.invoke({ methodId: 'prepare_screening_index', inputs: [{ portId: 'request', payload: encodeCqr(flatc, { INDEX_REQUEST: {
      INSTANCE, INDEX_CONTENT: 'SOURCE_DESCRIPTIONS', REFINEMENT_MODE: 'EXACT_ONLY',
      SOURCES: [GRUS, STARLINK].map((g, i) => ({ ...gpSource(g), SOURCE_HANDLE: i + 1 })) } }) }] });
    assert.equal(prepared.statusCode, 0, prepared.errorMessage);
    const { SCREENING_INDEX_HANDLE } = decodeCqr(flatc, prepared.outputs[0].payload).INDEX_RESULT;
    const refined = await h.invoke({ methodId: 'refine_candidates', inputs: [
      { portId: 'request', payload: encodeCqr(flatc, { WINDOW_REQUEST: { INSTANCE, SCREENING_INDEX_HANDLE, CONTROLS: controls, EVALUATION_FRAME: earthFrame('TEME') } }) },
      { portId: 'uncertainty_model', payload: frame }] });
    assert.equal(refined.statusCode, 0, refined.errorMessage);
    for (const [label, r] of [['screen_catalog', catalog], ['refine_candidates', refined]]) {
      const events = decodeCqr(flatc, r.outputs.find((f) => f.portId === 'result').payload).CATALOG_RESULT.EVENTS;
      const e = events.find((x) => Math.abs(x.TCA.JULIAN_DATE - TCA) * 86400 < 1);
      assert.ok(e, `${label}: the 14 m event`);
      assert.equal(e.PROBABILITY.UNCERTAINTY_SOURCE, 'SYNTHESIZED_COVARIANCE', label);
      assert.equal(e.PRIMARY_COVARIANCE_BASIS, 'EMPIRICAL_MODEL', label);
      assert.equal(e.PROBABILITY.CALIBRATION, 'Calibrated', label);
      // Same geometry to the solvers' tolerance, so the same probability to 1 %.
      assert.ok(Math.abs(e.PROBABILITY.PROBABILITY / reference.PROBABILITY.PROBABILITY - 1) < 0.01,
        `${label}: ${e.PROBABILITY.PROBABILITY} vs pair ${reference.PROBABILITY.PROBABILITY}`);
    }
  } finally {
    await h.destroy?.();
  }
});

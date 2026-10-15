// attach_covariance and attribute_maneuvers (the catalog pipeline's covariance for every object).
// Every expected value is computed here from the model file (E14's frozen S3-KC strata and the verdicts of its held-out
// window), from designed inputs, or by an independent rotation; none comes from the module:
// - rules 3 and 4: the stratum of the object's regime, linear in age between bin centres, and its cell's verdict;
// - rule 1: the supplied covariance exactly, and its rotation to RTN for an operator that states it in inertial axes;
// - rule 2: the formal covariance times the realism factor of the recipe;
// - records: decoded with the generated SDS bindings, hashes with node:crypto;
// - the source: PROVENANCE (PVN) of each record equals the recipe's source, and no label of it rides in USER_DEFINED_PARAMETERS,
//   COMMENT or TAGS; the covariance's label: one CVR per covariance epoch (COV_REALISM), its verdict by the CVR's own rule.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import { validateArtifactWithStandards } from 'space-data-module-sdk/compliance';
import { fileURLToPath } from 'node:url';
import { standardsRoot } from '../scripts/erm-codec.mjs';
import { decode, ermFrame, json as json2 } from './erm-harness.mjs';
import {
  OCM, OEM, OMM, MNV, PVN_LICENCES, assertSourceNamed, call, cellOf, deriveStates, encodeMnv, encodeOmm, expectedCovariance, expectedProvenance, fitOcm, json, kc, leoH,
  manifest, mnvFrame, beyond, ommFrame, ocmFrame, oemFrame, operatorOem, output, provenanceOf, recipeFor, records, reportOf, unpackMnv, unpackOcm, unpackOmm, valladoOmm, vallado,
} from './products-fixtures.mjs';

const close = (a, b, what, tolerance = 1e-12) => assert.ok(Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(b)), `${what}: ${a} vs ${b}`);
const closeAll = (a, b, what, tolerance) => { assert.equal(a.length, b.length, `${what} length`); a.forEach((x, i) => close(x, b[i], `${what}[${i}]`, tolerance)); };
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

async function attach(sets, { ages = [0], recipe = recipeFor(), operator, fit, overrides } = {}) {
  const stream = Buffer.concat(sets.map((s, i) => encodeOmm(s, overrides?.(s, i) ?? {})));
  const states = await deriveStates(stream, ages);
  const inputs = [ommFrame('elements', stream), oemFrame('states', states), json('recipe', recipe)];
  if (operator) inputs.push(oemFrame('operator', operator));
  if (fit) inputs.push(ocmFrame('fit', fit));
  const response = await call('attach_covariance', inputs);
  assert.equal(response.statusCode, 0, response.errorMessage);
  return {
    report: reportOf(response),
    ocms: records(output(response, 'ocm')).map(unpackOcm),
    ocmBytes: records(output(response, 'ocm')),
    omms: records(output(response, 'omm')).map(unpackOmm),
    ommBytes: records(output(response, 'omm')),
    states,
  };
}
const Calibrated = OCM.covarianceCalibration.Calibrated, Uncalibrated = OCM.covarianceCalibration.Uncalibrated;
const verdictOf = (cell) => (cell.calibration === 'CALIBRATED' ? Calibrated : Uncalibrated);
const lowerOf = (ocm, k) => ocm.COVARIANCE_DATA.slice(21 * k, 21 * k + 21);

test('the artifact passes SDK compliance', async () => {
  const report = await validateArtifactWithStandards({ manifest, wasmPath: fileURLToPath(new URL('../dist/isomorphic/module.wasm', import.meta.url)),
    standardsRoot });
  assert.equal(report.ok, true, JSON.stringify(report.issues.filter((i) => i.severity === 'error'), null, 2));
});

test('rule 3: the model covariance at each age, with the held-out verdict of each row\'s cell', async () => {
  const ages = [0, 0.5, 1, 3];
  const recipe = recipeFor();
  const { report, ocms, ocmBytes, omms, ommBytes, states } = await attach([leoH], { ages, recipe });
  assert.equal(report.counts.rule3, 1);
  assert.equal(ocms.length, 1);
  const ocm = ocms[0];
  assert.deepEqual(ocm.STATE_EPOCHS.map((e) => e.slice(0, 19)), ['2026-10-01T12:00:00', '2026-10-02T00:00:00', '2026-10-02T12:00:00', '2026-10-04T12:00:00']);
  assert.equal(ocm.TRAJ_REF_FRAME.NAME, 'GCRF');
  assert.equal(ocm.COV_REF_FRAME.NAME, 'RSW');
  assert.equal(ocm.COV_REF_FRAME.REFERENCE_FRAME.frame, OCM.OrbitFrame.RSW_INERTIAL);
  // The states are epoch-state's, unchanged.
  const oem = OEM.OEM.getSizePrefixedRootAsOEM(new (await import('./products-fixtures.mjs')).flatbuffers.ByteBuffer(new Uint8Array(states))).unpack();
  oem.EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES.forEach((line, k) => closeAll(ocm.STATE_DATA.slice(6 * k, 6 * k + 6), [line.X, line.Y, line.Z, line.X_DOT, line.Y_DOT, line.Z_DOT], `state ${k}`, 0));
  // Rows 1 and 2 fall in the age bins of horizons 0.5 and 1 and are interpolated linearly between bin centres.
  const cellIndex = [0, 1, 2, 4];
  ages.forEach((age, k) => {
    closeAll(lowerOf(ocm, k), expectedCovariance('LEO-H', age), `covariance at ${age} d`);
    const cvr = ocm.COV_REALISM[k];
    const cell = cellOf('LEO-H', cellIndex[k]);
    assert.equal(cvr.RULE, OCM.covarianceRule.SourceModel);
    assert.equal(cvr.MODEL_ID, kc.id);
    assert.equal(cvr.REGIME, 'LEO-H');
    close(cvr.AGE_DAYS, age, `age at row ${k}`);
    assert.equal(cvr.HORIZON_DAYS, cell.horizonDays);
    assert.equal(cvr.MEASURED_LINEAGE, 'space-track-gp', 'the lineage the cell was measured on, which is the source\'s');
    assert.equal(cvr.TEST_WINDOW, kc.measuredOn.window.replace('..', '/'), 'an ISO 8601 interval');
    assert.equal(cvr.MEAN_D2_OVER_3, cell.meanD2Over3);
    assert.equal(cvr.COVERAGE_95, cell.coverage95);
    assert.equal(cvr.SAMPLES, cell.samples);
    assert.equal(cvr.OBJECTS, cell.objects);
    assert.ok(Number.isNaN(cvr.SCALE_FACTOR), 'the model applies no factor');
    assert.equal(cvr.CALIBRATION, verdictOf(cell));
    assert.equal(cvr.EVIDENCE, kc.measuredOn.evidence);
  });
  assert.equal(ocm.COV_REALISM.length, ages.length, 'one CVR per covariance epoch');
  // E14 found LEO-H realistic at 0 and 0.5 days only.
  assert.deepEqual(ocm.COV_REALISM.map((c) => c.CALIBRATION), [Calibrated, Calibrated, Uncalibrated, Uncalibrated]);
  assert.equal(ocm.COV_CALIBRATION, Uncalibrated, 'Calibrated only when every row is');
  assert.equal(ocm.COV_CALIBRATION_REFERENCE, kc.measuredOn.evidence);
  // The source is PROVENANCE; the message's creator is the producer, and nothing is appended to COMMENT.
  assertSourceNamed(ocm, recipe);
  assert.deepEqual(ocm.HEADER.COMMENT, []);
  assert.equal(ocm.HEADER.ORIGINATOR, 'SDN catalog pipeline');
  assert.equal(ocm.METADATA.OBJECT_DESIGNATOR, '90101');
  // The OMM: the source's set with the covariance at its epoch (RTN), the CVR of that row, the source in PROVENANCE.
  assert.equal(omms.length, 1);
  closeAll(omms[0].COVARIANCE, expectedCovariance('LEO-H', 0), 'OMM covariance');
  assert.equal(omms[0].COV_REFERENCE_FRAME.NAME, 'RSW');
  assert.deepEqual({ ...omms[0].COV_REALISM }, { ...ocm.COV_REALISM[0] }, 'the CVR of the row the covariance is of');
  assertSourceNamed(omms[0], recipe);
  assert.equal(omms[0].ORIGINATOR, 'SDN catalog pipeline', 'the message\'s creator; the source\'s originator is PROVENANCE.ORIGINATOR');
  assert.equal(omms[0].COMMENT, 'GP_ID 1', 'the set\'s own comment, nothing appended');
  // The report cites each record by its hash.
  assert.equal(report.objects[0].ocmSha256, sha256(ocmBytes[0]));
  assert.equal(report.objects[0].ommSha256, sha256(ommBytes[0]));
});

test('rule 3: every row calibrated makes the OCM Calibrated', async () => {
  const { ocms } = await attach([leoH], { ages: [0, 0.5] });
  assert.equal(ocms[0].COV_CALIBRATION, OCM.covarianceCalibration.Calibrated);
});

test('rule 4: a source with no model of its own uses the pooled model, uncalibrated where it was never measured', async () => {
  const recipe = recipeFor({ id: 'spacemapper-aoe', lineage: 'spacemapper-aoe', own: false });
  const { report, ocms, omms } = await attach([leoH], { ages: [0, 0.5], recipe });
  assert.equal(report.counts.rule4, 1);
  const ocm = ocms[0];
  closeAll(lowerOf(ocm, 0), expectedCovariance('LEO-H', 0), 'covariance');
  const [row] = ocm.COV_REALISM;
  assert.equal(row.RULE, OCM.covarianceRule.PooledModel);
  assert.equal(row.MODEL_ID, kc.id);
  // The cell passed on Space-Track's sets; it says nothing about another lineage's, so the CVR does not borrow it: the lineage
  // is the cell's, the numbers are kept, and the verdict is Uncalibrated.
  assert.equal(row.CALIBRATION, Uncalibrated);
  assert.equal(row.MEASURED_LINEAGE, 'space-track-gp');
  close(row.MEAN_D2_OVER_3, cellOf('LEO-H', 0).meanD2Over3, 'the pooled cell\'s numbers are kept', 0);
  assert.equal(ocm.COV_CALIBRATION, Uncalibrated);
  assert.equal(omms[0].COV_REALISM.RULE, OCM.covarianceRule.PooledModel);
  assert.equal(omms[0].COV_REALISM.CALIBRATION, Uncalibrated);
  assertSourceNamed(omms[0], recipe);
  assert.equal(report.objects[0].rows[0].measuredLineage, 'space-track-gp');
  assert.match(report.objects[0].rows[0].basis, /not measured on spacemapper-aoe/);
});

test('every regime the model covers gets its stratum; HEO has no model and a set beyond every regime has none; both are reported, not guessed', async () => {
  const sets = [valladoOmm(6251), valladoOmm(28057), valladoOmm(5), valladoOmm(14128), valladoOmm(9880), leoH, beyond];
  const { report, ocms, omms } = await attach(sets);
  const byKey = new Map(ocms.map((o) => [o.COV_REALISM[0].REGIME, o]));
  const expectRegime = { 'LEO-L': 6251, 'LEO-M': 28057, MEO: 5, GEO: 14128, 'LEO-H': 90101 };
  for (const [regime, id] of Object.entries(expectRegime)) {
    const ocm = byKey.get(regime);
    assert.ok(ocm, `${regime} has an OCM`);
    closeAll(lowerOf(ocm, 0), expectedCovariance(regime, 0), `${regime} covariance`);
    assert.equal(ocm.COV_REALISM[0].CALIBRATION, verdictOf(cellOf(regime, 0)));
    assert.ok(id);
  }
  assert.equal(ocms.length, 5);
  assert.equal(omms.length, 7, 'every element set is published, with or without a covariance');
  assert.equal(report.counts.withoutCovariance, 2);
  const reasons = Object.fromEntries(report.objects.filter((o) => o.rule === null).map((o) => [o.object, o.notes.map((n) => n.reason).join(';')]));
  assert.match(reasons['1977-021A'], /no-model-for-regime/);
  assert.match(reasons['2026-102A'] ?? reasons['NORAD:90102'], /outside-regimes/);
  const heo = omms.find((o) => o.OBJECT_ID === '1977-021A');
  assert.equal(heo.COVARIANCE.length, 0);
  assert.equal(heo.COV_REALISM, null, 'no covariance, no CVR; the report says why');
  assert.equal(heo.COMMENT, 'GP_ID 1');
  assertSourceNamed(heo, recipeFor());
});

test('the newest set of each object gives the outputs; latestOnly false gives all', async () => {
  const older = { ...leoH, epoch: '2026-09-30T12:00:00.000000' };
  const newest = await attach([older, leoH]);
  assert.equal(newest.ocms.length, 1);
  assert.equal(newest.ocms[0].STATE_EPOCHS[0].slice(0, 10), '2026-10-01');
  const every = await attach([older, leoH], { recipe: recipeFor({ extra: { latestOnly: false } }) });
  assert.equal(every.ocms.length, 2);
});

test('SGP4-XP sets are published with their source and no covariance until the XP propagator and model land', async () => {
  const { report, ocms, omms } = await attach([leoH, { ...valladoOmm(6251), norad: 90103, objectId: '2026-103A' }], { overrides: (s, i) => (i === 1 ? { MEAN_ELEMENT_THEORY: OMM.meanElementSource.SGP4XP } : {}) });
  assert.equal(ocms.length, 1);
  const xp = omms.find((o) => o.NORAD_CAT_ID === 90103);
  assert.equal(xp.MEAN_ELEMENT_THEORY, OMM.meanElementSource.SGP4XP);
  assert.equal(xp.COVARIANCE.length, 0);
  assert.equal(xp.COV_REALISM, null);
  assertSourceNamed(xp, recipeFor());
  assert.match(JSON.stringify(report.objects.find((o) => o.object === 'NORAD:90103').notes), /sgp4xp-no-propagator-or-error-model/);
  assert.equal(report.counts.withoutCovariance, 1);
});

// ── rule 1 ──
const LEO_M = valladoOmm(28057);
const at = (seconds) => new Date(Date.parse('2006-06-27T06:52:04.079712Z') + seconds * 1000).toISOString();
const designed = (k) => Array.from({ length: 21 }, (_, i) => (i === 0 || i === 2 || i === 5 ? (k + 1) * 1e-4 : (i === 9 || i === 14 || i === 20 ? (k + 1) * 1e-10 : (i + 1) * 1e-9 * (k + 1))));

test('rule 1: the operator\'s covariance as supplied beats the model; the OMM carries it at the epoch', async () => {
  const c = vallado.find((x) => x.satnum === 28057);
  const rows = [0, 1, 2, 3, 4].map((k) => ({ epoch: at(60 * k), x: [...c.gcrfR.map((v, i) => v + 0.1 * k + i), ...c.gcrfV] }));
  const cov = [0, 2, 4].map((k) => ({ epoch: at(60 * k), lower: designed(k) }));
  const operator = operatorOem({ objectId: LEO_M.objectId, name: LEO_M.name, rows, cov, covFrame: 'UVW' });
  const recipe = recipeFor({ id: 'spacex-starlink', lineage: 'spacex-meme', kind: 'ephemeris', own: false, licence: 'reproducible', extra: { maxOperatorRows: 2 } });
  const { report, ocms, omms } = await attach([LEO_M], { recipe, operator });
  assert.equal(report.counts.rule1, 1);
  assert.equal(report.counts.rule3 + report.counts.rule4, 0);
  const ocm = ocms[0];
  assert.equal(ocm.STATE_EPOCHS.length, 2, 'at most maxOperatorRows covariance epochs: the first and the last');
  closeAll(lowerOf(ocm, 0), designed(0), 'first covariance, as supplied', 0);
  closeAll(lowerOf(ocm, 1), designed(4), 'last covariance, as supplied', 0);
  closeAll(ocm.STATE_DATA.slice(0, 6), rows[0].x, 'state at the first covariance epoch', 0);
  closeAll(ocm.STATE_DATA.slice(6, 12), rows[4].x, 'state at the last covariance epoch', 0);
  assert.equal(ocm.TRAJ_REF_FRAME.NAME, 'GCRF');
  assert.equal(ocm.COV_REF_FRAME.NAME, 'UVW');
  assert.equal(ocm.COV_REALISM.length, 2);
  const cvr = ocm.COV_REALISM[0];
  assert.equal(cvr.RULE, OCM.covarianceRule.Operator);
  assert.equal(cvr.CALIBRATION, Uncalibrated, 'operator covariance is not measured until E14 S1 reports');
  assert.ok(!cvr.MODEL_ID && !cvr.REGIME && Number.isNaN(cvr.MEAN_D2_OVER_3) && cvr.SAMPLES === 0, 'a supplied covariance names no model and no test');
  assert.equal(ocm.COV_CALIBRATION, Uncalibrated);
  assertSourceNamed(ocm, recipe);
  // UVW is RTN: the OMM's covariance is the supplied one.
  closeAll(omms[0].COVARIANCE, designed(0), 'OMM covariance', 0);
  assert.equal(omms[0].COV_REALISM.RULE, OCM.covarianceRule.Operator);
  assertSourceNamed(omms[0], recipe);
});

test('rule 1: a covariance in the state\'s inertial axes reaches the OMM rotated to RTN', async () => {
  const c = vallado.find((x) => x.satnum === 28057);
  const r = c.gcrfR, v = c.gcrfV;
  const unit = (a) => a.map((x) => x / Math.hypot(...a));
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const R = unit(r), N = unit(cross(r, v)), T = cross(N, R);
  const A = [R, T, N];
  // A diagonal covariance in GCRF axes: position variances 1, 4, 9 m^2 (in km^2) and velocity variances 1e-8, 4e-8, 9e-8.
  const diag = [1e-6, 4e-6, 9e-6, 1e-14, 4e-14, 9e-14];
  const lower = []; for (let a = 0; a < 6; a++) for (let b = 0; b <= a; b++) lower.push(a === b ? diag[a] : 0);
  const rows = [{ epoch: at(0), x: [...r, ...v] }, { epoch: at(60), x: [...r, ...v] }];
  const operator = operatorOem({ objectId: LEO_M.objectId, name: LEO_M.name, rows, cov: [{ epoch: at(0), lower }], covFrame: 'GCRF' });
  const { omms } = await attach([LEO_M], { recipe: recipeFor({ id: 'iss-oem', kind: 'ephemeris', own: false, lineage: 'nasa-oem' }), operator });
  // P_rtn = A P A' for each 3x3 block (position, velocity).
  const block = (d) => A.map((ra) => A.map((rb) => [0, 1, 2].reduce((s, k) => s + ra[k] * d[k] * rb[k], 0)));
  const expected = [];
  const bp = block(diag.slice(0, 3)), bv = block(diag.slice(3));
  for (let a = 0; a < 6; a++) for (let b = 0; b <= a; b++) expected.push(a < 3 && b < 3 ? bp[a][b] : a >= 3 && b >= 3 ? bv[a - 3][b - 3] : 0);
  closeAll(omms[0].COVARIANCE, expected, 'RTN covariance', 1e-9);
});

test('rule 1 refuses a covariance frame it cannot rotate, and the model answers instead', async () => {
  const c = vallado.find((x) => x.satnum === 28057);
  const rows = [{ epoch: at(0), x: [...c.gcrfR, ...c.gcrfV] }];
  const operator = operatorOem({ objectId: LEO_M.objectId, name: LEO_M.name, rows, cov: [{ epoch: at(0), lower: designed(0) }], covFrame: 'ITRF' });
  const { report, ocms } = await attach([LEO_M], { operator, recipe: recipeFor({ id: 'planet-oem', kind: 'ephemeris', own: false, lineage: 'planet-oem' }) });
  assert.equal(report.counts.rule4, 1);
  assert.equal(ocms[0].COV_REALISM[0].RULE, OCM.covarianceRule.PooledModel);
  assert.match(JSON.stringify(report.objects[0].notes), /covariance frame ITRF is not RTN-family/);
});

// ── rule 2 ──
test('rule 2: a fit\'s formal covariance times the realism factor measured for the source and fit class', async () => {
  const x = [4000.5, 5000.25, 3000.125, -3.5, 4.25, 4.75];
  const lower = designed(1);
  const fit = fitOcm({ norad: 90101, name: leoH.name, epoch: '2026-10-01T12:00:00.000000', x, lower });
  const realism = [{ sources: ['ilrs-crd'], class: 'slr-hpop-fit', factor: 17.04, meanD2Over3: 17.04, coverage95: 0.17, samples: 1000, objects: 5,
    evidence: 'orbit-accuracy-experiments E6 test', window: '2026-05-01..2026-09-30' }];
  const recipe = recipeFor({ id: 'ilrs-crd', kind: 'observation', lineage: 'ilrs-slr', own: false, fitClass: 'slr-hpop-fit', extra: { realism } });
  const { report, ocms, omms } = await attach([leoH], { recipe, fit });
  assert.equal(report.counts.rule2, 1);
  const ocm = ocms[0];
  closeAll(lowerOf(ocm, 0), lower.map((v) => v * 17.04), 'scaled covariance');
  closeAll(ocm.STATE_DATA, x, 'fit state', 0);
  const cvr = ocm.COV_REALISM[0];
  assert.equal(cvr.RULE, OCM.covarianceRule.ScaledFit);
  assert.equal(cvr.MODEL_ID, 'slr-hpop-fit');
  assert.equal(cvr.SCALE_FACTOR, 17.04);
  assert.equal(cvr.MEAN_D2_OVER_3, 17.04, 'the measured error of the formal covariance, before scaling');
  assert.equal(cvr.COVERAGE_95, 0.17);
  assert.deepEqual([cvr.SAMPLES, cvr.OBJECTS], [1000, 5]);
  assert.equal(cvr.MEASURED_LINEAGE, 'ilrs-slr');
  assert.equal(cvr.TEST_WINDOW, '2026-05-01/2026-09-30');
  assert.equal(cvr.CALIBRATION, Uncalibrated, 'the scaled covariance has not been tested itself');
  assert.equal(cvr.EVIDENCE, 'orbit-accuracy-experiments E6 test');
  assert.equal(ocm.COV_CALIBRATION_REFERENCE, 'orbit-accuracy-experiments E6 test');
  assertSourceNamed(ocm, recipe);
  // The OMM carries the scaled covariance in RTN: the fit's TEME axes rotated by the fit state's own RTN.
  const unit = (a) => a.map((v) => v / Math.hypot(...a));
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const R = unit(x.slice(0, 3)), N = unit(cross(x.slice(0, 3), x.slice(3))), T = cross(N, R);
  const A = [R, T, N];
  const full = (l) => { const m = Array.from({ length: 6 }, () => Array(6).fill(0)); let t = 0; for (let a = 0; a < 6; a++) for (let b = 0; b <= a; b++) { m[a][b] = m[b][a] = l[t++]; } return m; };
  const J = Array.from({ length: 6 }, (_, i) => Array.from({ length: 6 }, (_, j) => ((i < 3) === (j < 3) ? A[i % 3][j % 3] : 0)));
  const P = full(lower.map((v) => v * 17.04));
  const JP = J.map((row) => P[0].map((_, j) => row.reduce((s, v, k) => s + v * P[k][j], 0)));
  const expected = []; for (let a = 0; a < 6; a++) for (let b = 0; b <= a; b++) expected.push(JP[a].reduce((s, v, k) => s + v * J[b][k], 0));
  closeAll(omms[0].COVARIANCE, expected, 'RTN covariance of the scaled fit', 1e-9);
});

test('rule 2 needs a measured factor for the source and class; without one the next rule answers', async () => {
  const fit = fitOcm({ norad: 90101, name: leoH.name, epoch: '2026-10-01T12:00:00.000000', x: [4000, 5000, 3000, -3.5, 4.25, 4.75], lower: designed(1) });
  const recipe = recipeFor({ id: 'od-fit-source', kind: 'observation', lineage: 'x', own: false, fitClass: 'od-sgp4-fit',
    extra: { realism: [{ sources: ['ilrs-crd'], class: 'slr-hpop-fit', factor: 17.04 }] } });
  const { report, ocms } = await attach([leoH], { recipe, fit });
  assert.equal(report.counts.rule2, 0);
  assert.equal(report.counts.rule4, 1);
  assert.equal(ocms[0].COV_REALISM[0].RULE, OCM.covarianceRule.PooledModel);
  assert.match(JSON.stringify(report.objects[0].notes), /no measured realism factor for source od-fit-source and fit class od-sgp4-fit/);
});

// ── the CVR's own rule ──
test('a row is Calibrated by the numbers of its cell: mean d2/3 in [0.8, 1.25], coverage in [0.93, 0.97], from at least 30 samples of 3 objects of the lineage', async () => {
  // The model file calls the LEO-H cell at 0 days CALIBRATED; each variant changes one of its numbers, and the file's word does not decide.
  const verdict = async (changed) => {
    const model = { ...kc, sources: ['celestrak-gp'], pooled: true, cells: kc.cells.map((c) => (c.regime === 'LEO-H' && c.ageIndex === 0 ? { ...c, ...changed } : c)) };
    const { ocms } = await attach([leoH], { recipe: recipeFor({ extra: { models: [model] } }) });
    return ocms[0].COV_REALISM[0].CALIBRATION;
  };
  assert.equal(await verdict({}), Calibrated);
  for (const changed of [{ meanD2Over3: 0.8 }, { meanD2Over3: 1.25 }, { coverage95: 0.93 }, { coverage95: 0.97 }, { samples: 30 }, { objects: 3 }]) {
    assert.equal(await verdict(changed), Calibrated, `${JSON.stringify(changed)} is on the bound`);
  }
  for (const changed of [{ meanD2Over3: 0.79 }, { meanD2Over3: 1.26 }, { coverage95: 0.92 }, { coverage95: 0.98 }, { samples: 29 }, { objects: 2 }]) {
    assert.equal(await verdict(changed), Uncalibrated, `${JSON.stringify(changed)} is past the bound`);
  }
});

// ── attribute_maneuvers ──
test('attribute_maneuvers names the source in the PROVENANCE of every maneuver, keeps what the record had and the detector as its producer', async () => {
  const detector = 'com.digitalarsenal.analysis.maneuver-detection 0.5.0';
  const made = Object.assign(new MNV.PVNT(), { PRODUCER: detector });
  const stream = Buffer.concat([encodeMnv(), encodeMnv({ ID: 'M2', PROVENANCE: made })]);
  const recipe = recipeFor();
  const response = await call('attribute_maneuvers', [mnvFrame('maneuvers', stream), json('recipe', recipe)]);
  assert.equal(response.statusCode, 0, response.errorMessage);
  const out = records(output(response, 'maneuvers')).map(unpackMnv);
  assert.equal(out.length, 2);
  assert.deepEqual(provenanceOf(out[0]), expectedProvenance(recipe, 'SDN catalog pipeline'), 'a record that names no producer gets the recipe\'s');
  assert.deepEqual(provenanceOf(out[1]), expectedProvenance(recipe, detector), 'the detector stays the producer');
  for (const m of out) assert.deepEqual(m.TAGS, ['existing'], 'no tag is added');
  assert.equal(out[0].EVENT_START_TIME, '2026-10-01T12:00:00.000Z');
  const report = reportOf(response);
  assert.equal(report.maneuvers, 2);
  assert.equal(report.source.id, 'celestrak-gp');
});

test('attribute_maneuvers reads the detector\'s frames, one plain FlatBuffer per event, as well as size-prefixed streams', async () => {
  const response = await call('attribute_maneuvers', [mnvFrame('maneuvers', encodeMnv({ ID: 'P1' }, { plain: true })), mnvFrame('maneuvers', encodeMnv({ ID: 'P2' }, { plain: true })), json('recipe', recipeFor())]);
  assert.equal(response.statusCode, 0, response.errorMessage);
  const out = records(output(response, 'maneuvers')).map(unpackMnv);
  assert.deepEqual(out.map((m) => m.ID), ['P1', 'P2']);
  for (const m of out) assertSourceNamed(m, recipeFor());
});

test('a recipe that does not name the source is refused', async () => {
  const bad = recipeFor();
  delete bad.source.provider;
  const stream = encodeOmm(leoH);
  const states = await deriveStates(stream);
  const response = await call('attach_covariance', [ommFrame('elements', stream), oemFrame('states', states), json('recipe', bad)]);
  assert.notEqual(response.statusCode, 0);
  assert.match(response.errorMessage, /recipe\.source\.provider is required/);
  // The licence class is one of the four the SDS PVN names.
  for (const [name, value] of Object.entries(PVN_LICENCES)) {
    const ok = await call('attribute_maneuvers', [mnvFrame('maneuvers', encodeMnv()), json('recipe', recipeFor({ licence: name }))]);
    assert.equal(ok.statusCode, 0, `${name}: ${ok.errorMessage}`);
    assert.equal(unpackMnv(records(output(ok, 'maneuvers'))[0]).PROVENANCE.LICENSE_CLASS, value, name);
  }
  const unknown = await call('attribute_maneuvers', [mnvFrame('maneuvers', encodeMnv()), json('recipe', recipeFor({ licence: 'public-domain' }))]);
  assert.notEqual(unknown.statusCode, 0);
  assert.match(unknown.errorMessage, /licence\.class is reproducible, cite-only, share-alike or non-commercial/);
});

test('data/e14-s3-kc.erm is E14\'s frozen model as one $ERM MODEL record: the JSON\'s numbers, and calibrate_covariance applies it as stored', async () => {
  const bytes = fs.readFileSync(new URL('../data/e14-s3-kc.erm', import.meta.url));
  const model = decode(bytes);
  assert.equal(model.calibrationVersion, kc.calibrationVersion);
  assert.deepEqual(model.regimes, kc.regimes);
  assert.deepEqual(model.ageBinsDays, kc.ageBinsDays);
  assert.deepEqual(model.strata.map((s) => s.covariance), kc.strata.map((s) => s.covariance));
  assert.deepEqual(model.cells.map(({ meanD2Over3, coverage95, samples, objects, decision, calibration }) => ({ meanD2Over3, coverage95, samples, objects, decision, calibration })),
    kc.cells.map(({ meanD2Over3, coverage95, samples, objects, decision, calibration }) => ({ meanD2Over3, coverage95, samples, objects, decision, calibration })));
  const response = await call('calibrate_covariance', [ermFrame('model', bytes), json2('objects', { objects: [{ id: 'h', regime: 'LEO-H', ageDays: 0 }] })]);
  assert.equal(response.statusCode, 0, response.errorMessage);
  const [h] = decode(output(response, 'covariance')).objects;
  closeAll(h.covarianceRtn, expectedCovariance('LEO-H', 0).map((x) => x * 1e6), 'the stratum covariance in SI', 0);
});

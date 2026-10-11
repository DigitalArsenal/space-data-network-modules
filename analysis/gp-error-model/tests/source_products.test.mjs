// attach_covariance and attribute_maneuvers (the catalog pipeline's covariance for every object).
// Every expected value is computed here from the model file (E14's frozen S3-KC strata and the verdicts of its held-out
// window), from designed inputs, or by an independent rotation; none comes from the module:
// - rules 3 and 4: the stratum of the object's regime, linear in age between bin centres, and its cell's verdict;
// - rule 1: the supplied covariance exactly, and its rotation to RTN for an operator that states it in inertial axes;
// - rule 2: the formal covariance times the realism factor of the recipe;
// - records: decoded with the generated SDS bindings, hashes with node:crypto.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { validateArtifactWithStandards } from 'space-data-module-sdk/compliance';
import { fileURLToPath } from 'node:url';
import {
  OCM, OEM, OMM, MNV, alignedOem, call, cellOf, deriveStates, encodeMnv, encodeOmm, expectedCovariance, fitOcm, json, kc, leoH, manifest, mnvFrame,
  beyond, ommFrame, ocmFrame, oemFrame, operatorOem, output, param, recipeFor, records, reportOf, unpackMnv, unpackOcm, unpackOmm, valladoOmm, vallado,
} from './products-fixtures.mjs';

const close = (a, b, what, tolerance = 1e-12) => assert.ok(Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(b)), `${what}: ${a} vs ${b}`);
const closeAll = (a, b, what, tolerance) => { assert.equal(a.length, b.length, `${what} length`); a.forEach((x, i) => close(x, b[i], `${what}[${i}]`, tolerance)); };
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

async function attach(sets, { ages = [0], recipe = recipeFor(), operator, fit, overrides } = {}) {
  const stream = Buffer.concat(sets.map((s, i) => encodeOmm(s, overrides?.(s, i) ?? {})));
  const states = await deriveStates(stream, ages);
  const inputs = [ommFrame('elements', stream), alignedOem('states', states), json('recipe', recipe)];
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
const labels = (ocm) => JSON.parse(param(ocm, 'COV_LABELS'));
const lowerOf = (ocm, k) => ocm.COVARIANCE_DATA.slice(21 * k, 21 * k + 21);

test('the artifact passes SDK compliance', async () => {
  const report = await validateArtifactWithStandards({ manifest, wasmPath: fileURLToPath(new URL('../dist/isomorphic/module.wasm', import.meta.url)),
    standardsRoot: fileURLToPath(new URL('../node_modules/spacedatastandards.org/', import.meta.url)) });
  assert.equal(report.ok, true, JSON.stringify(report.issues.filter((i) => i.severity === 'error'), null, 2));
});

test('rule 3: the model covariance at each age, with the held-out verdict of each row\'s cell', async () => {
  const ages = [0, 0.5, 1, 3];
  const { report, ocms, ocmBytes, omms, ommBytes, states } = await attach([leoH], { ages });
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
    const label = labels(ocm)[k];
    const cell = cellOf('LEO-H', cellIndex[k]);
    assert.equal(label.rule, 3);
    assert.equal(label.regime, 'LEO-H');
    assert.equal(label.cell.ageIndex, cellIndex[k]);
    assert.equal(label.calibration, cell.calibration);
    assert.equal(label.verdict, cell.decision);
    close(label.meanD2Over3, cell.meanD2Over3, `mean d2/3 at ${age} d`, 0);
    close(label.coverage95, cell.coverage95, `coverage at ${age} d`, 0);
    assert.equal(label.samples, cell.samples);
    assert.equal(label.objects, cell.objects);
  });
  // E14 found LEO-H realistic at 0 and 0.5 days only.
  assert.deepEqual(labels(ocm).map((l) => l.calibration), ['CALIBRATED', 'CALIBRATED', 'UNCALIBRATED', 'UNCALIBRATED']);
  assert.equal(ocm.COV_CALIBRATION, OCM.covarianceCalibration.Uncalibrated, 'Calibrated only when every row is');
  assert.match(ocm.COV_CALIBRATION_REFERENCE, /^orbit-accuracy-experiments E14 test 2026-05-01\.\.2026-09-30: LEO-H 0 d, mean d2\/3 0\.983, 95 % coverage 0\.946 \(4260 samples, 10 objects\)/);
  assert.equal(param(ocm, 'SOURCE_ID'), 'celestrak-gp');
  assert.equal(param(ocm, 'SOURCE_ORIGINATOR'), 'CelesTrak');
  assert.equal(param(ocm, 'SOURCE_PROVIDER'), 'sdn:celestrak-gp');
  assert.equal(param(ocm, 'LICENCE_CLASS'), 'redistributable');
  assert.equal(param(ocm, 'COV_RULE'), '3');
  assert.equal(ocm.HEADER.ORIGINATOR, 'CelesTrak');
  assert.equal(ocm.METADATA.OBJECT_DESIGNATOR, '90101');
  // The OMM: the source's set with the covariance at its epoch (RTN), the originator, and the label in COMMENT.
  assert.equal(omms.length, 1);
  closeAll(omms[0].COVARIANCE, expectedCovariance('LEO-H', 0), 'OMM covariance');
  assert.equal(omms[0].COV_REFERENCE_FRAME.NAME, 'RSW');
  assert.equal(omms[0].ORIGINATOR, 'CelesTrak');
  assert.match(omms[0].COMMENT, /^GP_ID 1 \| SDN covariance: rule 3 e14-s3-kc; CALIBRATED; orbit-accuracy-experiments E14 test 2026-05-01\.\.2026-09-30: LEO-H 0 d/);
  assert.match(omms[0].COMMENT, /\| source celestrak-gp, originator CelesTrak, provider sdn:celestrak-gp, licence redistributable$/);
  // The report cites each record by its hash.
  assert.equal(report.objects[0].ocmSha256, sha256(ocmBytes[0]));
  assert.equal(report.objects[0].ommSha256, sha256(ommBytes[0]));
});

test('rule 3: every row calibrated makes the OCM Calibrated', async () => {
  const { ocms } = await attach([leoH], { ages: [0, 0.5] });
  assert.equal(ocms[0].COV_CALIBRATION, OCM.covarianceCalibration.Calibrated);
});

test('rule 4: a source with no model of its own uses the pooled model, uncalibrated where it was never measured', async () => {
  const { report, ocms, omms } = await attach([leoH], { ages: [0, 0.5], recipe: recipeFor({ id: 'spacemapper-aoe', lineage: 'spacemapper-aoe', own: false }) });
  assert.equal(report.counts.rule4, 1);
  const ocm = ocms[0];
  closeAll(lowerOf(ocm, 0), expectedCovariance('LEO-H', 0), 'covariance');
  const [row] = labels(ocm);
  assert.equal(row.rule, 4);
  assert.equal(row.method, 'e14-s3-kc-pooled');
  // The cell passed on Space-Track's sets; it says nothing about another lineage's, so the label does not borrow it.
  assert.equal(row.calibration, 'UNCALIBRATED');
  assert.match(row.basis, /not measured on spacemapper-aoe/);
  close(row.meanD2Over3, cellOf('LEO-H', 0).meanD2Over3, 'the pooled cell\'s numbers are kept', 0);
  assert.equal(ocm.COV_CALIBRATION, OCM.covarianceCalibration.Uncalibrated);
  assert.match(omms[0].COMMENT, /rule 4 e14-s3-kc-pooled; UNCALIBRATED/);
});

test('every regime the model covers gets its stratum; HEO has no model and a set beyond every regime has none; both are reported, not guessed', async () => {
  const sets = [valladoOmm(6251), valladoOmm(28057), valladoOmm(5), valladoOmm(14128), valladoOmm(9880), leoH, beyond];
  const { report, ocms, omms } = await attach(sets);
  const byKey = new Map(ocms.map((o) => [param(o, 'COV_LABELS') && labels(o)[0].regime, o]));
  const expectRegime = { 'LEO-L': 6251, 'LEO-M': 28057, MEO: 5, GEO: 14128, 'LEO-H': 90101 };
  for (const [regime, id] of Object.entries(expectRegime)) {
    const ocm = byKey.get(regime);
    assert.ok(ocm, `${regime} has an OCM`);
    closeAll(lowerOf(ocm, 0), expectedCovariance(regime, 0), `${regime} covariance`);
    assert.equal(labels(ocm)[0].calibration, cellOf(regime, 0).calibration);
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
  assert.match(heo.COMMENT, /SDN covariance: unavailable \(no-model-for-regime\)/);
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
  assert.match(xp.COMMENT, /unavailable \(sgp4xp-no-propagator-or-error-model\)/);
  assert.match(xp.COMMENT, /source celestrak-gp, originator CelesTrak/);
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
  const recipe = recipeFor({ id: 'spacex-starlink', lineage: 'spacex-meme', kind: 'ephemeris', own: false, extra: { maxOperatorRows: 2 } });
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
  const label = labels(ocm)[0];
  assert.equal(label.rule, 1);
  assert.equal(label.method, 'operator-supplied');
  assert.equal(label.calibration, 'UNCALIBRATED', 'operator covariance is not measured until E14 S1 reports');
  assert.equal(ocm.COV_CALIBRATION, OCM.covarianceCalibration.Uncalibrated);
  // UVW is RTN: the OMM's covariance is the supplied one.
  closeAll(omms[0].COVARIANCE, designed(0), 'OMM covariance', 0);
  assert.equal(omms[0].ORIGINATOR, 'spacex-starlink originator');
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
  assert.equal(labels(ocms[0])[0].rule, 4);
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
  const label = labels(ocm)[0];
  assert.equal(label.rule, 2);
  assert.equal(label.method, 'fit-formal-scaled');
  assert.equal(label.scaleFactor, 17.04);
  assert.equal(label.meanD2Over3, 17.04, 'the measured error of the formal covariance, before scaling');
  assert.equal(label.coverage95, 0.17);
  assert.equal(label.calibration, 'UNCALIBRATED', 'the scaled covariance has not been tested itself');
  assert.match(ocm.COV_CALIBRATION_REFERENCE, /orbit-accuracy-experiments E6 test 2026-05-01\.\.2026-09-30: mean d2\/3 17\.040, 95 % coverage 0\.170 \(1000 samples, 5 objects\); formal covariance times 17\.040/);
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
  assert.equal(labels(ocms[0])[0].rule, 4);
  assert.match(JSON.stringify(report.objects[0].notes), /no measured realism factor for source od-fit-source and fit class od-sgp4-fit/);
});

// ── attribute_maneuvers ──
test('attribute_maneuvers names the source on every maneuver and keeps what the record had', async () => {
  const stream = Buffer.concat([encodeMnv(), encodeMnv({ ID: 'M2', TAGS: ['originator:CelesTrak'] })]);
  const recipe = recipeFor();
  const response = await call('attribute_maneuvers', [mnvFrame('maneuvers', stream), json('recipe', { ...recipe, producer: 'SDN catalog pipeline' })]);
  assert.equal(response.statusCode, 0, response.errorMessage);
  const out = records(output(response, 'maneuvers')).map(unpackMnv);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].TAGS, ['existing', 'originator:CelesTrak', 'source:celestrak-gp', 'provider:sdn:celestrak-gp', 'licence:redistributable', 'licence-id:celestrak-gp-terms', 'lineage:space-track-gp', 'producer:SDN catalog pipeline']);
  assert.deepEqual(out[1].TAGS, ['originator:CelesTrak', 'source:celestrak-gp', 'provider:sdn:celestrak-gp', 'licence:redistributable', 'licence-id:celestrak-gp-terms', 'lineage:space-track-gp', 'producer:SDN catalog pipeline'], 'a tag is not repeated');
  assert.equal(out[0].EVENT_START_TIME, '2026-10-01T12:00:00.000Z');
  assert.equal(reportOf(response).maneuvers, 2);
});

test('attribute_maneuvers reads the detector\'s frames, one plain FlatBuffer per event, as well as size-prefixed streams', async () => {
  const response = await call('attribute_maneuvers', [mnvFrame('maneuvers', encodeMnv({ ID: 'P1' }, { plain: true })), mnvFrame('maneuvers', encodeMnv({ ID: 'P2' }, { plain: true })), json('recipe', recipeFor())]);
  assert.equal(response.statusCode, 0, response.errorMessage);
  const out = records(output(response, 'maneuvers')).map(unpackMnv);
  assert.deepEqual(out.map((m) => m.ID), ['P1', 'P2']);
  assert.ok(out.every((m) => m.TAGS.includes('source:celestrak-gp') && m.TAGS.includes('existing')));
});

test('a recipe that does not name the source is refused', async () => {
  const bad = recipeFor();
  delete bad.source.provider;
  const stream = encodeOmm(leoH);
  const states = await deriveStates(stream);
  const response = await call('attach_covariance', [ommFrame('elements', stream), alignedOem('states', states), json('recipe', bad)]);
  assert.notEqual(response.statusCode, 0);
  assert.match(response.errorMessage, /recipe\.source\.provider is required/);
});

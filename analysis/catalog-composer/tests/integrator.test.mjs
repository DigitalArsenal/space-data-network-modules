// integrate_catalog through the SDK browser harness, on records whose answers are fixed by construction: which source
// has the lowest measured median error, which products a burn retires, which reports are one burn, which names are
// bound by trajectories that agree. Expected values are the designed ones, not the module's output read back.
import assert from 'node:assert/strict';
import test from 'node:test';

import { oem } from './matching-fixture.mjs';
import {
  ASOF, MNV, OCM, OMM, catRecord, cidOf, frames, integrate, labelOf, mnvRecord, ocmEpoch, ocmRecord, ommEpoch, ommRecord, records, reportEpoch, sha256, stream, unpackCat, unpackMnv,
  unpackOmm,
} from './integrator-fixtures.mjs';

const [S1, S2, S3] = ['space-track-gp', 'celestrak-gp', 'esa-ura'];
const A = { norad: 90001, cospar: '2026-901A', name: 'ALPHA' };
const B = { norad: 90002, cospar: '2026-902A', name: 'BRAVO' };
const C = { norad: 90003, cospar: '2026-903A', name: 'CHARLIE' };
const catalogOf = (...objects) => stream(objects.map((o) => catRecord(o)));
const row = (source, regime, median, samples, product = 'sgp4') => ({ source, product, regime, horizonDays: 1, median3dKm: median, samples });
const policy = (rows, extra = {}) => ({ horizonDays: 1, minSamples: 30, sourceOrder: [S1, S2, S3], table: rows, ...extra });
const recipeOf = (selection, extra = {}) => ({ version: 1, asOf: ASOF, selection, maneuvers: { timeToleranceSeconds: 3600, deltaVToleranceKmS: 0.0005 }, ...extra });
const omm = (source, who, daysBefore, extra = {}) => ommRecord({ source, ...who, epoch: ommEpoch(daysBefore), label: labelOf(extra.regime ?? 'LEO-L'), ...extra });
const mnv = (source, who, daysBefore, extra = {}) => mnvRecord({ source, id: `${source}-${daysBefore}`, ...who, at: ocmEpoch(daysBefore), ...extra });
const names = (r) => r.report.objects.map((o) => o.name);
const objectOf = (r, name) => r.report.objects.find((o) => o.name === name);
const sources = (omms) => omms.map((bytes) => unpackOmm(bytes).USER_DEFINED_PARAMETERS.find((p) => p.PARAM_NAME === 'SOURCE_ID').PARAM_VALUE);
const run = async (recipe, { catalog, omms = [], ocms = [], mnvs = [], ephemerides = [] }) => integrate([
  frames.recipe(recipe), frames.catalog(catalog),
  ...ephemerides.map(frames.ephemerides),
  ...(omms.length ? [frames.omm(stream(omms))] : []), ...(ocms.length ? [frames.ocm(stream(ocms))] : []), ...(mnvs.length ? [frames.mnv(stream(mnvs))] : []),
]);

test('the source with the lowest measured median error is chosen per object and regime; a row under minSamples measures nothing', async () => {
  const s1a = omm(S1, A, 1), s2a = omm(S2, A, 2), s3a = omm(S3, A, 0.5), s1b = omm(S1, B, 1, { regime: 'LEO-H' }), s2b = omm(S2, B, 1, { regime: 'LEO-H' });
  const table = [row(S1, 'LEO-L', 0.8, 100), row(S2, 'LEO-L', 0.5, 100), row(S3, 'LEO-L', 0.2, 10), row(S1, 'LEO-H', 0.3, 60), row(S2, 'LEO-H', 0.45, 60)];
  const r = await run(recipeOf(policy(table)), { catalog: catalogOf(A, B, C), omms: [s1a, s2a, s3a, s1b, s2b] });
  assert.equal(r.statusCode, 0, r.message);
  // ALPHA is LEO-L: CelesTrak's 0.5 km beats Space-Track's 0.8 km; ESA's 0.2 km rests on 10 samples and is not evidence. BRAVO is LEO-H: Space-Track's 0.3 km wins.
  assert.deepEqual(sources(records(r.omm)), [S2, S1]);
  assert.deepEqual(records(r.omm), [s2a, s1b], 'the selected sets are the sources\' own bytes, in catalog order');
  const alpha = objectOf(r, 'ALPHA').products[0];
  assert.equal(objectOf(r, 'ALPHA').regime, 'LEO-L');
  assert.deepEqual([alpha.product, alpha.selected.source, alpha.selected.reason, alpha.selected.tie], ['sgp4', S2, 'lowest-measured-median', false]);
  assert.deepEqual(alpha.selected.measured, { median3dKm: 0.5, samples: 100, regime: 'LEO-L', horizonDays: 1 });
  assert.deepEqual(alpha.candidates.map((c) => [c.source, c.status, c.measured, c.median3dKm, c.samples]),
    [[S1, 'not-selected', true, 0.8, 100], [S2, 'selected', true, 0.5, 100], [S3, 'not-selected', false, 0.2, 10]]);
  assert.equal(alpha.selected.omm.sha256, sha256(s2a));
  assert.equal(alpha.selected.omm.cid, cidOf(s2a));
  assert.equal(objectOf(r, 'BRAVO').products[0].selected.source, S1);
  assert.equal(objectOf(r, 'CHARLIE').status, 'no-product');
  assert.deepEqual([r.report.counts.selected, r.report.counts.noProduct, r.report.counts.stale, r.report.counts.unmeasured], [2, 1, 0, 0]);
});

test('with nothing measured the recipe\'s source order decides and the report says so; an unlisted source follows the listed ones', async () => {
  const sets = [omm(S2, A, 1), omm(S1, A, 2), omm(S3, A, 0.5)];
  const r = await run(recipeOf(policy([row(S1, 'LEO-L', 0.8, 100)], { horizonDays: 7, sourceOrder: [S3, S1] })), { catalog: catalogOf(A), omms: sets });
  assert.equal(r.statusCode, 0, r.message);
  const chosen = objectOf(r, 'ALPHA').products[0].selected;
  assert.deepEqual([chosen.source, chosen.reason], [S3, 'unmeasured-fallback-order']);
  assert.equal(r.report.counts.unmeasured, 1);
  const r2 = await run(recipeOf(policy([], { sourceOrder: [S1] })), { catalog: catalogOf(A), omms: [omm(S3, A, 1), omm(S2, A, 1)] });
  assert.equal(objectOf(r2, 'ALPHA').products[0].selected.source, S2, 'neither is listed: the source ID decides');
});

test('a source\'s newest set at or before asOf stands for it; a set after asOf is never chosen; an equal median goes to the earlier source and the report marks the tie', async () => {
  const older = omm(S2, A, 3), newest = omm(S2, A, 1), future = omm(S2, A, -1), s1 = omm(S1, A, 1.5);
  const r = await run(recipeOf(policy([row(S1, 'LEO-L', 0.5, 100), row(S2, 'LEO-L', 0.5, 100)])), { catalog: catalogOf(A), omms: [older, future, newest, s1] });
  assert.equal(r.statusCode, 0, r.message);
  const alpha = objectOf(r, 'ALPHA').products[0];
  assert.equal(alpha.selected.source, S1, 'equal medians: the source listed first');
  assert.equal(alpha.selected.tie, true);
  assert.deepEqual(alpha.candidates.map((c) => [c.source, c.epoch]), [[S1, reportEpoch(1.5)], [S2, reportEpoch(1)]]);
  const r2 = await run(recipeOf(policy([row(S1, 'LEO-L', 0.9, 100), row(S2, 'LEO-L', 0.5, 100)])), { catalog: catalogOf(A), omms: [older, future, newest, s1] });
  assert.deepEqual(records(r2.omm), [newest], 'the source\'s newest set, not its older or its future one');
});

test('a set older than maxAgeDays is too old, and the better-measured source loses to the fresher one', async () => {
  const fresh = omm(S1, A, 1), old = omm(S2, A, 5);
  const table = [row(S1, 'LEO-L', 0.8, 100), row(S2, 'LEO-L', 0.5, 100)];
  const r = await run(recipeOf(policy(table, { maxAgeDays: 3 })), { catalog: catalogOf(A), omms: [fresh, old] });
  const alpha = objectOf(r, 'ALPHA').products[0];
  assert.equal(alpha.selected.source, S1);
  assert.equal(alpha.candidates.find((c) => c.source === S2).status, 'too-old');
  assert.equal(Math.round(alpha.candidates.find((c) => c.source === S2).ageDays * 1000) / 1000, 5);
  assert.deepEqual(records((await run(recipeOf(policy(table)), { catalog: catalogOf(A), omms: [fresh, old] })).omm), [old], 'without the limit the lower median wins');
});

test('SGP4 and SGP4-XP sets are chosen separately, each by its own measured rows', async () => {
  const xp = OMM.meanElementSource.SGP4XP;
  const sets = [omm(S1, A, 1), omm(S2, A, 1), omm(S1, A, 1, { theory: xp }), omm(S2, A, 1, { theory: xp })];
  const table = [row(S1, 'LEO-L', 0.4, 50), row(S2, 'LEO-L', 0.6, 50), row(S1, 'LEO-L', 0.3, 50, 'sgp4xp'), row(S2, 'LEO-L', 0.1, 50, 'sgp4xp')];
  const r = await run(recipeOf(policy(table)), { catalog: catalogOf(A), omms: sets });
  assert.equal(r.statusCode, 0, r.message);
  assert.deepEqual(objectOf(r, 'ALPHA').products.map((p) => [p.product, p.selected.source]), [['sgp4', S1], ['sgp4xp', S2]]);
  assert.deepEqual(records(r.omm).map((b) => [unpackOmm(b).MEAN_ELEMENT_THEORY, sources([b])[0]]), [[OMM.meanElementSource.SGP4, S1], [OMM.meanElementSource.SGP4XP, S2]]);
});

test('a maneuver after a set\'s epoch retires it, however well its source measures; the catalog is marked maneuverable from the history', async () => {
  const s1 = omm(S1, C, 1), s2 = omm(S2, C, 2), s3 = omm(S3, C, 0.5);
  const table = [row(S1, 'LEO-L', 0.8, 100), row(S2, 'LEO-L', 0.2, 100), row(S3, 'LEO-L', 0.1, 10)];
  const burn = mnv(S1, C, 1.5, { dv: 0.001 });
  const r = await run(recipeOf(policy(table)), { catalog: catalogOf(A, C), omms: [s1, s2, s3, omm(S1, A, 1)], mnvs: [burn] });
  assert.equal(r.statusCode, 0, r.message);
  const charlie = objectOf(r, 'CHARLIE');
  assert.equal(charlie.products[0].selected.source, S1, 'ESA\'s 0.1 km rests on 10 samples, CelesTrak\'s set predates the burn');
  assert.deepEqual(charlie.products[0].candidates.map((c) => [c.source, c.status]), [[S1, 'selected'], [S2, 'retired'], [S3, 'not-selected']]);
  assert.equal(charlie.products[0].candidates.find((c) => c.source === S2).retiredBy, reportEpoch(1.5));
  assert.deepEqual(records(r.omm).map((b) => sources([b])[0]), [S1, S1]);
  const [alphaCat, charlieCat] = records(r.catalog);
  assert.deepEqual(alphaCat, catRecord(A), 'an object with no maneuver keeps its record byte for byte');
  assert.equal(unpackCat(charlieCat).MANEUVERABLE, true);
  assert.equal(unpackCat(charlieCat).OBJECT_NAME, 'CHARLIE');
  assert.equal(unpackCat(charlieCat).OBJECT_ID, '2026-903A');
  assert.equal(unpackCat(charlieCat).NORAD_CAT_ID, 90003);
  assert.deepEqual([charlie.maneuverable, charlie.maneuverableFromHistory, r.report.counts.maneuverable], [true, true, 1]);
});

test('an object whose every set predates a maneuver has no product and is marked stale; a planned or future burn retires nothing', async () => {
  const before = omm(S2, C, 2);
  const detected = await run(recipeOf(policy([])), { catalog: catalogOf(C), omms: [before], mnvs: [mnv(S1, C, 1.5, { dv: 0.001 })] });
  assert.equal(detected.omm.length, 0);
  assert.equal(objectOf(detected, 'CHARLIE').status, 'stale');
  assert.equal(unpackCat(records(detected.catalog)[0]).MANEUVERABLE, true);
  assert.equal(detected.report.counts.stale, 1);
  for (const extra of [{ status: MNV.maneuverStatus.PLANNED }, { status: MNV.maneuverStatus.CANCELLED }]) {
    const r = await run(recipeOf(policy([])), { catalog: catalogOf(C), omms: [before], mnvs: [mnv(S1, C, 1.5, { dv: 0.001, ...extra })] });
    assert.deepEqual(records(r.omm), [before], 'a plan is not a maneuver');
    assert.equal(unpackCat(records(r.catalog)[0]).MANEUVERABLE, false);
  }
  const future = await run(recipeOf(policy([])), { catalog: catalogOf(C), omms: [before], mnvs: [mnv(S1, C, -1, { dv: 0.001 })] });
  assert.deepEqual(records(future.omm), [before], 'a burn after asOf has not happened');
  // The recipe names the statuses that count: with PLANNED retiring and maneuverable, a plan does both.
  const widened = await run(recipeOf(policy([]), { maneuvers: { timeToleranceSeconds: 3600, maneuverableStatuses: ['PLANNED'], retiringStatuses: ['PLANNED'] } }),
    { catalog: catalogOf(C), omms: [before], mnvs: [mnv(S1, C, 1.5, { dv: 0.001, status: MNV.maneuverStatus.PLANNED })] });
  assert.equal(widened.omm.length, 0);
  assert.equal(unpackCat(records(widened.catalog)[0]).MANEUVERABLE, true);
});

test('two sources\' reports of one burn are one event that keeps each source\'s confirmation; a source never merges with itself', async () => {
  const detected = mnv(S1, C, 1.5, { dv: 0.0010, status: MNV.maneuverStatus.DETECTED });
  const confirmed = mnvRecord({ source: S2, id: 'cel', ...C, at: new Date(Date.parse(ocmEpoch(1.5)) + 20 * 60e3).toISOString(), dv: 0.0011, status: MNV.maneuverStatus.CONFIRMED });
  const later = mnv(S3, C, 1.5 - 3 / 24, { dv: 0.0010 });
  const r = await run(recipeOf(policy([])), { catalog: catalogOf(C), mnvs: [detected, confirmed, later] });
  assert.equal(r.statusCode, 0, r.message);
  const events = records(r.mnv).map(unpackMnv);
  assert.equal(events.length, 2, 'the third report is three hours later: another burn');
  assert.equal(events[0].STATUS, MNV.maneuverStatus.CONFIRMED);
  assert.equal(events[0].ID, 'cel', 'written from the member with the best status');
  assert.deepEqual(events[0].TAGS.filter((t) => t.startsWith('member:') || t.startsWith('merged:')), [`member:${S1}=DETECTED`, `member:${S2}=CONFIRMED`, 'merged:2']);
  assert.ok(events[0].TAGS.includes(`source:${S2}`));
  assert.deepEqual(records(r.mnv)[1], later, 'an event of one report is that record byte for byte');
  const merged = objectOf(r, 'CHARLIE').maneuvers[0];
  assert.deepEqual(merged.members.map((m) => [m.source, m.status]), [[S1, 'DETECTED'], [S2, 'CONFIRMED']]);
  assert.equal(merged.cid, cidOf(records(r.mnv)[0]));
  assert.equal(r.report.counts.mergedEvents, 1);

  // Past the delta-v tolerance the reports are two events; so are two reports of one source.
  const apart = await run(recipeOf(policy([])), { catalog: catalogOf(C), mnvs: [detected, mnv(S2, C, 1.5, { dv: 0.003 })] });
  assert.equal(records(apart.mnv).length, 2);
  const same = await run(recipeOf(policy([])), { catalog: catalogOf(C), mnvs: [detected, mnvRecord({ source: S1, id: 'again', ...C, at: new Date(Date.parse(ocmEpoch(1.5)) + 600e3).toISOString(), dv: 0.001 })] });
  assert.equal(records(same.mnv).length, 2);
  // A report that states no delta-v merges on time alone, and the best status wins whatever the order.
  const cancelled = mnv(S2, C, 1.5, { status: MNV.maneuverStatus.CANCELLED });
  const either = await run(recipeOf(policy([])), { catalog: catalogOf(C), mnvs: [cancelled, detected] });
  assert.equal(records(either.mnv).length, 1);
  assert.equal(unpackMnv(records(either.mnv)[0]).STATUS, MNV.maneuverStatus.DETECTED);
});

test('the selected product\'s covariance and its label come out with it, byte for byte', async () => {
  const label = labelOf('LEO-L', { calibration: 'UNCALIBRATED', meanD2Over3: 1.73, coverage95: 0.916 });
  const s1 = omm(S1, A, 1), s2 = omm(S2, A, 2);
  const o1 = ocmRecord({ source: S1, ...A, epoch: ocmEpoch(1), label }), o2 = ocmRecord({ source: S2, ...A, epoch: ocmEpoch(2), label: { ...label, calibration: 'CALIBRATED' }, calibration: OCM.covarianceCalibration.Calibrated });
  const r = await run(recipeOf(policy([row(S1, 'LEO-L', 0.8, 100), row(S2, 'LEO-L', 0.5, 100)])), { catalog: catalogOf(A), omms: [s1, s2], ocms: [o1, o2] });
  assert.equal(r.statusCode, 0, r.message);
  assert.deepEqual(records(r.ocm), [o2], 'the OCM of the chosen source at the chosen epoch, and only it');
  const selected = objectOf(r, 'ALPHA').products[0].selected;
  assert.equal(selected.covariance.from, 'ocm');
  assert.equal(selected.covariance.calibration, 'Calibrated');
  assert.equal(selected.covariance.label.regime, 'LEO-L');
  assert.equal(selected.covariance.label.calibration, 'CALIBRATED');
  assert.equal(selected.ocm.sha256, sha256(o2));
  // A chosen set whose source gave no OCM at that epoch goes out alone, and the report reads its label from the set.
  const alone = await run(recipeOf(policy([row(S1, 'LEO-L', 0.8, 100), row(S2, 'LEO-L', 0.5, 100)])), { catalog: catalogOf(A), omms: [s1, s2], ocms: [o1] });
  assert.equal(alone.ocm.length, 0);
  assert.equal(objectOf(alone, 'ALPHA').products[0].selected.covariance.from, 'omm');
  assert.equal(alone.report.counts.withoutOcm, 1);
});

// ── identity ──
const candidate = (id, provider, nativeId) => ({ id, provider, nativeId, recordId: `immutable-${id}` });
const thresholds = { positionToleranceKm: 1, velocityToleranceKmS: 0.01, finiteDifferenceToleranceKmS: 1e-8, minimumSpanSeconds: 8 };
const link = (native, reference, object) => ({ native, reference, object, evidence: { source: 'datefirst', recordId: 'crosswalk-edition' } });
const vimpelSet = (daysBefore = 0.2) => ommRecord({ source: 'vimpel', native: 'V-100', name: 'ALPHA', epoch: ommEpoch(daysBefore), label: labelOf('LEO-L') });
const identityRun = (identity, ephemerides, extra = {}) => run(recipeOf(policy([row('vimpel', 'LEO-L', 0.1, 50), row(S1, 'LEO-L', 0.8, 100)]), { identity: { version: 1, ...thresholds, ...identity }, ...extra }),
  { catalog: catalogOf(A, B), omms: [vimpelSet(), omm(S1, A, 1)], ephemerides });
const vimpelA = { candidates: [candidate('v', 'vimpel', 'V-100'), candidate('r', 'space-track', '90001')], pairs: [link('v', 'r', { norad: 90001 })] };

test('a source\'s own name joins an object only through a link its trajectories supported', async () => {
  const compatible = await identityRun(vimpelA, [oem(), oem()]);
  assert.equal(compatible.statusCode, 0, compatible.message);
  assert.deepEqual([compatible.report.identity.matches[0].status, compatible.report.identity.matches[0].bound], ['compatible', true]);
  assert.deepEqual(compatible.report.identity.matches[0].native, { source: 'vimpel', nativeId: 'V-100' });
  const alpha = objectOf(compatible, 'ALPHA').products[0];
  assert.equal(alpha.selected.source, 'vimpel', 'bound: its 0.1 km median now competes');
  assert.deepEqual(alpha.candidates.map((c) => c.source), ['space-track-gp', 'vimpel']);
  assert.deepEqual(compatible.report.counts.unlinked, {});

  // Trajectories that disagree, or cannot be compared, bind nothing: the set is reported unlinked and the others stand.
  for (const [arcs, status] of [[[oem(), oem({ phase: Math.PI })], 'rejected'], [[oem(), oem({ step: 2 })], 'insufficient']]) {
    const r = await identityRun(vimpelA, arcs);
    assert.equal(r.statusCode, 0, r.message);
    assert.deepEqual([r.report.identity.matches[0].status, r.report.identity.matches[0].bound], [status, false]);
    assert.equal(objectOf(r, 'ALPHA').products[0].selected.source, S1);
    assert.deepEqual(r.report.unlinked.map((u) => [u.record, u.source, u.reason]), [['omm', 'vimpel', 'unbound-native-identity']]);
  }
});

test('a native name proposed for two objects, or two references that both pass, binds to nothing; so does an object the catalog lacks', async () => {
  const two = await identityRun({ candidates: [...vimpelA.candidates, candidate('r2', 'other-catalog', '90002')], pairs: [link('v', 'r', { norad: 90001 }), link('v', 'r2', { norad: 90002 })] }, [oem(), oem(), oem()]);
  assert.deepEqual(two.report.identity.matches.map((m) => [m.status, m.bound]), [['ambiguous', false], ['ambiguous', false]]);
  assert.equal(objectOf(two, 'ALPHA').products[0].selected.source, S1);

  const twin = await identityRun({ candidates: [...vimpelA.candidates, candidate('r2', 'space-track', '90009')], pairs: [link('v', 'r', { norad: 90001 }), link('v', 'r2', { norad: 90001 })] }, [oem(), oem(), oem()]);
  assert.deepEqual(twin.report.identity.matches.map((m) => [m.status, m.bound]), [['ambiguous', false], ['ambiguous', false]], 'two references from one provider both pass');

  const missing = await identityRun({ ...vimpelA, pairs: [link('v', 'r', { norad: 99999 })] }, [oem(), oem()]);
  assert.deepEqual([missing.report.identity.matches[0].status, missing.report.identity.matches[0].bound], ['compatible', false]);
  assert.match(missing.report.identity.matches[0].reason, /not in the catalog/);
});

test('a name never joins: the same object name without a link is unlinked, and so is a number the catalog does not hold', async () => {
  const r = await run(recipeOf(policy([row(S1, 'LEO-L', 0.8, 100)])), { catalog: catalogOf(A),
    omms: [ommRecord({ source: S2, native: 'X-1', name: 'ALPHA', epoch: ommEpoch(1), label: labelOf('LEO-L') }), ommRecord({ source: S3, norad: 12345, name: 'ALPHA', epoch: ommEpoch(1), label: labelOf('LEO-L') }), omm(S1, A, 1)] });
  assert.equal(r.statusCode, 0, r.message);
  assert.deepEqual(r.report.unlinked.map((u) => [u.source, u.reason]), [[S2, 'unbound-native-identity'], [S3, 'not-in-catalog']]);
  assert.deepEqual(r.report.counts.unlinked, { 'not-in-catalog': 1, 'unbound-native-identity': 1 });
  assert.deepEqual(records(r.omm).length, 1);
});

test('an international designator joins a set that carries no NORAD number; a number and a designator that name different objects are a conflict', async () => {
  const designated = ommRecord({ source: S2, cospar: '2026-901A', epoch: ommEpoch(1), label: labelOf('LEO-L') });
  const r = await run(recipeOf(policy([row(S2, 'LEO-L', 0.5, 100)])), { catalog: catalogOf(A, B), omms: [designated] });
  assert.deepEqual(records(r.omm), [designated]);
  const crossed = ommRecord({ source: S2, norad: 90001, cospar: '2026-902A', epoch: ommEpoch(1), label: labelOf('LEO-L') });
  const c = await run(recipeOf(policy([])), { catalog: catalogOf(A, B), omms: [crossed] });
  assert.equal(c.omm.length, 0);
  assert.deepEqual(c.report.unlinked.map((u) => u.reason), ['identity-conflict']);
});

// ── what is refused ──
test('a record that names no source or no object is refused and counted, never selected', async () => {
  const r = await run(recipeOf(policy([])), { catalog: catalogOf(A),
    omms: [ommRecord({ norad: 90001, epoch: ommEpoch(1) }), ommRecord({ source: S1, epoch: ommEpoch(1) }), omm(S2, A, 1)],
    mnvs: [mnvRecord({ id: 'nosource', norad: 90001, at: ocmEpoch(1.5), dv: 0.001 }), mnvRecord({ source: S1, id: 'noobject', at: ocmEpoch(1.5) })],
    ocms: [ocmRecord({ source: '', norad: 90001, epoch: ocmEpoch(1), label: labelOf('LEO-L') })] });
  assert.equal(r.statusCode, 0, r.message);
  assert.deepEqual(r.report.refused.map((x) => [x.record, x.reason]).sort(), [['mnv', 'no-object-identity'], ['mnv', 'unattributed-product'], ['ocm', 'unattributed-product'], ['omm', 'no-object-identity'], ['omm', 'unattributed-product']]);
  assert.equal(r.report.counts.refused, 5);
  assert.equal(r.mnv.length, 0);
  assert.deepEqual(records(r.omm).length, 1);
});

test('a malformed recipe, catalog or product stream is refused whole, with a code', async () => {
  const good = recipeOf(policy([]));
  const catalog = catalogOf(A);
  const cases = [
    ['no asOf', { ...good, asOf: undefined }, catalog, 'invalid-integration-recipe'],
    ['version 2', { ...good, version: 2 }, catalog, 'invalid-integration-recipe'],
    ['table without a horizon', recipeOf({ table: [row(S1, 'LEO-L', 1, 50)] }), catalog, 'invalid-integration-recipe'],
    ['a repeated table row', recipeOf(policy([row(S1, 'LEO-L', 1, 50), row(S1, 'LEO-L', 2, 50)])), catalog, 'invalid-integration-recipe'],
    ['a negative median', recipeOf(policy([row(S1, 'LEO-L', -1, 50)])), catalog, 'invalid-integration-recipe'],
    ['an unknown status', recipeOf(policy([]), { maneuvers: { timeToleranceSeconds: 3600, retiringStatuses: ['BURNING'] } }), catalog, 'invalid-integration-recipe'],
    ['a zero time tolerance', recipeOf(policy([]), { maneuvers: { timeToleranceSeconds: 0 } }), catalog, 'invalid-integration-recipe'],
    ['ephemerides without an identity section', good, catalog, null, [oem(), oem()]],
    ['a catalog that repeats an object', good, stream([catRecord(A), catRecord({ ...A, name: 'AGAIN' })]), 'invalid-integration-input'],
    ['a truncated catalog', good, catalog.subarray(0, catalog.length - 3), 'invalid-integration-input'],
  ];
  for (const [label, recipe, cat, code, ephemerides = []] of cases) {
    const r = await integrate([frames.recipe(recipe), frames.catalog(cat), ...ephemerides.map(frames.ephemerides)]);
    assert.notEqual(r.statusCode, 0, label);
    if (code) assert.match(r.message, new RegExp(code), label);
  }
  const garbage = await integrate([frames.recipe(good), frames.catalog(catalog), frames.omm(Buffer.from('not a flatbuffer stream at all'))]);
  assert.notEqual(garbage.statusCode, 0);
});

test('padding between records is read, the same inputs give the same bytes, and an empty catalog gives an empty report', async () => {
  const sets = [omm(S1, A, 1), omm(S2, A, 2)];
  const padded = Buffer.concat(sets.flatMap((b) => [b, Buffer.alloc(4)]));
  const recipe = recipeOf(policy([row(S1, 'LEO-L', 0.8, 100), row(S2, 'LEO-L', 0.5, 100)]));
  const a = await integrate([frames.recipe(recipe), frames.catalog(catalogOf(A)), frames.omm(padded)]);
  const b = await run(recipe, { catalog: catalogOf(A), omms: sets });
  assert.equal(a.statusCode, 0, a.message);
  assert.deepEqual([a.omm, a.catalog, JSON.stringify(a.report)], [b.omm, b.catalog, JSON.stringify(b.report)]);
  const empty = await integrate([frames.recipe(recipe), frames.catalog(Buffer.alloc(0))]);
  assert.equal(empty.statusCode, 0, empty.message);
  assert.equal(empty.report.counts.catalogRecords, 0);
});

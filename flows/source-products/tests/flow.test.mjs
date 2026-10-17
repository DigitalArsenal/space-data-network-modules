// The source-products flow, compiled and run in the SDK's JS flow host. Each lane's egress is compared byte for byte
// with the chain of modules it composes (called one by one through the SDK's browser module harness), and the
// outcomes that matter are asserted on the records: the covariance rule, its label, the maneuver and the source on it.
// Expected numbers come from the model file, the designed inputs, and the detector's own closed-form fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';
import { decodeFlowNotice } from 'space-data-module-sdk/runtime-contracts';
import { decode as decodeErm } from '../../../analysis/gp-error-model/scripts/erm-codec.mjs';
import { flowConfig, modelsBytes } from '../recipe.mjs';

import {
  assertSourceNamed, cellOf, encodeMnv, encodeOmm, expectedCovariance, expectedProvenance, fitOcm, json, leoH, OCM, OEM, OMM, ocmFrame, ommFrame, operatorOem, provenanceOf, recipeFor, records,
  unpackMnv, unpackOcm, unpackOmm, flatbuffers,
} from '../../../analysis/gp-error-model/tests/products-fixtures.mjs';
import { gpHistory, LEO, T0, add, kepler, mul, unit, version as ephemerisVersion, planned as plannedBurn, MNV as MD_MNV } from '../../../analysis/maneuver-detection/tests/fixtures.mjs';
import { ommRecord } from '../../../analysis/maneuver-detection/study/lib/host.mjs';
import { reportOf } from '../../../analysis/maneuver-detection/study/lib/mde.mjs';
import { FIXTURE as VALLADO, decodePrw, mpeStream, mpeType } from '../../../analysis/epoch-state/tests/fixtures.mjs';
import { bytesOf, egressBytes, flowDocument, flowManifest, framesOf, moduleAt, runFlow } from './flow-harness.mjs';

// The detector is the producer of the maneuvers it writes (its PROVENANCE.PRODUCER), whatever the source.
const detectorManifest = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../../analysis/maneuver-detection/plugin-manifest.json', import.meta.url)), 'utf8'));
const DETECTOR = `${detectorManifest.pluginId} ${detectorManifest.version}`;
const Calibrated = OCM.covarianceCalibration.Calibrated, Uncalibrated = OCM.covarianceCalibration.Uncalibrated;
const epoch = moduleAt('analysis/epoch-state');
const gem = moduleAt('analysis/gp-error-model');
const detector = moduleAt('analysis/maneuver-detection');
const frame = (trigger, portId, bytes) => ({ trigger, portId, bytes });
// A run of the flow is one source: its recipe is the node configuration, its models the `models` trigger's $ERM records.
const run = (frames, recipe) => runFlow([...frames, frame('models', 'models', modelsBytes(recipe))], flowConfig(recipe));
const ermIn = (portId, payload) => ({ portId, payload, typeRef: { schemaName: 'ERM.fbs', fileIdentifier: '$ERM', rootTypeName: 'ERM', wireFormat: 'flatbuffer' } });
const oemIn = (portId, payload) => ({ portId, payload, typeRef: { schemaName: 'OEM.fbs', fileIdentifier: '$OEM', rootTypeName: 'OEM', wireFormat: 'flatbuffer' } });
// The chain's nodes, each called with the flow's node configuration.
const deriveOmm = async (input, recipe) => bytesOf(await epoch('derive_omm', [input], flowConfig(recipe)), 'states');
const attachCovariance = (recipe, inputs) => gem('attach_covariance', [...inputs, ermIn('models', modelsBytes(recipe))], flowConfig(recipe));
// The reports: $ERM ATTACH_REPORT (covariance), $PRW WINDOW_REPORT (propagation), FlowNotice (mpe, derive).
const covarianceReport = (egress) => decodeErm(egressBytes(egress, 'covariance_report'));
const propagationReport = async (egress) => (await decodePrw(egressBytes(egress, 'propagation_report'))).WINDOW_REPORT;
const ommBytes = (rows) => Buffer.concat(rows.map((r) => Buffer.from(ommRecord(r))));
// The detector's propagation queries: one $PRW WINDOW_REQUEST.
const prwPort = (portId, bytes) => ({ portId, payload: bytes, typeRef: { schemaName: 'PRW.fbs', fileIdentifier: '$PRW', rootTypeName: 'PRW', wireFormat: 'flatbuffer' } });
const omm = (portId, payload) => ommFrame(portId, payload);
const mnvIn = (portId, payload) => ({ portId, payload, typeRef: { schemaName: 'MNV.fbs', fileIdentifier: '$MNV', rootTypeName: 'MNV', wireFormat: 'flatbuffer' } });

// The detector's two passes with SGP4 answering the propagator query port, then the source named on each maneuver: the chain of modules the flow composes.
async function screenedForManeuvers(sets, recipe) {
  const config = flowConfig(recipe);
  const first = await detector('detect_maneuvers', [omm('element_sets', sets)], config);
  const answered = await epoch('answer_propagation_requests', [prwPort('requests', bytesOf(first, 'propagation_requests')), omm('element_sets', sets)], config);
  const second = await detector('detect_maneuvers', [omm('element_sets', bytesOf(answered, 'element_sets')), oemIn('propagation', bytesOf(answered, 'propagation'))], config);
  return gem('attribute_maneuvers', framesOf(second, 'maneuvers').map((m) => mnvIn('maneuvers', m)), config);
}

test('the compiled flow takes one ingress per kind of frame and gives the products on one egress', () => {
  assert.deepEqual(flowDocument.triggers.map((t) => t.triggerId), ['element_sets', 'element_sets_mpe', 'models', 'fit_omm', 'ephemeris', 'ephemeris_versions', 'planned_maneuvers', 'fit']);
  assert.deepEqual(flowManifest.methods.find((m) => m.methodId === 'element_sets').outputPorts.map((p) => p.portId).sort(),
    ['attribute_report', 'compare_report', 'covariance_report', 'derive_report', 'detect_report', 'mnv', 'mpe_report', 'ocm', 'omm', 'propagation_report'].sort());
  assert.deepEqual(flowManifest.runtimeTargets, ['browser', 'wasmedge']);
  assert.deepEqual(flowManifest.capabilities, [], 'pure compute: the flow asks its host for nothing');
});

test('an element-set source: the newest set of an object gets states, a covariance by rule and its label; the history is screened and the burn found, attributed to the source', async () => {
  const { tb, rows } = gpHistory(1);
  const sets = ommBytes(rows);
  const recipe = { ...recipeFor({ id: 'celestrak-gp' }), ages: [0, 0.5] };
  const { egress, result } = await run([frame('element_sets', 'omm', sets)], recipe);
  assert.equal(result.handlersSkipped, 0);

  // The chain of modules the flow composes, called one by one.
  const states = await deriveOmm(omm('omm', sets), recipe);
  const attach = await attachCovariance(recipe, [omm('elements', sets), oemIn('states', states)]);
  const attributed = await screenedForManeuvers(sets, recipe);

  assert.deepEqual(egressBytes(egress, 'ocm'), bytesOf(attach, 'ocm'), 'the flow\'s $OCM is the chain\'s');
  assert.deepEqual(egressBytes(egress, 'omm'), bytesOf(attach, 'omm'), 'the flow\'s $OMM is the chain\'s');
  assert.deepEqual(egressBytes(egress, 'mnv'), bytesOf(attributed, 'maneuvers'), 'the flow\'s $MNV is the chain\'s');

  // The newest set of NORAD 99999: 51.6 degrees at 15.5 rev/day, a LEO-L orbit.
  const [ocm] = records(egressBytes(egress, 'ocm')).map(unpackOcm);
  assert.equal(ocm.STATE_EPOCHS.length, 2);
  assert.equal(ocm.STATE_EPOCHS[0].slice(0, 19), rows.at(-1).EPOCH.slice(0, 19));
  const cvr = ocm.COV_REALISM[0];
  assert.equal(cvr.REGIME, 'LEO-L');
  assert.equal(cvr.RULE, OCM.covarianceRule.SourceModel);
  assert.equal(cvr.CALIBRATION, cellOf('LEO-L', 0).calibration === 'CALIBRATED' ? Calibrated : Uncalibrated);
  assert.equal(ocm.COV_REALISM.length, 2, 'a CVR per row');
  assertSourceNamed(ocm, recipe);
  [0, 1].forEach((k) => assert.ok(Math.abs(ocm.COVARIANCE_DATA[21 * k] - expectedCovariance('LEO-L', [0, 0.5][k])[0]) < 1e-12));
  const [mmo] = records(egressBytes(egress, 'omm')).map(unpackOmm);
  assert.equal(mmo.NORAD_CAT_ID, 99999);
  // The flow links the modules' objects, so the $OMM the flow writes is the schema release gp-error-model was built against, not the
  // older one epoch-state was: it carries its CVR and its source.
  assert.equal(mmo.ORIGINATOR, recipe.producer, 'the message\'s creator; the source\'s originator is PROVENANCE.ORIGINATOR');
  assert.equal(mmo.COV_REALISM.RULE, OCM.covarianceRule.SourceModel);
  assert.equal(mmo.COV_REALISM.REGIME, 'LEO-L');
  assertSourceNamed(mmo, recipe);
  assert.equal(covarianceReport(egress).counts.rule3, 1);

  // The 1 m/s burn between sets 15 and 16, found through the detector's two passes with SGP4 answering the port.
  const burns = records(egressBytes(egress, 'mnv')).map(unpackMnv).filter((m) => m.DELTA_VEL_V !== 0);
  assert.equal(burns.length, 1);
  assert.ok(Math.abs(burns[0].DELTA_VEL_V * 1000 - 1) < 0.1, `${burns[0].DELTA_VEL_V * 1000} m/s`);
  assert.ok(Math.abs(Date.parse(burns[0].EVENT_START_TIME) / 1000 - tb) < 8 * 3600);
  assertSourceNamed(burns[0], recipe, DETECTOR);
  assert.equal((await propagationReport(egress)).REFUSED, 0);
});

// ── an element-set source that stores $MPE ──
test('the GP history archive\'s $MPE records: omm_from_mpe leads, and the products are the chain\'s; eccentric sets get no covariance and say why', async () => {
  const mpe = Buffer.from(mpeStream(VALLADO.cases));
  const recipe = { ...recipeFor({ id: 'space-track-gp' }), ages: [0, 0.5] };
  const { egress, result } = await run([frame('element_sets_mpe', 'mpe', mpe)], recipe);
  assert.equal(result.handlersSkipped, 0);

  const converted = await epoch('omm_from_mpe', [{ portId: 'mpe', payload: mpe, typeRef: mpeType(mpe.length) }]);
  const sets = bytesOf(converted, 'omm');
  const states = await deriveOmm(omm('omm', sets), recipe);
  const attach = await attachCovariance(recipe, [omm('elements', sets), oemIn('states', states)]);
  assert.deepEqual(egressBytes(egress, 'ocm'), bytesOf(attach, 'ocm'), 'the flow\'s $OCM is the chain\'s');
  assert.deepEqual(egressBytes(egress, 'omm'), bytesOf(attach, 'omm'), 'the flow\'s $OMM is the chain\'s');
  assert.deepEqual(egressBytes(egress, 'mpe_report'), bytesOf(converted, 'report'), 'the flow\'s FlowNotice is the chain\'s');
  const notice = decodeFlowNotice(egressBytes(egress, 'mpe_report'));
  assert.equal(notice.reason, 'converted');
  assert.equal(notice.count, VALLADO.cases.length);

  // E14's regimes stop at e < 0.25: of Vallado's sets the eccentric ones (e >= 0.25) have no stratum, the others a modeled covariance.
  const covered = VALLADO.cases.filter((c) => c.ECCENTRICITY < 0.25).map((c) => c.entityId);
  const eccentric = VALLADO.cases.filter((c) => c.ECCENTRICITY >= 0.25).map((c) => c.entityId);
  assert.ok(covered.length > 0 && eccentric.length > 0);
  assert.deepEqual(records(egressBytes(egress, 'ocm')).map(unpackOcm).map((o) => o.METADATA.OBJECT_DESIGNATOR).sort(), covered.map((e) => e.replace('NORAD:', '')).sort());
  const report = covarianceReport(egress);
  assert.equal(report.counts.rule3, covered.length);
  assert.equal(report.counts.withoutCovariance, eccentric.length);
  for (const o of report.objects.filter((x) => eccentric.includes(x.id))) assert.ok(o.notes.every((n) => n.reason === 'no-model-for-regime'), o.id);

  // Every set is published and names its source, however the archive identified it.
  const published = records(egressBytes(egress, 'omm')).map(unpackOmm);
  assert.equal(published.length, VALLADO.cases.length);
  for (const o of published) {
    assert.equal(o.ORIGINATOR, recipe.producer);
    assertSourceNamed(o, recipe);
  }
  assert.equal(published.find((o) => o.NORAD_CAT_ID === 11801)?.OBJECT_ID ?? null, null, 'NORAD:11801 is the NORAD number, not a designator');
});

// ── an ephemeris source ──
const ISS_OEM = fileURLToPath(new URL('../../../analysis/od/tests/data/supgp-reference/iss/ISS.OEM_J2K_EPH.trimmed.txt', import.meta.url));
async function issOem() {
  const text = fs.readFileSync(ISS_OEM, 'utf8');
  const lines = text.split(/\r?\n/).filter((line) => /^\d{4}-\d{2}-\d{2}T/.test(line.trim())).map((line) => {
    const [epochText, ...numbers] = line.trim().split(/\s+/);
    const l = new OEM.ephemerisDataLineT();
    l.EPOCH = epochText;
    [l.X, l.Y, l.Z, l.X_DOT, l.Y_DOT, l.Z_DOT] = numbers.map(Number);
    return l;
  });
  const block = new OEM.ephemerisDataBlockT();
  Object.assign(block, { CENTER_NAME: 'EARTH', TIME_SYSTEM: OEM.timingStandard.UTC, EPHEMERIS_DATA_LINES: lines });
  block.OBJECT = Object.assign(new OEM.CATT(), { OBJECT_NAME: 'ISS', OBJECT_ID: '1998-067-A', NORAD_CAT_ID: 25544 });
  block.REFERENCE_FRAME = Object.assign(new OEM.RFMT(), { REFERENCE_FRAME_type: OEM.RFMUnion.CelestialFrameWrapper,
    REFERENCE_FRAME: Object.assign(new OEM.CelestialFrameWrapperT(), { frame: OEM.CelestialFrame.EME2000 }) });
  const oem = Object.assign(new OEM.OEMT(), { EPHEMERIS_DATA_BLOCK: [block] });
  const prefixed = new flatbuffers.Builder(65536);
  OEM.OEM.finishSizePrefixedOEMBuffer(prefixed, oem.pack(prefixed));
  // analysis/od reads a plain $OEM, built as such: stripping a size prefix would leave its doubles misaligned.
  const plain = new flatbuffers.Builder(65536);
  OEM.OEM.finishOEMBuffer(plain, oem.pack(plain));
  return { prefixed: Buffer.from(prefixed.asUint8Array()), plain: Buffer.from(plain.asUint8Array()) };
}
// analysis/od, as the source's own flow runs it: the ephemeris in, the SGP4 element set it is fitted to out.
async function odFit(plain) {
  const dir = fileURLToPath(new URL('../../../analysis/od/', import.meta.url));
  const h = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(`${dir}dist/isomorphic/module.wasm`), surface: 'direct' });
  try {
    const response = await h.invoke({ methodId: 'fit', inputs: [{ portId: 'oem', payload: plain,
      typeRef: { schemaName: 'OEM.fbs', fileIdentifier: '$OEM', rootTypeName: 'OEM', wireFormat: 'flatbuffer', requiredAlignment: 8, byteLength: plain.length } }] });
    assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
    return { omm: Buffer.from(response.outputs.find((f) => f.portId === 'omm').payload), ocm: Buffer.from(response.outputs.find((f) => f.portId === 'ocm').payload) };
  } finally {
    h.destroy();
  }
}

test('an ephemeris source: NASA\'s public ISS ephemeris, fitted by analysis/od, gets the pooled model\'s covariance, uncalibrated for a lineage it was not measured on', async () => {
  const { prefixed: ephemeris, plain } = await issOem();
  const fit = await odFit(plain);
  const recipe = { ...recipeFor({ id: 'nasa-iss-oem', kind: 'ephemeris', lineage: 'nasa-iss-oem', own: false, licence: 'reproducible' }), ages: [0, 1] };
  const { egress } = await run([frame('fit_omm', 'omm', fit.omm), frame('ephemeris', 'operator', ephemeris)], recipe);

  const states = await deriveOmm({ ...omm('omm', fit.omm), typeRef: { ...ommFrame('omm', fit.omm).typeRef } }, recipe);
  const attach = await attachCovariance(recipe, [omm('elements', fit.omm), oemIn('states', states), { portId: 'operator', payload: ephemeris,
    typeRef: { schemaName: 'OEM.fbs', fileIdentifier: '$OEM', rootTypeName: 'OEM', wireFormat: 'flatbuffer' } }]);
  assert.deepEqual(egressBytes(egress, 'ocm'), bytesOf(attach, 'ocm'));
  assert.deepEqual(egressBytes(egress, 'omm'), bytesOf(attach, 'omm'));

  const [ocm] = records(egressBytes(egress, 'ocm')).map(unpackOcm);
  const [cvr] = ocm.COV_REALISM;
  assert.equal(cvr.RULE, OCM.covarianceRule.PooledModel, 'NASA\'s ephemeris carries no covariance and no model of its own exists: the pooled model answers');
  assert.equal(cvr.REGIME, 'LEO-L');
  assert.equal(cvr.CALIBRATION, Uncalibrated);
  assert.equal(cvr.MEASURED_LINEAGE, 'space-track-gp', 'the cell was measured on Space-Track\'s sets, not NASA\'s');
  assert.equal(ocm.COV_CALIBRATION, Uncalibrated);
  assert.equal(ocm.METADATA.OBJECT_DESIGNATOR, '25544');
  assertSourceNamed(ocm, recipe);
  const report = covarianceReport(egress);
  assert.match(JSON.stringify(report.objects[0].notes), /the operator ephemeris carries no covariance/);
  assert.equal(report.counts.rule4, 1);
  const [fitted] = records(egressBytes(egress, 'omm')).map(unpackOmm);
  assert.equal(fitted.NORAD_CAT_ID, 25544);
  assert.equal(fitted.ORIGINATOR, recipe.producer);
  assertSourceNamed(fitted, recipe);
  assert.equal(provenanceOf(fitted).SOURCE_ID, 'nasa-iss-oem', 'the record names its source, not the fit that produced it');
});

test('an ephemeris source with covariance: the operator\'s is rule 1; a planned burn is checked against the next version and attributed', async () => {
  const pre = LEO();
  const tig = T0 + 86400;
  const [r, v] = pre(tig);
  const post = kepler(r, add(v, mul(unit(v), 0.001)), tig);
  const plan = (s) => (s < tig ? pre : post)(s);
  const before = Buffer.from(ephemerisVersion(plan, T0, T0 + 3 * 86400, tig - 7200));
  const after = Buffer.from(ephemerisVersion(post, tig + 6 * 3600, T0 + 3 * 86400, tig + 8 * 3600));
  const planned = Buffer.from(plannedBurn(tig, 0.001));
  // A fit set for the object and an operator ephemeris with covariance at its epoch.
  const fit = { ...leoH, norad: 99001, objectId: '2026-900A', epoch: '2026-09-01T00:00:00.000000' };
  const fitBytes = encodeOmm(fit);
  const lower = Array.from({ length: 21 }, (_, i) => (i === 0 || i === 2 || i === 5 ? 1e-4 : i === 9 || i === 14 || i === 20 ? 1e-10 : 0));
  const [r0, v0] = pre(T0);
  const operator = operatorOem({ objectId: '2026-900A', norad: 99001, name: 'OPERATOR TEST', frame: 'EME2000', covFrame: 'UVW',
    rows: [0, 60].map((s) => { const [r1, v1] = pre(T0 + s); return { epoch: new Date((T0 + s) * 1000).toISOString(), x: [...r1, ...v1] }; }),
    cov: [{ epoch: new Date(T0 * 1000).toISOString(), lower }] });
  assert.ok(r0 && v0);
  const recipe = recipeFor({ id: 'spacex-starlink', kind: 'ephemeris', lineage: 'spacex-meme', own: false });
  const { egress } = await run([frame('fit_omm', 'omm', fitBytes), frame('ephemeris', 'operator', operator), frame('ephemeris_versions', 'versions', before),
    frame('ephemeris_versions', 'versions', after), frame('planned_maneuvers', 'planned', planned)], recipe);

  const [ocm] = records(egressBytes(egress, 'ocm')).map(unpackOcm);
  assert.equal(ocm.COV_REALISM[0].RULE, OCM.covarianceRule.Operator);
  assertSourceNamed(ocm, recipe);
  assert.deepEqual(ocm.COVARIANCE_DATA, lower, 'the operator\'s covariance, as supplied');
  const [executed] = records(egressBytes(egress, 'mnv')).map(unpackMnv);
  assert.equal(executed.STATUS, MD_MNV.maneuverStatus.EXECUTED);
  assert.ok(executed.DELTA_VEL_V > 0);
  assertSourceNamed(executed, recipe, DETECTOR);
  // The comparison's report is one $MDE with the COMPARE_REPORT arm.
  const compared = await reportOf(egressBytes(egress, 'compare_report'));
  assert.equal(compared.method, 'compare_ephemerides');
});

test('an ephemeris source\'s history of fitted sets is screened in the same two passes, and the burn carries the ephemeris source', async () => {
  const { tb, rows } = gpHistory(1);
  const sets = ommBytes(rows);
  const recipe = recipeFor({ id: 'spacex-starlink', kind: 'ephemeris', lineage: 'spacex-meme', own: false, licence: 'reproducible' });
  const { egress, result } = await run([frame('fit_omm', 'omm', sets)], recipe);
  assert.equal(result.handlersSkipped, 0);
  const attributed = await screenedForManeuvers(sets, recipe);
  assert.deepEqual(egressBytes(egress, 'mnv'), bytesOf(attributed, 'maneuvers'), 'the flow\'s $MNV is the chain\'s');

  const burns = records(egressBytes(egress, 'mnv')).map(unpackMnv).filter((m) => m.DELTA_VEL_V !== 0);
  assert.equal(burns.length, 1);
  assert.ok(Math.abs(burns[0].DELTA_VEL_V * 1000 - 1) < 0.1, `${burns[0].DELTA_VEL_V * 1000} m/s`);
  assert.ok(Math.abs(Date.parse(burns[0].EVENT_START_TIME) / 1000 - tb) < 8 * 3600);
  assertSourceNamed(burns[0], recipe, DETECTOR);

  // The newest fitted set alone is the product's element set: one $OCM, the pooled model's covariance.
  const ocms = records(egressBytes(egress, 'ocm')).map(unpackOcm);
  assert.equal(ocms.length, 1);
  assert.equal(ocms[0].COV_REALISM[0].RULE, OCM.covarianceRule.PooledModel);
});

// ── an observation source ──
test('an observation source: the fit\'s formal covariance times the measured realism factor, uncalibrated, with the measurement behind it', async () => {
  const x = [4000.5, 5000.25, 3000.125, -3.5, 4.25, 4.75];
  const lower = Array.from({ length: 21 }, (_, i) => (i === 0 || i === 2 || i === 5 ? 1e-6 : i === 9 || i === 14 || i === 20 ? 1e-12 : 0));
  const realism = [{ sources: ['ilrs-crd'], class: 'slr-ffm-fit', factor: 17.04, meanD2Over3: 17.04, coverage95: 0.17, samples: 1000, objects: 5, evidence: 'orbit-accuracy-experiments E6 test', window: '2026-05-01..2026-09-30' }];
  const recipe = recipeFor({ id: 'ilrs-crd', kind: 'observation', lineage: 'ilrs-slr', own: false, fitClass: 'slr-ffm-fit', licence: 'reproducible', extra: { realism } });
  const fit = fitOcm({ norad: 90101, name: leoH.name, epoch: '2026-10-01T12:00:00.000000', x, lower });
  const { egress } = await run([frame('fit_omm', 'omm', encodeOmm(leoH)), frame('fit', 'fit', fit)], recipe);
  const states = await deriveOmm(omm('omm', encodeOmm(leoH)), recipe);
  const attach = await attachCovariance(recipe, [omm('elements', encodeOmm(leoH)), oemIn('states', states), ocmFrame('fit', fit)]);
  assert.deepEqual(egressBytes(egress, 'ocm'), bytesOf(attach, 'ocm'));
  assert.deepEqual(egressBytes(egress, 'omm'), bytesOf(attach, 'omm'));
  const [ocm] = records(egressBytes(egress, 'ocm')).map(unpackOcm);
  const [cvr] = ocm.COV_REALISM;
  assert.equal(cvr.RULE, OCM.covarianceRule.ScaledFit);
  assert.equal(cvr.SCALE_FACTOR, 17.04);
  assert.equal(cvr.MEAN_D2_OVER_3, 17.04);
  assert.equal(cvr.CALIBRATION, Uncalibrated);
  assert.ok(Math.abs(ocm.COVARIANCE_DATA[0] - 1e-6 * 17.04) < 1e-18);
  assertSourceNamed(ocm, recipe);
});

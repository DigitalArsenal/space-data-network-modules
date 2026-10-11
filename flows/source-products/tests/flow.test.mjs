// The source-products flow, compiled and run in the SDK's JS flow host. Each lane's egress is compared byte for byte
// with the chain of modules it composes (called one by one through the SDK's browser module harness), and the
// outcomes that matter are asserted on the records: the covariance rule, its label, the maneuver and the source on it.
// Expected numbers come from the model file, the designed inputs, and the detector's own closed-form fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';

import {
  alignedOem, cellOf, encodeMnv, encodeOmm, expectedCovariance, fitOcm, json, leoH, OCM, OEM, OMM, ocmFrame, ommFrame, operatorOem, param, recipeFor, records, unpackMnv, unpackOcm,
  unpackOmm, flatbuffers,
} from '../../../analysis/gp-error-model/tests/products-fixtures.mjs';
import { gpHistory, LEO, T0, add, kepler, mul, unit, version as ephemerisVersion, planned as plannedBurn, MNV as MD_MNV } from '../../../analysis/maneuver-detection/tests/fixtures.mjs';
import { ommRecord } from '../../../analysis/maneuver-detection/study/lib/host.mjs';
import { bytesOf, egressBytes, egressJson, flowDocument, flowManifest, framesOf, moduleAt, runFlow } from './flow-harness.mjs';

const epoch = moduleAt('analysis/epoch-state');
const gem = moduleAt('analysis/gp-error-model');
const detector = moduleAt('analysis/maneuver-detection');
const frame = (trigger, portId, bytes) => ({ trigger, portId, bytes });
const recipeBytes = (recipe) => Buffer.from(JSON.stringify(recipe));
const ommBytes = (rows) => Buffer.concat(rows.map((r) => Buffer.from(ommRecord(r))));
const alignedState = (portId, payload) => ({ portId, payload, typeRef: { schemaName: 'OEM.fbs', fileIdentifier: '$OEM', rootTypeName: 'OEM', wireFormat: 'aligned-binary', requiredAlignment: 8, byteLength: payload.byteLength } });
const jsonPort = (portId, bytes) => ({ portId, payload: bytes, typeRef: { schemaName: 'application/json' } });
const omm = (portId, payload) => ommFrame(portId, payload);
const mnvIn = (portId, payload) => ({ portId, payload, typeRef: { schemaName: 'MNV.fbs', fileIdentifier: '$MNV', rootTypeName: 'MNV', wireFormat: 'flatbuffer' } });

test('the compiled flow takes one ingress per kind of frame and gives the products on one egress', () => {
  assert.deepEqual(flowDocument.triggers.map((t) => t.triggerId), ['element_sets', 'element_set_recipe', 'fit_omm', 'ephemeris', 'ephemeris_versions', 'planned_maneuvers', 'fit', 'fit_recipe']);
  assert.deepEqual(flowManifest.methods.find((m) => m.methodId === 'element_sets').outputPorts.map((p) => p.portId),
    ['ocm', 'omm', 'covariance_report', 'derive_report', 'mnv', 'attribute_report', 'detect_report', 'propagation_report', 'compare_report']);
  assert.deepEqual(flowManifest.runtimeTargets, ['browser', 'wasmedge']);
  assert.deepEqual(flowManifest.capabilities, [], 'pure compute: the flow asks its host for nothing');
});

test('an element-set source: the newest set of an object gets states, a covariance by rule and its label; the history is screened and the burn found, attributed to the source', async () => {
  const { tb, rows } = gpHistory(1);
  const sets = ommBytes(rows);
  const recipe = { ...recipeFor({ id: 'celestrak-gp' }), ages: [0, 0.5] };
  const { egress, result } = await runFlow([frame('element_sets', 'omm', sets), frame('element_set_recipe', 'recipe', recipeBytes(recipe))]);
  assert.equal(result.handlersSkipped, 0);

  // The chain of modules the flow composes, called one by one.
  const states = bytesOf(await epoch('derive_omm', [omm('omm', sets), jsonPort('options', recipeBytes(recipe))]), 'states');
  const attach = await gem('attach_covariance', [omm('elements', sets), alignedState('states', states), jsonPort('recipe', recipeBytes(recipe))]);
  const first = await detector('detect_maneuvers', [omm('element_sets', sets)]);
  const answered = await epoch('answer_propagation_requests', [jsonPort('requests', bytesOf(first, 'propagation_requests')), omm('element_sets', sets)]);
  const second = await detector('detect_maneuvers', [omm('element_sets', bytesOf(answered, 'element_sets')), { portId: 'propagation', payload: bytesOf(answered, 'propagation'),
    typeRef: { schemaName: 'OEM.fbs', fileIdentifier: '$OEM', rootTypeName: 'OEM', wireFormat: 'flatbuffer' } }]);
  const attributed = await gem('attribute_maneuvers', [...framesOf(second, 'maneuvers').map((m) => mnvIn('maneuvers', m)), jsonPort('recipe', recipeBytes(recipe))]);

  assert.deepEqual(egressBytes(egress, 'ocm'), bytesOf(attach, 'ocm'), 'the flow\'s $OCM is the chain\'s');
  assert.deepEqual(egressBytes(egress, 'omm'), bytesOf(attach, 'omm'), 'the flow\'s $OMM is the chain\'s');
  assert.deepEqual(egressBytes(egress, 'mnv'), bytesOf(attributed, 'maneuvers'), 'the flow\'s $MNV is the chain\'s');

  // The newest set of NORAD 99999: 51.6 degrees at 15.5 rev/day, a LEO-L orbit.
  const [ocm] = records(egressBytes(egress, 'ocm')).map(unpackOcm);
  assert.equal(ocm.STATE_EPOCHS.length, 2);
  assert.equal(ocm.STATE_EPOCHS[0].slice(0, 19), rows.at(-1).EPOCH.slice(0, 19));
  const label = JSON.parse(param(ocm, 'COV_LABELS'))[0];
  assert.equal(label.regime, 'LEO-L');
  assert.equal(label.rule, 3);
  assert.equal(label.calibration, cellOf('LEO-L', 0).calibration);
  [0, 1].forEach((k) => assert.ok(Math.abs(ocm.COVARIANCE_DATA[21 * k] - expectedCovariance('LEO-L', [0, 0.5][k])[0]) < 1e-12));
  const [mmo] = records(egressBytes(egress, 'omm')).map(unpackOmm);
  assert.equal(mmo.NORAD_CAT_ID, 99999);
  assert.equal(mmo.ORIGINATOR, 'CelesTrak');
  assert.equal(egressJson(egress, 'covariance_report').counts.rule3, 1);

  // The 1 m/s burn between sets 15 and 16, found through the detector's two passes with SGP4 answering the port.
  const burns = records(egressBytes(egress, 'mnv')).map(unpackMnv).filter((m) => m.DELTA_VEL_U !== 0);
  assert.equal(burns.length, 1);
  assert.ok(Math.abs(burns[0].DELTA_VEL_U * 1000 - 1) < 0.1, `${burns[0].DELTA_VEL_U * 1000} m/s`);
  assert.ok(Math.abs(Date.parse(burns[0].EVENT_START_TIME) / 1000 - tb) < 8 * 3600);
  for (const tag of ['originator:CelesTrak', 'source:celestrak-gp', 'provider:sdn:celestrak-gp', 'licence:redistributable', 'lineage:space-track-gp']) assert.ok(burns[0].TAGS.includes(tag), tag);
  assert.equal(egressJson(egress, 'propagation_report').refused, 0);
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
  const recipe = { ...recipeFor({ id: 'nasa-iss-oem', kind: 'ephemeris', lineage: 'nasa-iss-oem', own: false, licence: 'public-domain' }), ages: [0, 1] };
  const { egress } = await runFlow([frame('fit_omm', 'omm', fit.omm), frame('ephemeris', 'operator', ephemeris), frame('fit_recipe', 'recipe', recipeBytes(recipe))]);

  const states = bytesOf(await epoch('derive_omm', [{ ...omm('omm', fit.omm), typeRef: { ...ommFrame('omm', fit.omm).typeRef } }, jsonPort('options', recipeBytes(recipe))]), 'states');
  const attach = await gem('attach_covariance', [omm('elements', fit.omm), alignedState('states', states), { portId: 'operator', payload: ephemeris,
    typeRef: { schemaName: 'OEM.fbs', fileIdentifier: '$OEM', rootTypeName: 'OEM', wireFormat: 'flatbuffer' } }, jsonPort('recipe', recipeBytes(recipe))]);
  assert.deepEqual(egressBytes(egress, 'ocm'), bytesOf(attach, 'ocm'));
  assert.deepEqual(egressBytes(egress, 'omm'), bytesOf(attach, 'omm'));

  const [ocm] = records(egressBytes(egress, 'ocm')).map(unpackOcm);
  const labels = JSON.parse(param(ocm, 'COV_LABELS'));
  assert.equal(labels[0].rule, 4, 'NASA\'s ephemeris carries no covariance and no model of its own exists: the pooled model answers');
  assert.equal(labels[0].regime, 'LEO-L');
  assert.equal(labels[0].calibration, 'UNCALIBRATED');
  assert.match(labels[0].basis, /not measured on nasa-iss-oem/);
  assert.equal(ocm.COV_CALIBRATION, OCM.covarianceCalibration.Uncalibrated);
  assert.equal(ocm.METADATA.OBJECT_DESIGNATOR, '25544');
  assert.equal(param(ocm, 'LICENCE_CLASS'), 'public-domain');
  const report = egressJson(egress, 'covariance_report');
  assert.match(JSON.stringify(report.objects[0].notes), /the operator ephemeris carries no covariance/);
  assert.equal(report.counts.rule4, 1);
  const [fitted] = records(egressBytes(egress, 'omm')).map(unpackOmm);
  assert.equal(fitted.NORAD_CAT_ID, 25544);
  assert.equal(fitted.ORIGINATOR, 'nasa-iss-oem originator', 'the record names its source, not the fit that produced it');
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
  const { egress } = await runFlow([frame('fit_omm', 'omm', fitBytes), frame('ephemeris', 'operator', operator), frame('ephemeris_versions', 'versions', before),
    frame('ephemeris_versions', 'versions', after), frame('planned_maneuvers', 'planned', planned), frame('fit_recipe', 'recipe', recipeBytes(recipe))]);

  const [ocm] = records(egressBytes(egress, 'ocm')).map(unpackOcm);
  const label = JSON.parse(param(ocm, 'COV_LABELS'))[0];
  assert.equal(label.rule, 1);
  assert.equal(label.method, 'operator-supplied');
  assert.deepEqual(ocm.COVARIANCE_DATA, lower, 'the operator\'s covariance, as supplied');
  const [executed] = records(egressBytes(egress, 'mnv')).map(unpackMnv);
  assert.equal(executed.STATUS, MD_MNV.maneuverStatus.EXECUTED);
  assert.ok(executed.DELTA_VEL_U > 0);
  for (const tag of ['source:spacex-starlink', 'originator:spacex-starlink originator', 'licence:redistributable']) assert.ok(executed.TAGS.includes(tag), tag);
  assert.equal(egressJson(egress, 'compare_report').method, 'compare_ephemerides');
});

// ── an observation source ──
test('an observation source: the fit\'s formal covariance times the measured realism factor, uncalibrated, with the measurement behind it', async () => {
  const x = [4000.5, 5000.25, 3000.125, -3.5, 4.25, 4.75];
  const lower = Array.from({ length: 21 }, (_, i) => (i === 0 || i === 2 || i === 5 ? 1e-6 : i === 9 || i === 14 || i === 20 ? 1e-12 : 0));
  const realism = [{ sources: ['ilrs-crd'], class: 'slr-hpop-fit', factor: 17.04, meanD2Over3: 17.04, coverage95: 0.17, samples: 1000, objects: 5, evidence: 'orbit-accuracy-experiments E6 test', window: '2026-05-01..2026-09-30' }];
  const recipe = recipeFor({ id: 'ilrs-crd', kind: 'observation', lineage: 'ilrs-slr', own: false, fitClass: 'slr-hpop-fit', licence: 'cc-by-4.0', extra: { realism } });
  const fit = fitOcm({ norad: 90101, name: leoH.name, epoch: '2026-10-01T12:00:00.000000', x, lower });
  const { egress } = await runFlow([frame('fit_omm', 'omm', encodeOmm(leoH)), frame('fit', 'fit', fit), frame('fit_recipe', 'recipe', recipeBytes(recipe))]);
  const states = bytesOf(await epoch('derive_omm', [omm('omm', encodeOmm(leoH)), jsonPort('options', recipeBytes(recipe))]), 'states');
  const attach = await gem('attach_covariance', [omm('elements', encodeOmm(leoH)), alignedState('states', states), ocmFrame('fit', fit), jsonPort('recipe', recipeBytes(recipe))]);
  assert.deepEqual(egressBytes(egress, 'ocm'), bytesOf(attach, 'ocm'));
  assert.deepEqual(egressBytes(egress, 'omm'), bytesOf(attach, 'omm'));
  const [ocm] = records(egressBytes(egress, 'ocm')).map(unpackOcm);
  const label = JSON.parse(param(ocm, 'COV_LABELS'))[0];
  assert.equal(label.rule, 2);
  assert.equal(label.scaleFactor, 17.04);
  assert.equal(label.meanD2Over3, 17.04);
  assert.equal(label.calibration, 'UNCALIBRATED');
  assert.ok(Math.abs(ocm.COVARIANCE_DATA[0] - 1e-6 * 17.04) < 1e-18);
  assert.equal(param(ocm, 'LICENCE_CLASS'), 'cc-by-4.0');
});

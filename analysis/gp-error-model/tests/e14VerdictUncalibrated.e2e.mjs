// A population model's cells give no Calibrated verdict (gp-error-model 0.11.0). E14 tested its cells by time only (a
// held-out window, not held-out objects) and only on the precise orbits of payloads, so its two passing cells (LEO-H at
// 0 and 0.5 days) say nothing of the object at hand, rocket bodies and debris included. 0.10.0 labeled every object in
// them Calibrated; 0.11.0 labels them Uncalibrated, with the reason in the report's NOTES, and the matrices unchanged.
// The input: one circular LEO-H element set (mean motion 13.7 rev/day, about 985 km; e 0.001), alone, so
// object_covariance has no history of it and answers on the POPULATION path. Age 0.25 days falls in E14's [0.25, 0.75)
// day bin, the cell E14 found realistic at 0.5 days (data/e14-s3-kc.json: mean d^2/3 1.219, 95 % coverage 0.936,
// 4,266 samples of 10 objects). Both builds answer the same request bytes: this checkout's dist/ and 0.10.0's, read from
// git at BASE. Each method is called as its consumer calls it: object_covariance as the console does (no models port: the
// embedded E14 S3-KC) and as the node's object-covariance flow does (object.source on: the $OCM record);
// attach_covariance with the source-products flow's own recipe for CelesTrak's GP sets (rule 3, the lineage E14 measured).
// Run: node --test analysis/gp-error-model/tests/e14VerdictUncalibrated.e2e.mjs (needs dist/ built and the git history).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import { decode, frame, modelsFrame, recipeConfig, standardsRoot } from '../scripts/erm-codec.mjs';
import { recipeFor } from '../../../flows/source-products/recipe.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const moduleRoot = path.resolve(here, '..');
const BASE = 'b93ec1af73f1eae3ecc82aaa1e74baed3606f3fe';  // modules main with gp-error-model 0.10.0, the parent of 0.11.0's commits
const NOTE = 'population cell tested by time only, on payload truth';
const fb = createRequire(path.join(standardsRoot, 'package.json'))('flatbuffers');
const [OMM, OCM] = await Promise.all(['OMM', 'OCM'].map((code) => import(pathToFileURL(path.join(standardsRoot, `lib/js/${code}/main.js`)))));
const kc = JSON.parse(fs.readFileSync(path.join(moduleRoot, 'data/e14-s3-kc.json'), 'utf8'));
const cell = kc.cells.find((c) => c.regime === 'LEO-H' && c.ageIndex === 1);
const git = (file) => execFileSync('git', ['-C', moduleRoot, 'show', `${BASE}:analysis/gp-error-model/${file}`], { maxBuffer: 1 << 26 });
const builds = {
  '0.11.0': { wasm: fs.readFileSync(path.join(moduleRoot, 'dist/isomorphic/module.wasm')), manifest: JSON.parse(fs.readFileSync(path.join(moduleRoot, 'plugin-manifest.json'), 'utf8')) },
  '0.10.0': { wasm: git('dist/isomorphic/module.wasm'), manifest: JSON.parse(git('plugin-manifest.json').toString('utf8')) },
};
const epochState = { wasm: fs.readFileSync(path.join(moduleRoot, '../epoch-state/dist/isomorphic/module.wasm')),
  manifest: JSON.parse(fs.readFileSync(path.join(moduleRoot, '../epoch-state/plugin-manifest.json'), 'utf8')) };

async function invoke(build, methodId, inputs, config = {}) {
  const h = await createBrowserModuleHarness({ wasmSource: build.wasm, manifest: build.manifest, surface: 'direct', hostOptions: { config } });
  try {
    const r = await h.invoke({ methodId, inputs });
    assert.equal(r.statusCode, 0, `${methodId}: ${r.errorMessage}`);
    return r;
  } finally {
    h.destroy();
  }
}
const port = (r, portId) => Buffer.concat(r.outputs.filter((f) => f.portId === portId).map((f) => Buffer.from(f.payload)));
const typeRef = (code) => ({ schemaName: `${code}.fbs`, fileIdentifier: `$${code}`, rootTypeName: code, wireFormat: 'flatbuffer' });
const unpackOcm = (b) => OCM.OCM.getSizePrefixedRootAsOCM(new fb.ByteBuffer(new Uint8Array(b))).unpack();
const unpackOmm = (b) => OMM.OMM.getSizePrefixedRootAsOMM(new fb.ByteBuffer(new Uint8Array(b))).unpack();
const bitIdentical = (a, b, what) => {
  assert.equal(a.length, b.length, `${what}: length`);
  a.forEach((x, i) => assert.ok(Object.is(x, b[i]), `${what}[${i}]: ${x} against 0.10.0's ${b[i]}`));
};

const set = { norad: 90101, objectId: '2026-101A', name: 'LEO-H TEST', epoch: '2026-10-01T12:00:00.000000' };
const omm = (() => {
  const t = new OMM.OMMT();
  Object.assign(t, { EPOCH: set.epoch, NORAD_CAT_ID: set.norad, OBJECT_ID: set.objectId, OBJECT_NAME: set.name, ORIGINATOR: 'TEST',
    MEAN_ELEMENT_THEORY: OMM.meanElementSource.SGP4, MEAN_MOTION: 13.7, ECCENTRICITY: 0.001, INCLINATION: 65, RA_OF_ASC_NODE: 120,
    ARG_OF_PERICENTER: 90, MEAN_ANOMALY: 10, BSTAR: 1e-5 });
  const b = new fb.Builder(512);
  OMM.OMM.finishSizePrefixedOMMBuffer(b, t.pack(b));
  return Buffer.from(b.asUint8Array());
})();
const elements = { portId: 'elements', payload: omm, typeRef: typeRef('OMM') };
const request = frame('request', 'objects', { objects: [{ id: 'leo-h', set: { norad: set.norad, epoch: `${set.epoch}Z` }, ageDays: 0.25 }] });
// attach_covariance takes an element set's states from its epoch on, so the rows are at 0 and 0.25 days: E14's two passing cells.
const recipe = recipeFor('celestrak-gp', { created: '2026-10-30T00:00:00Z', ages: [0, 0.25] });

test('object_covariance: a LEO-H set at 0.25 days on POPULATION is Uncalibrated, with 0.10.0\'s matrix bit for bit', async () => {
  const [now, before] = await Promise.all(['0.11.0', '0.10.0'].map((v) => invoke(builds[v], 'object_covariance', [elements, request])));
  const [covNow, covBefore] = [now, before].map((r) => decode(port(r, 'covariance')));
  const row = covNow.objects[0];
  assert.deepEqual([row.status, row.regime, row.cell.ageIndex], ['POPULATION', 'LEO-H', 1], 'E14\'s passing cell, on the population path');
  bitIdentical(row.covarianceRtn, covBefore.objects[0].covarianceRtn, 'covarianceRtn (m, m/s)');
  bitIdentical(row.covarianceInertial, covBefore.objects[0].covarianceInertial, 'covarianceInertial (GCRF, m, m/s)');
  assert.ok(port(now, 'covariance').equals(port(before, 'covariance')), 'the covariance frame is 0.10.0\'s, byte for byte');

  const [repNow, repBefore] = [now, before].map((r) => decode(port(r, 'report')));
  assert.equal(repBefore.objects[0].calibrated, true, '0.10.0 called the object Calibrated');
  const entry = repNow.objects[0], label = entry.rows[0];
  assert.equal(entry.calibrated, false);
  assert.equal(label.calibration, 'UNCALIBRATED');
  assert.equal(label.rule, 3, 'SourceModel: the embedded E14 S3-KC is not pooled');
  // The report's SAMPLES and OBJECTS count the object's history (none here); the $OCM's CVR carries the cell's (next test).
  assert.deepEqual([label.meanD2Over3, label.coverage95], [cell.meanD2Over3, cell.coverage95], 'the cell\'s held-out numbers stay on the CVR');
  assert.deepEqual(entry.notes.filter((n) => n.reason === NOTE), [{ rule: 3, reason: NOTE }]);
  // Nothing else moved: 0.10.0's report with the verdict and the note is 0.11.0's.
  const expected = structuredClone(repBefore);
  expected.objects[0].calibrated = false;
  expected.objects[0].rows[0].calibration = 'UNCALIBRATED';
  expected.objects[0].notes.push(entry.notes.at(-1));
  assert.deepEqual(repNow, expected);
});

test('object_covariance on the node (object.source): the $OCM record is Uncalibrated, its state and covariance 0.10.0\'s', async () => {
  const config = { object: { source: recipe.source } };
  const [now, before] = await Promise.all(['0.11.0', '0.10.0'].map((v) => invoke(builds[v], 'object_covariance', [elements, request], config)));
  const [ocmNow, ocmBefore] = [now, before].map((r) => unpackOcm(port(r, 'ocm')));
  assert.equal(ocmBefore.COV_REALISM[0].CALIBRATION, OCM.covarianceCalibration.Calibrated, '0.10.0 wrote a Calibrated CVR');
  assert.equal(ocmNow.COV_REALISM[0].CALIBRATION, OCM.covarianceCalibration.Uncalibrated);
  assert.equal(ocmNow.COV_CALIBRATION, OCM.covarianceCalibration.Uncalibrated);
  assert.equal(ocmNow.COV_REALISM[0].RULE, OCM.covarianceRule.SourceModel);
  assert.deepEqual([ocmNow.COV_REALISM[0].SAMPLES, ocmNow.COV_REALISM[0].OBJECTS], [cell.samples, cell.objects], 'the cell\'s held-out test');
  bitIdentical(ocmNow.COVARIANCE_DATA, ocmBefore.COVARIANCE_DATA, 'COVARIANCE_DATA (GCRF, km, km/s)');
  bitIdentical(ocmNow.STATE_DATA, ocmBefore.STATE_DATA, 'STATE_DATA (GCRF, km, km/s)');
  ocmBefore.COV_REALISM[0].CALIBRATION = ocmBefore.COV_CALIBRATION = OCM.covarianceCalibration.Uncalibrated;
  assert.deepEqual(ocmNow, ocmBefore, 'the record is 0.10.0\'s apart from its verdict');
});

test('attach_covariance rule 3 (the source-products recipe for CelesTrak GP): the same set at 0.25 days gets an Uncalibrated CVR, as at 0 days', async () => {
  const states = port(await invoke(epochState, 'derive_omm', [{ portId: 'omm', payload: omm, typeRef: typeRef('OMM') }], { ages: recipe.ages }), 'states');
  const inputs = [elements, { portId: 'states', payload: states, typeRef: typeRef('OEM') }, modelsFrame(recipe.models)];
  const { models, ages, ...attach } = recipe;
  const [now, before] = await Promise.all(['0.11.0', '0.10.0'].map((v) => invoke(builds[v], 'attach_covariance', inputs, recipeConfig(attach, 'attach'))));
  const [ocmNow, ocmBefore] = [now, before].map((r) => unpackOcm(port(r, 'ocm')));
  const [ommNow, ommBefore] = [now, before].map((r) => unpackOmm(port(r, 'omm')));
  assert.deepEqual(ocmBefore.COV_REALISM.map((c) => c.CALIBRATION), [OCM.covarianceCalibration.Calibrated, OCM.covarianceCalibration.Calibrated],
    '0.10.0 wrote Calibrated CVRs at 0 and 0.25 days');
  assert.deepEqual(ocmNow.COV_REALISM.map((c) => c.CALIBRATION), [OCM.covarianceCalibration.Uncalibrated, OCM.covarianceCalibration.Uncalibrated]);
  const cvr = ocmNow.COV_REALISM[1];
  assert.equal(cvr.AGE_DAYS, 0.25);
  assert.deepEqual([cvr.RULE, cvr.REGIME, cvr.MEASURED_LINEAGE], [OCM.covarianceRule.SourceModel, 'LEO-H', 'space-track-gp']);
  assert.deepEqual([cvr.MEAN_D2_OVER_3, cvr.COVERAGE_95, cvr.SAMPLES, cvr.OBJECTS], [cell.meanD2Over3, cell.coverage95, cell.samples, cell.objects]);
  assert.equal(ocmNow.COV_CALIBRATION, OCM.covarianceCalibration.Uncalibrated);
  assert.equal(ommNow.COV_REALISM.CALIBRATION, OCM.covarianceCalibration.Uncalibrated, 'the $OMM carries the same CVR');
  bitIdentical(ocmNow.COVARIANCE_DATA, ocmBefore.COVARIANCE_DATA, '$OCM COVARIANCE_DATA (RSW, km, km/s)');
  bitIdentical(ommNow.COVARIANCE, ommBefore.COVARIANCE, '$OMM COVARIANCE (RSW, km, km/s)');

  const report = decode(port(now, 'report')).objects[0];
  assert.equal(report.rule, 3);
  assert.equal(report.calibrated, false);
  assert.equal(report.rows[1].basis, 'the cell passed the realism rule on the held-out window for space-track-gp', 'the basis states the cell\'s test');
  assert.deepEqual(report.notes.filter((n) => n.reason === NOTE), [{ rule: 3, reason: NOTE }]);
});

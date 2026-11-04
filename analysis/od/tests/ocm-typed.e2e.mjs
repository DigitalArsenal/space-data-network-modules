#!/usr/bin/env node
// E2E (modules-od-ocm-builder-typed-20261103): the fit's $OCM states its frame, covariance layout and fit statistics in
// typed fields, and gp-error-model reads the frame from TRAJ_REF_FRAME only.
//
// 1. The built module (dist/isomorphic/module.wasm, browser runtime) fits the synthetic operator-layout MEME the
//    fixture names. Its $OCM has TRAJ_REF_FRAME and COV_REF_FRAME TEMEOFDATE as CelestialFrame members, COV_ORDERING
//    LTM, COV_UNITS, COV_PARAMETER_KINDS (none: a 6x6 state covariance), and FIT_STATISTICS whose FIT_RMS_KM,
//    ITERATIONS, CONVERGED and arc equal what the build before the change wrote (tests/fixtures/ocm-typed.recorded.json:
//    the $OBD WRMS, NUM_ITERATIONS and FIT_SPAN, the OD_RESIDUALS and OD_CONVERGENCE_CRITERIA text, the state epoch).
//    assertNoUserDefined on the record.
// 2. gp-error-model attach_covariance takes that $OCM, applies rule 2 to a fit $OCM whose frame is only in
//    TRAJ_REF_FRAME, and refuses one without TRAJ_REF_FRAME by name (frame-missing), even when the retired
//    STATE_REFERENCE_FRAME parameter names one.
// 3. Its guard (assertSourceNamed) rejects a record carrying any retired key.
//
//   node analysis/od/tests/ocm-typed.e2e.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as flatbuffers from 'flatbuffers';
import { createFitPoolOrSkip, createFitRequest, fitRecordFromResponse } from './fit_harness.mjs';
import { assertNoUserDefined } from '../../../common/tests/no-user-defined.mjs';
import {
  OCM, assertSourceNamed, call, deriveStates, encodeOmm, expectedProvenance, fitOcm, json, leoH, ocmFrame, ommFrame, oemFrame, recipeFor, reportOf,
} from '../../gp-error-model/tests/products-fixtures.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const recorded = JSON.parse(fs.readFileSync(here('fixtures/ocm-typed.recorded.json'), 'utf8'));
const input = fs.readFileSync(here(`../${recorded.recordedFrom.input}`));
const inputStates = input.toString().split('\n').filter((line) => /^\d{13}\.\d{3}\s/.test(line)).length;

// ── 1. the module's $OCM ──
const pool = await createFitPoolOrSkip('browser', new URL('../dist/isomorphic/module.wasm', import.meta.url), { skip(why) { throw new Error(why); } }, { enableThreads: true });
let response;
try { response = await pool.invoke(createFitRequest(input, recorded.recordedFrom.config)); } finally { await pool.destroy(); }
const fitted = fitRecordFromResponse(response);
const bytes = response.outputs.find((o) => o.portId === 'ocm').payload;
assertNoUserDefined(bytes);
const ocm = fitted.ocm.unpack();
const frameOf = (rfm) => {
  assert.equal(rfm.REFERENCE_FRAME_type, OCM.RFMUnion.CelestialFrameWrapper);
  return OCM.CelestialFrame[rfm.REFERENCE_FRAME.frame];
};
assert.equal(frameOf(ocm.TRAJ_REF_FRAME), 'TEMEOFDATE');
assert.equal(frameOf(ocm.COV_REF_FRAME), 'TEMEOFDATE');
assert.equal(ocm.COV_ORDERING, OCM.covarianceOrdering.LTM);
assert.equal(ocm.COV_TYPE, 'CARTPV');
assert.equal(ocm.COV_SIZE, 6);
assert.deepEqual(ocm.COV_UNITS, ['km', 'km', 'km', 'km/s', 'km/s', 'km/s']);
assert.deepEqual(ocm.COV_PARAMETER_KINDS, []);
assert.deepEqual(ocm.COV_PARAMETERS, []);
assert.equal(ocm.COV_CALIBRATION, OCM.covarianceCalibration.Uncalibrated);
assert.deepEqual(ocm.USER_DEFINED_PARAMETERS, []);

const od = ocm.ORBIT_DETERMINATION, fit = od.FIT_STATISTICS;
assert.equal(fit.FIT_RMS_KM, recorded.obd.WRMS, 'FIT_RMS_KM equals the WRMS the build before the change wrote');
assert.equal(recorded.ocm.OD_RESIDUALS, `WRMS=${Number(fit.FIT_RMS_KM.toPrecision(9))} km`, 'and the OD_RESIDUALS text it wrote');
assert.equal(fit.ITERATIONS, recorded.obd.NUM_ITERATIONS);
assert.equal(fit.CONVERGED, /converged=1/.test(recorded.ocm.OD_CONVERGENCE_CRITERIA));
assert.equal(fit.FIT_STATES, inputStates);
assert.equal(fit.FIT_START, recorded.ocm.START_TIME, 'the arc starts at the state epoch the build before the change wrote');
const span = (Date.parse(fit.FIT_STOP) - Date.parse(fit.FIT_START)) / 86400e3;
assert.ok(Math.abs(span - recorded.obd.FIT_SPAN) < 1e-8, `FIT_STOP - FIT_START ${span} d against FIT_SPAN ${recorded.obd.FIT_SPAN} d`);
assert.equal(od.ACTUAL_OD_SPAN, recorded.obd.FIT_SPAN);
assert.equal(od.OD_CONVERGENCE_CRITERIA, null);
assert.equal(od.OD_RESIDUALS, null);

// ── 2. gp-error-model reads the frame from TRAJ_REF_FRAME ──
const stream = encodeOmm(leoH);
const states = await deriveStates(stream, [0]);
const realism = [{ sources: ['ilrs-crd'], class: 'slr-ffm-fit', factor: 17.04, meanD2Over3: 17.04, coverage95: 0.17, samples: 1000, objects: 5, evidence: 'E2E', window: '2026-05-01..2026-09-30' }];
const recipe = recipeFor({ id: 'ilrs-crd', kind: 'observation', lineage: 'ilrs-slr', own: false, fitClass: 'slr-ffm-fit', extra: { realism } });
const attach = (fitBytes) => call('attach_covariance', [ommFrame('elements', stream), oemFrame('states', states), json('recipe', recipe), ocmFrame('fit', fitBytes)]);
const lower = Array.from({ length: 21 }, (_, i) => (i === 0 || i === 2 || i === 5 ? 2e-4 : i === 9 || i === 14 || i === 20 ? 2e-10 : (i + 1) * 2e-9));
const x = [4000.5, 5000.25, 3000.125, -3.5, 4.25, 4.75];

const own = await attach(Buffer.from(bytes));
assert.equal(own.statusCode, 0, `the module's own $OCM: ${own.errorCode} ${own.errorMessage}`);
const typed = await attach(fitOcm({ norad: leoH.norad, name: leoH.name, epoch: leoH.epoch, x, lower }));
assert.equal(typed.statusCode, 0, typed.errorMessage);
assert.equal(reportOf(typed).counts.rule2, 1, 'rule 2 applies to the fit whose frame is TRAJ_REF_FRAME');
const untyped = fitOcm({ norad: leoH.norad, name: leoH.name, epoch: leoH.epoch, x, lower, frame: false });
const legacy = (() => {   // the same record with the retired frame parameter beside it
  const t = OCM.OCM.getSizePrefixedRootAsOCM(new flatbuffers.ByteBuffer(new Uint8Array(untyped))).unpack();
  t.USER_DEFINED_PARAMETERS = [Object.assign(new OCM.UserDefinedParametersT(), { PARAM_NAME: 'STATE_REFERENCE_FRAME', PARAM_VALUE: 'TEME' })];
  const b = new flatbuffers.Builder(1024);
  OCM.OCM.finishSizePrefixedOCMBuffer(b, t.pack(b));
  return Buffer.from(b.asUint8Array());
})();
for (const [what, record] of [['no frame', untyped], ['the retired STATE_REFERENCE_FRAME only', legacy]]) {
  const refused = await attach(record);
  assert.equal(refused.errorCode, 'frame-missing', `${what}: ${refused.errorCode} ${refused.errorMessage}`);
}

// ── 3. the guard rejects every retired key ──
const named = { PROVENANCE: expectedProvenance(recipe), USER_DEFINED_PARAMETERS: [], TAGS: [] };
assertSourceNamed(named, recipe);
const retired = ['SDNAP_FIT_RMS_KM', 'FIT_RMS_KM', 'HELD_OUT_RMS_KM', 'SDN_SOURCE_NAME', 'AOE_RECORD_ID', 'GP_ID', 'VCM_COORD_SYS', 'COVARIANCE_SCALE',
  'STATE_REFERENCE_FRAME', 'STATE_UNITS', 'COVARIANCE_LAYOUT', 'COVARIANCE_INTERPRETATION', 'PERT_THEORY'];
for (const key of retired) {
  assert.throws(() => assertSourceNamed({ ...named, USER_DEFINED_PARAMETERS: [{ PARAM_NAME: key, PARAM_VALUE: 'x' }] }, recipe), undefined, key);
}

console.log(`OCM TYPED: TRAJ_REF_FRAME and COV_REF_FRAME TEMEOFDATE, COV_ORDERING LTM, COV_UNITS ${ocm.COV_UNITS.join(',')}, COV_PARAMETER_KINDS ${ocm.COV_PARAMETER_KINDS.length}; `
  + `FIT_RMS_KM ${fit.FIT_RMS_KM} (recorded WRMS ${recorded.obd.WRMS}), ITERATIONS ${fit.ITERATIONS} (recorded ${recorded.obd.NUM_ITERATIONS}), CONVERGED ${fit.CONVERGED}, `
  + `FIT_STATES ${fit.FIT_STATES}, FIT_START ${fit.FIT_START}, FIT_STOP ${fit.FIT_STOP}, ACTUAL_OD_SPAN ${od.ACTUAL_OD_SPAN} d (recorded FIT_SPAN ${recorded.obd.FIT_SPAN}); `
  + `no USER_DEFINED_PARAMETERS; gp-error-model rule 2 on TRAJ_REF_FRAME, frame-missing refused 2 of 2; guard rejects ${retired.length} of ${retired.length} retired keys`);
process.exit(0);

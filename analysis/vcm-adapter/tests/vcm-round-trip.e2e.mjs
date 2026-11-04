#!/usr/bin/env node
// E2E (modules-vcm-adapter-typed-fields-20261103): every VCM field rides in a typed $OCM field and comes back.
//
// The built module reads tests/fixtures/sample-vcm.txt into an $OCM and writes that $OCM back as VCM text:
// - the $OCM: TRAJ_REF_FRAME and COV_REF_FRAME EME2000 as CelestialFrame members, COV_UNITS, COV_REALISM[0]
//   SCALE_FACTOR (rule ScaledFit), COV_PARAMETER_KINDS and OD_DYNAMIC_PARAMETERS by prwDynamicParameter,
//   REDUCTION_THEORY IAU 1980 with REDUCTION_THEORY_TERMS, the geopotential's caps, HEADER.MESSAGE_STATUS and every
//   integrator setting in INTEGRATOR, each equal to what the build before the change wrote into its free-form list
//   (tests/fixtures/vcm-round-trip.recorded.json); assertNoUserDefined;
// - the text: byte for byte the VCM the build before the change wrote (tests/fixtures/sample-vcm.rebuilt.txt), and
//   read again it gives the propagation input ($PRW request) the sample gives;
// - variants of the sample: a next leap second (NEXT_LEAP_EPOCH), an exercise (MESSAGE_STATUS EXERCISE and its name)
//   and a 10x10 covariance with radiation pressure and thrust on (all four parameter kinds) come back line for line.
//
//   cd analysis/vcm-adapter && node tests/vcm-round-trip.e2e.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as flatbuffers from 'flatbuffers';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';
import * as sdsOcm from 'spacedatastandards.org/lib/js/OCM/main.js';
import { assertNoUserDefined } from '../../../common/tests/no-user-defined.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const recorded = JSON.parse(fs.readFileSync(here('fixtures/vcm-round-trip.recorded.json'), 'utf8'));
const SAMPLE = fs.readFileSync(here('fixtures/sample-vcm.txt'));
const REBUILT = fs.readFileSync(here('fixtures/sample-vcm.rebuilt.txt'), 'utf8');
const STANDARDS_ROOT = path.dirname(createRequire(import.meta.url).resolve('spacedatastandards.org/package.json'));
const { FIL } = await (async () => {
  const esbuild = createRequire(path.join(STANDARDS_ROOT, 'package.json'))('esbuild');
  const built = await esbuild.build({ stdin: { contents: 'export * from "./lib/ts/FIL/main.ts";', resolveDir: STANDARDS_ROOT, loader: 'ts' }, bundle: true, format: 'esm', platform: 'node', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
})();
const ref = (code) => ({ schemaName: `${code}.fbs`, fileIdentifier: `$${code}`, rootTypeName: code, wireFormat: 'flatbuffer' });
const filOf = (bytes) => { const b = new flatbuffers.Builder(1024); const c = FIL.createContentVector(b, new Uint8Array(bytes)); FIL.startFIL(b); FIL.addContent(b, c); FIL.finishFILBuffer(b, FIL.endFIL(b)); return b.asUint8Array(); };
const textOf = (bytes) => Buffer.from(FIL.getRootAsFIL(new flatbuffers.ByteBuffer(new Uint8Array(bytes))).contentArray()).toString();
const out = (r, port) => r.outputs.find((o) => o.portId === port).payload;
const ok = (r) => { assert.equal(r.statusCode, 0, `${r.errorCode}: ${r.errorMessage}`); return r; };
const h = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(here('../dist/isomorphic/module.wasm')), manifest: JSON.parse(fs.readFileSync(here('../plugin-manifest.json'), 'utf8')), surface: 'direct', hostOptions: { config: { read: {} } } });
const read = async (text) => ok(await h.invoke({ methodId: 'read', inputs: [{ portId: 'message', typeRef: ref('FIL'), payload: filOf(text) }] }));
const write = async (r) => textOf(out(ok(await h.invoke({ methodId: 'write', inputs: [{ portId: 'ocm', typeRef: ref('OCM'), payload: out(r, 'ocm') }, { portId: 'eop', typeRef: ref('EOP'), payload: out(r, 'eop') }] })), 'message'));
const decode = (bytes) => sdsOcm.OCM.getSizePrefixedRootAsOCM(new flatbuffers.ByteBuffer(new Uint8Array(bytes))).unpack();
const frameOf = (rfm) => { assert.equal(rfm.REFERENCE_FRAME_type, sdsOcm.RFMUnion.CelestialFrameWrapper); return sdsOcm.CelestialFrame[rfm.REFERENCE_FRAME.frame]; };
const kinds = (list) => list.map((k) => sdsOcm.prwDynamicParameter[k]);
const lines = (text) => text.split('\n');
const lineOf = (text, label) => lines(text).find((l) => l.startsWith(`<> ${label}`));

// ── the sample ──
const first = await read(SAMPLE);
const ocmBytes = out(first, 'ocm');
assertNoUserDefined(ocmBytes);
const o = decode(ocmBytes), was = recorded.USER_DEFINED_PARAMETERS;
assert.deepEqual(o.USER_DEFINED_PARAMETERS, []);
assert.equal(frameOf(o.TRAJ_REF_FRAME), recorded.TRAJ_REF_FRAME);
assert.equal(frameOf(o.COV_REF_FRAME), recorded.COV_REF_FRAME);
assert.equal(o.COV_SIZE, recorded.COV_SIZE);
assert.deepEqual(o.COV_UNITS, recorded.COV_UNITS);
assert.deepEqual(kinds(o.COV_PARAMETER_KINDS), recorded.COV_PARAMETERS, 'COV_PARAMETER_KINDS as far as the 7x7 matrix reaches');
assert.deepEqual(o.COV_PARAMETERS, recorded.COV_PARAMETERS);
assert.equal(o.COV_REALISM.length, 1);
assert.equal(o.COV_REALISM[0].RULE, sdsOcm.covarianceRule.ScaledFit);
assert.equal(o.COV_REALISM[0].SCALE_FACTOR, Number(was.COVARIANCE_SCALE));
assert.deepEqual(o.ORBIT_DETERMINATION.OD_DYNAMIC_PARAMETERS.map((p) => [sdsOcm.prwDynamicParameter[p.PARAMETER], p.NAME, p.VALUE, p.SOLVED_FOR]),
  recorded.OD_DYNAMIC_PARAMETERS.map((p) => [p.NAME, p.NAME, p.VALUE, p.SOLVED_FOR]));
assert.equal(o.HEADER.MESSAGE_STATUS, sdsOcm.ocmMessageStatus.UNSPECIFIED, `the sample states no indicator (${JSON.stringify(was.VCM_INDICATOR)})`);
assert.equal(o.METADATA.NEXT_LEAP_EPOCH, null, `the sample's leap time is SP's "unknown" (${was.VCM_LEAP_SECOND_TIME})`);
assert.equal(o.PERTURBATIONS.REDUCTION_THEORY, 'IAU 1980');
assert.equal(o.PERTURBATIONS.REDUCTION_THEORY_TERMS, Number(was.VCM_NUTATION_TERMS));
assert.equal(o.PERTURBATIONS.GRAVITY_MODEL, recorded.PERTURBATIONS.GRAVITY_MODEL);
assert.equal(`${o.PERTURBATIONS.GRAVITY_MODEL} ${o.PERTURBATIONS.MAXIMUM_ZONAL_DEGREE}Z,${o.PERTURBATIONS.MAXIMUM_TESSERAL_DEGREE}T`, recorded.PERTURBATIONS.GEOPOTENTIAL_MODEL);
assert.equal(o.PERTURBATIONS.GEOPOTENTIAL_MODEL, null);
assert.deepEqual([o.PERTURBATIONS.GRAVITY_DEGREE, o.PERTURBATIONS.GRAVITY_ORDER], [0, 0]);
const integrator = o.INTEGRATOR;
const settings = {
  VCM_INTEGRATOR_MODE: sdsOcm.ocmIntegratorMode[integrator.MODE],
  VCM_COORD_SYS: sdsOcm.ocmIntegrationFrame[integrator.COORDINATE_SYSTEM],
  VCM_PARTIALS: { FULL_NUMERICAL: 'FULL NUM', FAST_NUMERICAL: 'FAST NUM' }[sdsOcm.ocmPartialsMethod[integrator.PARTIALS]] ?? sdsOcm.ocmPartialsMethod[integrator.PARTIALS],
  VCM_STEP_MODE: sdsOcm.ocmStepMode[integrator.STEP_MODE],
  VCM_FIXED_STEP: integrator.FIXED_STEP ? 'ON' : 'OFF',
  VCM_STEP_SIZE_SELECTION: sdsOcm.ocmStepSelection[integrator.STEP_SIZE_SELECTION],
  VCM_INITIAL_STEP_SIZE_S: String(integrator.INITIAL_STEP_SECONDS),
  VCM_ERROR_CONTROL: String(integrator.ERROR_CONTROL),
};
for (const [key, value] of Object.entries(settings)) assert.equal(value, was[key], key);

const text = await write(first);
assert.equal(text, REBUILT, 'the VCM written from the typed $OCM equals the one written before, byte for byte');
const again = await read(Buffer.from(text));
assert.deepEqual(Buffer.from(out(again, 'request')), Buffer.from(out(first, 'request')), 'read again, the same propagation input');
assert.deepEqual(Buffer.from(out(again, 'ocm')), Buffer.from(ocmBytes), 'and the same $OCM');

// ── variants ──
const variant = (edit) => Buffer.from(edit(SAMPLE.toString()));
const leap = variant((t) => t.replace('2049 365 (31 DEC) 23:59:59.999', '2023 181 (30 JUN) 23:59:59.999'));
const leapRead = await read(leap);
assert.equal(decode(out(leapRead, 'ocm')).METADATA.NEXT_LEAP_EPOCH, '2023-06-30T23:59:59.999000');
assert.equal(lineOf(await write(leapRead), 'TIME CONST LEAP'), lineOf(leap.toString(), 'TIME CONST LEAP'));
const exercise = variant((t) => t.replace('<> SP VECTOR/COVARIANCE MESSAGE - V2.0\n<>\n', '<> SP VECTOR/COVARIANCE MESSAGE - V2.0\n<> EXERCISE//GLOBAL SENTINEL//EXERCISE\n'));
const exerciseRead = await read(exercise);
const ex = decode(out(exerciseRead, 'ocm')).HEADER;
assert.deepEqual([ex.MESSAGE_STATUS, ex.EXERCISE_NAME], [sdsOcm.ocmMessageStatus.EXERCISE, 'GLOBAL SENTINEL']);
assert.equal(lines(await write(exerciseRead))[1], '<> EXERCISE//GLOBAL SENTINEL//EXERCISE');
// 10x10: the sample's 7x7 and three independent rows (BDOT, AGOM, T), radiation pressure and thrust on.
const fortranE = (x, digits = 5) => {
  if (x === 0) return `0.${'0'.repeat(digits)}E+00`;
  let e = Math.floor(Math.log10(Math.abs(x))) + 1, m = Math.round((Math.abs(x) / 10 ** e) * 10 ** digits);
  if (m >= 10 ** digits) { m = 10 ** (digits - 1); ++e; }
  return `${x < 0 ? '-' : ''}0.${String(m).padStart(digits, '0')}E${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`;
};
const wide = variant((t) => {
  const all = lines(t), at = all.findIndex((l) => l.includes('COVARIANCE MATRIX'));
  const base = all.slice(at + 1).join(' ').replace(/<>/g, ' ').trim().split(/\s+/).filter(Boolean);
  const values = [...base];
  for (const [row, variance] of [[7, 1e-18], [8, 2e-3], [9, 1e-18]]) values.push(...Array(row).fill(fortranE(0)), fortranE(variance));
  const rows = [];
  for (let k = 0; k < values.length; k += 5) rows.push(`<> ${values.slice(k, k + 5).map((v) => v.padStart(12)).join(' ')}`);
  return [...all.slice(0, at), all[at].replace('( 7x 7)', '(10x10)'), ...rows, ''].join('\n')
    .replace('SOLAR RAD PRESS: OFF', 'SOLAR RAD PRESS:  ON').replace('IN-TRACK THRUST: OFF', 'IN-TRACK THRUST:  ON')
    .replace('SOLAR RAD PRESS COEFF (M2/KG):  0.000000E+00', 'SOLAR RAD PRESS COEFF (M2/KG):  0.211000E-01')
    .replace('THRUST ACCEL (M/S2):  0.000000E+00', 'THRUST ACCEL (M/S2):  0.310000E-08')
    .replace('BDOT (M2/KG-S): 0.000000E+00', 'BDOT (M2/KG-S): 0.240000E-09');
});
const wideRead = await read(wide), w = decode(out(wideRead, 'ocm'));
const allKinds = ['DRAG_AREA_OVER_MASS', 'DRAG_AREA_OVER_MASS_RATE', 'SRP_AREA_OVER_MASS', 'IN_TRACK_ACCELERATION'];
assert.equal(w.COV_SIZE, 10);
assert.deepEqual(kinds(w.COV_PARAMETER_KINDS), allKinds);
assert.deepEqual(w.ORBIT_DETERMINATION.OD_DYNAMIC_PARAMETERS.map((p) => sdsOcm.prwDynamicParameter[p.PARAMETER]), allKinds);
assert.deepEqual(w.COV_UNITS.slice(6), ['m**2/kg', 'm**2/kg/s', 'm**2/kg', 'm/s**2']);
const wideText = await write(wideRead);
for (const label of ['COVARIANCE MATRIX', 'SOLAR RAD PRESS:', 'SOLAR RAD PRESS COEFF', 'THRUST ACCEL', 'BALLISTIC COEF']) assert.equal(lineOf(wideText, label), lineOf(wide.toString(), label), label);
h.destroy();

console.log(`VCM ROUND TRIP: TRAJ_REF_FRAME and COV_REF_FRAME ${frameOf(o.TRAJ_REF_FRAME)}, COV_REALISM[0].SCALE_FACTOR ${o.COV_REALISM[0].SCALE_FACTOR} (recorded ${was.COVARIANCE_SCALE}), `
  + `COV_UNITS ${o.COV_UNITS.join(',')}, COV_PARAMETER_KINDS ${kinds(o.COV_PARAMETER_KINDS).join(',')} (10x10: ${kinds(w.COV_PARAMETER_KINDS).join(',')}), `
  + `REDUCTION_THEORY ${o.PERTURBATIONS.REDUCTION_THEORY} ${o.PERTURBATIONS.REDUCTION_THEORY_TERMS} terms, EGM-96 caps ${o.PERTURBATIONS.MAXIMUM_ZONAL_DEGREE}Z/${o.PERTURBATIONS.MAXIMUM_TESSERAL_DEGREE}T, `
  + `INTEGRATOR ${Object.values(settings).join('/')} = recorded, NEXT_LEAP_EPOCH 2023-06-30T23:59:59.999000, MESSAGE_STATUS EXERCISE; `
  + `rebuilt VCM ${text.length} bytes byte-equal to the recorded text; request and $OCM identical on re-read; no USER_DEFINED_PARAMETERS`);
process.exit(0);

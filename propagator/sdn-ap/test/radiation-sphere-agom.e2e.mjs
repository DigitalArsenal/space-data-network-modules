#!/usr/bin/env node
// E2E (stack #481, SPEC 12.1): a 72 h fit's AGOM lands on the truth's, inside its stated sigma. The case: an 800 km sphere (14.2165 rev/day, e 0.0012, i 98.6, RAAN 326.70), AGOM 0.01 m^2/kg, in the truth's conical shadow
// from 2026-01-26. Through 0.6.20 the fit weighed the data at 1 km under the drag. AGOM's default prior (0 +- 0.05) then
// acted as if it were 100 times narrower and held AGOM at 0.356 of the truth, 9.9 of its stated sigmas away. At 71 h and up
// the fit now weighs the data at their own sigma, as above the drag (#489).
// Truth: FFM (named below by its SHA-256), EGM96 70 x 70, DE440 Sun and Moon, a sphere's radiation pressure (Cr 1, 10 m^2,
// 1,000 kg) in FFM's conical shadow, no drag, no tides, zero EOP, RK78 1e-12, 300 s states, from the GCRF state below. AP: FORCES 31, 20, Jacchia 1970 and no space weather; BTERM held at 0 (FIT.DRAG_PRIOR
// GAUSSIAN_SIGNED 0 +- 1e-9); AGOM on its default prior; the first 72 h.
// Asserted: AGOM within 10 % of 0.01, and within 2 of its stated sigmas. Measured 2026-11-11: 0.937 of the truth at 0.98
// sigma (0.6.20: 0.356 at 9.9).
//   node test/radiation-sphere-agom.e2e.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import * as fb from 'flatbuffers';
import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {OEMT} from 'spacedatastandards.org/lib/js/OEM/OEM.js';
import {CATT} from 'spacedatastandards.org/lib/js/OEM/CAT.js';
import {ephemerisDataBlockT as Block} from 'spacedatastandards.org/lib/js/OEM/ephemerisDataBlock.js';
import {ephemerisDataLineT as Line} from 'spacedatastandards.org/lib/js/OEM/ephemerisDataLine.js';
import {timingStandard} from 'spacedatastandards.org/lib/js/OEM/timingStandard.js';
import {pcfAtmosphereFamily} from 'spacedatastandards.org/lib/js/PCF/pcfAtmosphereFamily.js';
import {prwDynamicParameter} from 'spacedatastandards.org/lib/js/OCM/prwDynamicParameter.js';
import {requestFor,decodeResult,encodePrw,makeTable,TYPE} from '../../ffm/tests/lib/prwCodec.mjs';
import {requireTruth,ffmPath,checkTruth} from './lib/ffm-truth.mjs';
import {wasmPath} from './lib/module.mjs';
import {packOem,rfm,jdOf} from './lib/frames.mjs';
import {configuration,prior,pcfPriorForm} from './lib/pcf.mjs';
import {ocmOf,T} from './lib/ocm.mjs';
import {sharedRoot,writeWhole} from './lib/scratch.mjs';
const FFM_SHA256 = 'ea4576901f9e8dc21af2c24feb7887645706ef934488cb9756a0b5c21ab47934';
requireTruth(FFM_SHA256);
const TRUE_AGOM = 0.01, RATIO = 0.10, Z = 2;
const epoch = '2026-01-26T00:00:00.000', t0 = Date.parse(`${epoch}Z`), DAY = 86400000, STEP = 300000, N = 72 * 12 + 1;
const initial = [-577.9126078215809, -895.8278915605553, 7112.576242695629, -6.197080891170577, 4.12242273663322, 0.015870246801972566];
const iso = (ms) => new Date(ms).toISOString().replace('Z', '');
const jd = jdOf(epoch), times = [...Array(N)].map((_, k) => k * STEP / DAY);
const params = {epochJD: jd.whole, epochTimeScale: 'UTC', targetJD: jd.whole + times.at(-1), targetTimeScale: 'UTC', position: initial.slice(0, 3), velocity: initial.slice(3), frame: 'GCRF',
  sampleEpochsJD: times.map((d) => ({jd: jd.whole + d, scale: 'UTC'})), ephemerisSource: 'JPL_SPK',
  forces: {gravityMode: 'EGM96', maxDegree: 70, maxOrder: 70, thirdBody: true, srp: true, drag: false, massKg: 1000, areaM2: 10, cr: TRUE_AGOM * 1000 / 10},
  integrator: {tolerance: 1e-12, minStep: 0.01, maxStep: 300}};
const kernel = fs.readFileSync(new URL('../../../files/orbit-products/tests/fixtures/de440/de440-2026.bsp', import.meta.url));
checkTruth();
const req = requestFor('propagate', params, kernel);
req.inputs.push({portId: 'earth_orientation', typeRef: TYPE, payload: encodePrw('EARTH_ORIENTATION', makeTable('PRWEarthOrientation', {ROWS: Array.from({length: 8}, (_, k) => makeTable('EOP', {DATE: `${iso(t0 + (k - 1) * DAY)}Z`, MJD: jd.whole - 2400000.5 + k - 1, TAI_MINUS_UTC_SECONDS: 37}))}))});
// the truth's cache: the SHA-256 of FFM's build and every byte of the request (scratch.mjs's shared root)
const hash = createHash('sha256').update(fs.readFileSync(ffmPath));
for (const i of req.inputs) hash.update(i.portId).update(Buffer.from(i.payload));
const file = path.join(sharedRoot, 'radiation-truth', `${hash.digest('hex')}.json`);
let samples;
if (fs.existsSync(file)) samples = JSON.parse(fs.readFileSync(file, 'utf8'));
else {
  const fh = await createStandaloneHarness('browser', ffmPath, {surface: 'command'});
  const r = await fh.invoke(req);
  assert.equal(r.statusCode, 0, `${r.errorCode}: ${r.errorMessage}`);
  samples = decodeResult(r).samples.map((s) => ({position: s.position, velocity: s.velocity}));
  assert.equal(samples.length, N);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  writeWhole(file, JSON.stringify(samples));
  await fh.close?.();
}
assert.ok(Math.hypot(...samples[0].position.map((v, k) => v - initial[k])) < 1e-9, 'FFM starts from case 7\'s state');
const lines = samples.map((s, k) => Object.assign(new Line(), {EPOCH: iso(t0 + k * STEP), X: s.position[0], Y: s.position[1], Z: s.position[2], X_DOT: s.velocity[0], Y_DOT: s.velocity[1], Z_DOT: s.velocity[2]}));
const block = Object.assign(new Block(), {OBJECT: Object.assign(new CATT(), {NORAD_CAT_ID: 99107, OBJECT_NAME: 'CASE 7 SPHERE'}), CENTER_NAME: 'EARTH', REFERENCE_FRAME: rfm('GCRF'), TIME_SYSTEM: timingStandard.UTC,
  START_TIME: lines[0].EPOCH, STOP_TIME: lines.at(-1).EPOCH, USEABLE_START_TIME: lines[0].EPOCH, USEABLE_STOP_TIME: lines.at(-1).EPOCH, EPHEMERIS_DATA_LINES: lines});
const oem = packOem(Object.assign(new OEMT(), {EPHEMERIS_DATA_BLOCK: [block]}));
const h = await createStandaloneHarness('browser', wasmPath, {surface: 'command'});
const forces = {EPHEMERIS_SOURCE: '', HAS_MAXIMUM_TESSERAL_DEGREE: true, MAXIMUM_TESSERAL_DEGREE: 31, HAS_MAXIMUM_DEGREE: true, MAXIMUM_DEGREE: 20, ATMOSPHERE_MODEL: pcfAtmosphereFamily.JACCHIA70};
const r = await h.invoke({methodId: 'fit', inputs: [configuration({forces, fit: {DRAG_PRIOR: prior(0, 1e-9), DRAG_PRIOR_FORM: pcfPriorForm.GAUSSIAN_SIGNED}}), {portId: 'ephemeris', typeRef: T('OEM'), payload: oem}]});
assert.equal(r.statusCode, 0, `${r.errorCode}: ${r.errorMessage}`);
const o = ocmOf(new Uint8Array(r.outputs.find((v) => v.portId === 'elements').payload));
const kinds = o.COV_PARAMETER_KINDS ?? [], at = 6 + kinds.indexOf(prwDynamicParameter.SRP_AREA_OVER_MASS);
assert.ok(at >= 6, 'the record carries AGOM\'s row');
const agom = o.MEAN_ELEMENTS.AGOM, sigma = Math.sqrt(o.COVARIANCE_DATA[(at * (at + 1)) / 2 + at]), z = (agom - TRUE_AGOM) / sigma;
await h.close?.();
console.log(JSON.stringify({agom, ratio: agom / TRUE_AGOM, sigma, z, weighting: o.ORBIT_DETERMINATION?.OD_DATA_WEIGHTING, bounds: {ratio: RATIO, z: Z}}));
const failures = [];
if (!(Math.abs(agom / TRUE_AGOM - 1) <= RATIO)) failures.push(`AGOM ${agom.toPrecision(4)} is ${(agom / TRUE_AGOM).toFixed(3)} of the truth's ${TRUE_AGOM}, outside ${RATIO * 100} % (#481)`);
if (!(Math.abs(z) <= Z)) failures.push(`AGOM lies ${z.toFixed(2)} of its stated sigma ${sigma.toPrecision(3)} from the truth, beyond ${Z} (#481, #489)`);
if (failures.length) {
  console.error(`FAIL\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('radiation sphere AGOM E2E: PASS');
process.exit(0);

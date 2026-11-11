#!/usr/bin/env node
// The Sun and Moon of the long-period regime through the output (SPEC 16.19), on model truth: e 0.9, perigee 5,000 km,
// apogee 210,000 km, i 70 (the synthetic set's grid-hp5000-e0.9-i70 elements, seeded at perigee on
// test/lib/heo-model-truth.mjs's epoch). The truth: FFM (named below by its SHA-256) with the zonal field to degree 5 alone
// and DE440's Sun and Moon, no radiation or drag, 30-minute states over 5 days. AP takes no tesseral term and no zonal tail
// (J2 to J5 are its own), with drag and radiation held at 0. It is fitted to those 5 days and flown at their epochs. D, the
// largest 3D distance to the truth, is what the theory cannot represent over 5 days, with no tesseral field on either side.
// Through 0.6.26 the long-period regime's Gauss equations moved the J2-mean elements as if they were osculating, and the
// output's J2 short-period map then added its Jacobian times the bodies' rates, a velocity error from the start.
// SDN_AP_MODEL_TRUTH_MODULE=<module.wasm> flies another build and checks nothing past the flight.
//   node test/long-period-moon-output.e2e.mjs
import assert from 'node:assert/strict';
import * as fb from 'flatbuffers';
import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {OEM} from 'spacedatastandards.org/lib/js/OEM/OEM.js';
import {pcfOutputFrame} from 'spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js';
import {requireTruth} from './lib/ffm-truth.mjs';
import {runModelTruth} from './lib/heo-model-truth.mjs';
import {wasmPath} from './lib/module.mjs';
import {flight} from './lib/ocm.mjs';
requireTruth('ea4576901f9e8dc21af2c24feb7887645706ef934488cb9756a0b5c21ab47934'); // FFM 2.3.0 (modules 48a00fd6)
const modulePath = process.env.SDN_AP_MODEL_TRUTH_MODULE ?? wasmPath;
const input = await runModelTruth({name: 'e0.9-perigee-5000-zonal', n: 0.2262017831, e: 0.9, i: 70, raan: 279.5, argp: 296.6, ma: 228.7, drag: false,
  field: [5, 0], forces: [0, 5], fitDays: 5, fitInput: true, modulePath});
const h = await createStandaloneHarness('browser', modulePath, {surface: 'command'});
const call = async (methodId, inputs) => { const r = await h.invoke({methodId, inputs}); assert.equal(r.statusCode, 0, `${methodId}: ${r.errorCode}: ${r.errorMessage}`); return r.outputs; };
const lines = OEM.getRootAsOEM(new fb.ByteBuffer(input.ephemeris.payload)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES;
const set = new Uint8Array((await call('fit', [input.configuration, input.spaceWeather, input.ephemeris])).find((v) => v.portId === 'elements').payload);
const out = await call('propagate', flight([set], {output: {EPOCHS: lines.map((L) => L.EPOCH), FRAME: pcfOutputFrame.GCRF}}));
const flown = OEM.getRootAsOEM(new fb.ByteBuffer(out.find((v) => v.portId === 'ephemeris').payload)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES;
assert.equal(flown.length, lines.length);
const d = flown.map((f, k) => 1000 * Math.hypot(f.X - lines[k].X, f.Y - lines[k].Y, f.Z - lines[k].Z));
const D = Math.max(...d), atH = (d.indexOf(D) * 30) / 60;
console.log(JSON.stringify({name: 'e0.9-perigee-5000-zonal', states: lines.length, D_m: +D.toFixed(1), atH}));
await h.close?.();
// The recorded figure, within 1 m either way. History (this truth): 0.6.26 343.8 m at 120 h; 0.6.NN 255.8 m at 120 h, the
// bodies' rates through the output (SPEC 16.19).
const RECORDED = 255.8;
if (!process.env.SDN_AP_MODEL_TRUTH_MODULE)
  assert.ok(Math.abs(D - RECORDED) <= 1, `D over the 5 days ${D.toFixed(1)} m, recorded ${RECORDED} m (0.6.26: 343.8 m)`);
console.log('Long-period Moon through the output E2E: PASS');
process.exit(0);

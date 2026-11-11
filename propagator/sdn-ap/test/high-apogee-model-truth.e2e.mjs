#!/usr/bin/env node
// A high-apogee orbit on model truth (SPEC 16.11): e 0.9, perigee 5,000 km, apogee 210,000 km, i 70 (the synthetic set's
// grid-hp5000-e0.9-i70 elements, seeded at perigee on test/lib/heo-model-truth.mjs's epoch). The truth: FFM (named below by
// its SHA-256) with EGM96 70 x 70 and DE440's Sun and Moon, no radiation or drag, 30-minute states over 5 days. AP (degree
// 31, zonal 20, drag and radiation held at 0) fitted to those 5 days, then flown at their epochs. D, the largest 3D distance
// to the truth, is what the theory cannot represent over 5 days: no fit before a cutoff adds to it.
// In the long-period regime the Sun and Moon act on the mean elements as point masses and move the mean motion along each
// revolution. Through 0.6.26 the tesseral grid followed that oscillation: each node was built at its instant's mean motion,
// and each state was offset in a from its own. That moved near-resonant families' divisors as much as their distance from
// resonance.
// SDN_AP_MODEL_TRUTH_MODULE=<module.wasm> flies another build and checks nothing past the flight.
//   node test/high-apogee-model-truth.e2e.mjs
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
const input = await runModelTruth({name: 'e0.9-perigee-5000', n: 0.2262017831, e: 0.9, i: 70, raan: 279.5, argp: 296.6, ma: 228.7, drag: false,
  fitDays: 5, fitInput: true, modulePath});
const h = await createStandaloneHarness('browser', modulePath, {surface: 'command'});
const call = async (methodId, inputs) => { const r = await h.invoke({methodId, inputs}); assert.equal(r.statusCode, 0, `${methodId}: ${r.errorCode}: ${r.errorMessage}`); return r.outputs; };
const lines = OEM.getRootAsOEM(new fb.ByteBuffer(input.ephemeris.payload)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES;
const set = new Uint8Array((await call('fit', [input.configuration, input.spaceWeather, input.ephemeris])).find((v) => v.portId === 'elements').payload);
const out = await call('propagate', flight([set], {output: {EPOCHS: lines.map((L) => L.EPOCH), FRAME: pcfOutputFrame.GCRF}}));
const flown = OEM.getRootAsOEM(new fb.ByteBuffer(out.find((v) => v.portId === 'ephemeris').payload)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES;
assert.equal(flown.length, lines.length);
const d = flown.map((f, k) => 1000 * Math.hypot(f.X - lines[k].X, f.Y - lines[k].Y, f.Z - lines[k].Z));
const D = Math.max(...d), atH = (d.indexOf(D) * 30) / 60;
console.log(JSON.stringify({name: 'e0.9-perigee-5000', states: lines.length, D_m: +D.toFixed(1), atH}));
await h.close?.();
// The recorded figure, within 1 m either way. History (this truth): 0.6.26 1,422.0 m at 84.5 h; 0.6.26 with the grid's mean
// motion held at the epoch's alone 689.4 m at 86 h; 0.6.29 (the Sun and Moon through the output, SPEC 16.19) 1,427.4 m;
// 0.6.30, the grid's mean motion held in the long-period regime (SPEC 16.11) on 0.6.29, 618.6 m at 83.5 h; 0.6.NN, the
// epoch-axis turn to TEME of date for every AP set (SPEC 16.4), 599.4 m at 83.5 h.
const RECORDED = 599.4;
if (!process.env.SDN_AP_MODEL_TRUTH_MODULE)
  assert.ok(Math.abs(D - RECORDED) <= 1, `D over the 5 days ${D.toFixed(1)} m, recorded ${RECORDED} m (0.6.26: 1,422.0 m)`);
console.log('High-apogee model truth E2E: PASS');
process.exit(0);

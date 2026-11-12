#!/usr/bin/env node
// stack #595, SPEC 16.3: two synthetic seed-498 cases, fitted over the 120 h forecast to FFM's matching
// EGM2008 degree-70 order-0 field and solid tide; Sun, Moon and relativity in FFM, analytic Sun and Moon in AP.
// No drag or radiation. UTC and GCRF; 300 s states. The once-per-revolution in-track amplitude is a fit of
// 1, t, cos M, sin M within each day (M from the truth's osculating two-body elements).
// The 10 m term and 20 m maximum 3D error bounds distinguish the omitted harmonics from the remaining model error.
import assert from 'node:assert/strict';
import {requireTruth} from './lib/ffm-truth.mjs';
import {wasmPath} from './lib/module.mjs';
import {CASES,zonalTruth,fitZonalTruth} from './lib/zonal-long-period-truth.mjs';
requireTruth('ea4576901f9e8dc21af2c24feb7887645706ef934488cb9756a0b5c21ab47934');
for(const c of CASES){
 const truth=await zonalTruth(c),r=await fitZonalTruth(process.env.SDN_AP_MODEL_TRUTH_MODULE??wasmPath,truth);
 console.log(JSON.stringify({id:c.id,...r}));
 assert.ok(r.D<=20,`${c.id}: maximum 3D error ${r.D} m <= 20 m`);
 for(const d of [1,5])assert.ok(r.oncePerRev[d-1]<=10,`${c.id}: day ${d} term ${r.oncePerRev[d-1]} m <= 10 m`);
}
console.log('Zonal long-period same-field E2E: PASS');
process.exit(0);

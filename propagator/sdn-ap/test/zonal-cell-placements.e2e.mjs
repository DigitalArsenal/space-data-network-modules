#!/usr/bin/env node
// SPEC 16.3, stack #595. hp400/e0.05/i55 seed-498 geometry with seed eccentricity
// at a cell center and 1e-8 either side of its upper boundary. Each AP fit and FFM
// reference flies the same degree-70, order-0 field, tide, Sun and Moon for five days.
// GCRF meters, UTC; the unchanged 20 m 3D and 10 m once-per-revolution bounds test the model.
// The 0.1 m boundary bound compares AP-minus-FFM residual vectors, removing the physical
// separation between two distinct initial eccentricities. Omitting added harmonics fails the model bounds.
import assert from 'node:assert/strict';
import {requireTruth} from './lib/ffm-truth.mjs';
import {wasmPath} from './lib/module.mjs';
import {CASES,zonalTruth,fitZonalTruth} from './lib/zonal-long-period-truth.mjs';
requireTruth('ea4576901f9e8dc21af2c24feb7887645706ef934488cb9756a0b5c21ab47934');
const rows=[];
for(const [placement,e] of [['center',0.049],['below',0.05-1e-8],['above',0.05+1e-8]]) {
 const c={...CASES[0],e},truth=await zonalTruth(c),row=await fitZonalTruth(wasmPath,truth,{residuals:true});
 const {residuals,...summary}=row;rows.push(row);
 console.log(JSON.stringify({placement,seedE:e,...summary}));
 assert.ok(row.D<=20,`${placement}: maximum 3D error <=20 m`);
 for(const d of [1,5])assert.ok(row.oncePerRev[d-1]<=10,`${placement}: day ${d} once-per-revolution <=10 m`);
}
const boundaryM=Math.max(...rows[1].residuals.map((r,k)=>Math.hypot(...r.map((v,j)=>v-rows[2].residuals[k][j]))));
console.log(JSON.stringify({boundaryResidualDifferenceM:boundaryM,states:rows[1].residuals.length}));
assert.ok(boundaryM<=0.1,'boundary residual difference <=0.1 m over five days');
console.log('Zonal cell placements same-field E2E: PASS');
process.exit(0);

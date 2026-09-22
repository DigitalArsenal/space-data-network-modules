import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import { request,truth,policy,perturbed,reference,affine,oemStates,unpackOpm } from './epoch-fixture.mjs';
const wasm=fs.readFileSync(new URL('../dist/isomorphic/module.wasm',import.meta.url)),manifest=JSON.parse(fs.readFileSync(new URL('../plugin-manifest.json',import.meta.url)));
async function invoke(t,r){const h=await createBrowserModuleHarness({wasmSource:wasm,manifest,surface:'direct'});t.after(()=>h.destroy());return h.invoke(r);}
const report=out=>JSON.parse(new TextDecoder().decode(out.outputs.find(o=>o.portId==='report').payload));
const candidate=out=>out.outputs.find(o=>o.portId==='candidate').payload;
test('direct epoch seed validates against positions without fabricated velocities',async t=>{const out=await invoke(t,request('validate_epoch',truth,[oemStates(affine(truth))]));assert.equal(out.statusCode,0,out.errorMessage);const r=report(out);assert.equal(r.status,'validated');assert.equal(r.holdoutSamples,4);assert.equal(r.covarianceAvailable,false);});
test('fitting recovers independent affine epoch state then requires held-out validation',async t=>{
 const seed=truth.map((x,j)=>x+([5,-3,2,.0005,-.0003,.0002][j]));const out=await invoke(t,request('fit_epoch_step',seed,perturbed(seed)));assert.equal(out.statusCode,0,out.errorMessage);assert.equal(report(out).status,'candidate-needs-propagation');
 const fitted=unpackOpm(candidate(out));fitted.forEach((x,j)=>assert.ok(Math.abs(x-truth[j])<(j<3?1e-5:1e-8),`${j}: ${x-truth[j]}`));
 const check=await invoke(t,request('validate_epoch',fitted,[oemStates(affine(fitted))]));assert.equal(check.statusCode,0,check.errorMessage);assert.equal(report(check).status,'validated');
});
test('withheld outlier cannot train the fit and prevents acceptance',async t=>{
 const seed=truth.map((x,j)=>x+(j===0?5:0));const arcs=perturbed(seed);
 const a=await invoke(t,request('fit_epoch_step',seed,arcs));const b=await invoke(t,request('fit_epoch_step',seed,arcs,reference({heldoutError:100})));
 assert.equal(a.statusCode,0,a.errorMessage);assert.equal(b.statusCode,0,b.errorMessage);assert.deepEqual(candidate(a),candidate(b));
 const fitted=unpackOpm(candidate(b));const check=await invoke(t,request('validate_epoch',fitted,[oemStates(affine(fitted))],reference({heldoutError:100})));assert.equal(report(check).status,'requires-refinement');assert.ok(report(check).maximumHoldoutResidualKm>99);
});
test('wrong native identity, stale sensitivity seeds, absent model provenance and altered bytes fail',async t=>{
 const wrong=request('validate_epoch',truth,[oemStates(affine(truth))],reference({filename:'999_20260921_000000'}));
 const stale=perturbed(truth);stale[1]=stale[0];
 const corrupted=request('validate_epoch',truth,[oemStates(affine(truth))]);corrupted.inputs[2].payload=corrupted.inputs[2].payload.slice();corrupted.inputs[2].payload[corrupted.inputs[2].payload.length-1]^=1;
 for(const req of [wrong,request('fit_epoch_step',truth,stale),request('validate_epoch',truth,[oemStates(affine(truth))],reference(),{...policy,forceModel:{}}),corrupted])assert.notEqual((await invoke(t,req)).statusCode,0);
});

test('rank-deficient trajectory sensitivities cannot generate a fitted state',async t=>{
 const arcs=[oemStates(affine(truth))];
 for(let j=0;j<6;j++){const data=affine(truth);for(let i=0;i<data.length/6;i++)data[6*i+j]+=j<3?policy.positionPerturbationKm:policy.velocityPerturbationKmS;arcs.push(oemStates(data));}
 const out=await invoke(t,request('fit_epoch_step',truth,arcs));assert.notEqual(out.statusCode,0);assert.equal(out.outputs.length,0);
});

test('a fitted candidate that regresses held-out RMS is rejected even inside absolute tolerance',async t=>{
 const out=await invoke(t,request('validate_epoch',truth,[oemStates(affine(truth))],reference({heldoutError:.001}),{...policy,positionToleranceKm:1,maximumHoldoutRmsKm:0}));assert.equal(out.statusCode,0,out.errorMessage);assert.equal(report(out).status,'rejected-holdout-regression');
});

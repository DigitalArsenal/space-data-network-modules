import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createBrowserModuleHarness} from 'space-data-module-sdk/testing';
import {encodeGridRequest,decodeGridRecord} from '../grid-codec.js';
import {hohmann,antipodalMulti,earthMars,circular,metadata,mu} from './grid-fixtures.mjs';
async function run(t, options) {
  const harness=await createBrowserModuleHarness({wasmSource:fs.readFileSync(new URL('../dist/isomorphic/module.wasm',import.meta.url)),surface:'direct'});
  t.after(()=>harness.destroy());
  const response=await harness.invoke(encodeGridRequest(options));
  assert.equal(response.statusCode,0,`${response.errorCode}: ${response.errorMessage}`);
  return {response,rows:response.outputs.filter(f=>f.portId==='mesh').map(f=>decodeGridRecord(f.payload).values),
    best:decodeGridRecord(response.outputs.find(f=>f.portId==='best').payload).values};
}
function near(actual, expected, tolerance) {assert.ok(Math.abs(actual-expected)<=tolerance,`${actual} versus ${expected}, error ${Math.abs(actual-expected)} > ${tolerance}`);}
test('Vallado two-impulse Hohmann 300 km to GEO; SI, GCRF, TT; 0.02 m/s grid tolerance', async t=>{
  // Vallado, Fundamentals of Astrodynamics and Applications, Hohmann transfer
  // equations; CelesTrak companion software hohmann.m. Independent vis-viva
  // expectations; 60 s grid has a cell exactly at the aligned Hohmann time.
  const request=hohmann(), {best}=await run(t,request);
  const coarse=await run(t,hohmann(240));
  assert.ok(Math.abs(best.total_dv[0]-request.expected.total) < Math.abs(coarse.best.total_dv[0]-request.expected.total));
  t.diagnostic(`240 s coarse grid Hohmann error=${coarse.best.total_dv[0]-request.expected.total} m/s`);
  near(best.total_dv[0],request.expected.total,.02);
  near(best.departure_dv[0],request.expected.dv1,.02);
  near(best.arrival_dv[0],request.expected.dv2,.02);
  t.diagnostic(`Hohmann total=${best.total_dv[0]/1000} km/s error=${best.total_dv[0]-request.expected.total} m/s; expected=${request.expected.total/1000}`);
});
for(const branch of [1,2]) test(`Izzo Eq.18/19 antipodal M=1 branch ${branch}; SI GCRF TT; 1e-6 m/s`,async t=>{
  const request=antipodalMulti(branch),{best}=await run(t,request);
  assert.equal(best.revolutions[0],1); assert.equal(best.branch[0],branch);
  near(best.total_dv[0],0,1e-6);
  t.diagnostic(`Izzo M=1 branch=${branch}, x=${request.expected.x}, total residual=${best.total_dv[0]} m/s`);
});
test('JPL MRO 2005 launch window; ERFA analytics, heliocentric J2000 equatorial, TDB',async t=>{
  const request=earthMars(), {rows,best}=await run(t,request);
  let c3=Infinity, dep,arr;
  for(const row of rows) for(let j=0;j<row.status.length;j++) if(row.status[j]===0&&row.departure_c3[j]<c3) {
    c3=row.departure_c3[j];dep=row.departure_epoch[j];arr=row.arrival_epoch[j];
  }
  const date=t=>new Date(Date.UTC(2000,0,1,12)+t*1000).toISOString().slice(0,10);
  t.diagnostic(`C3 min=${c3/1e6} km^2/s^2 at ${date(dep)} / ${date(arr)}; total-dV best=${best.total_dv[0]/1000} km/s at ${date(best.departure_epoch[0])}/${date(best.arrival_epoch[0])}`);
  // JPL MRO Navigation, ISSFD 2007, Table 6: target C3=16 km²/s²;
  // actual launch 2005-08-12, arrival 2006-03-10. 1 km²/s² allows target
  // rounding, center-target vs B-plane, and analytic ephemeris (~2 m/s Mars).
  const d=(Date.UTC(2005,7,12)-Date.UTC(2000,0,1,12))/1000;
  const a=(Date.UTC(2006,2,10)-Date.UTC(2000,0,1,12))/1000;
  const row=rows.find(r=>r.departure_epoch[0]===d), j=row.arrival_epoch.indexOf(a);
  near(row.departure_c3[j]/1e6,16,1);
  t.diagnostic(`MRO published target C3 error=${row.departure_c3[j]/1e6-16} km^2/s^2`);
  // The brief's approximate early-August / March window is not an exact
  // ephemeris golden. Permit 15 departure and 30 arrival days around it.
  near(c3/1e6,16,.5);
  near(dep,(Date.UTC(2005,7,5)-Date.UTC(2000,0,1,12))/1000,15*86400);
  near(arr,(Date.UTC(2006,2,1)-Date.UTC(2000,0,1,12))/1000,30*86400);
});
test('400x400 mesh is complete and output stays below 24 MiB',async t=>{
  const epochs=Array.from({length:400},(_,i)=>i*60);
  const arrivalEpochs=epochs.map(t=>t+10000);
  const request={...metadata,departure:circular(7e6,epochs),arrival:circular(8e6,arrivalEpochs,.4),
    departureStart:0,departureEnd:23940,arrivalStart:10000,arrivalEnd:33940,step:60};
  const {response,rows,best}=await run(t,request);
  assert.equal(rows.length,400);assert.equal(rows.reduce((n,r)=>n+r.status.length,0),160000);
  const bytes=response.outputs.reduce((n,f)=>n+f.payload.length,0);assert.ok(bytes<24*1024**2);
  let min=Infinity;for(const r of rows)for(const dv of r.total_dv)min=Math.min(min,dv);
  assert.equal(best.total_dv[0],min);
  t.diagnostic(`400x400: ${bytes} output bytes; ${response.outputs.length} frames`);
});
// Independent circular motion: mu/r determines velocity; GCRF, TT, SI.
// 1e-6 m/s allows roundoff and is much smaller than maneuver tolerances.
test('direction flags select signed angular momentum and minimum over both directions',async t=>{
  const r=7e6, tof=Math.PI/2*Math.sqrt(r**3/mu), depart=circular(r,[0],0,-1), arrive=circular(r,[tof],0,-1);
  const request={...metadata,departure:depart,arrival:arrive,departureStart:0,departureEnd:0,arrivalStart:tof,arrivalEnd:tof,step:1,prograde:false,retrograde:true};
  const retro=await run(t,request);near(retro.best.total_dv[0],0,1e-6);assert.equal(retro.best.direction[0],-1);
  const both=await run(t,{...request,prograde:true});assert.equal(both.best.total_dv[0],retro.best.total_dv[0]);
  const pro=await run(t,{...request,prograde:true,retrograde:false});assert.equal(pro.best.direction[0],1);assert.ok(pro.best.total_dv[0]>1000);
});
test('nonpositive TOF and undefined plane remain explicit cells; no best uses indices -1',async t=>{
  const request={...metadata,departure:circular(7e6,[0,60]),arrival:circular(8e6,[0,60]),departureStart:0,departureEnd:60,arrivalStart:0,arrivalEnd:60,step:60};
  const {rows}=await run(t,request);assert.equal(rows[0].status[0],1);assert.equal(rows[1].status[0],1);
  const all=await run(t,{...request,arrivalStart:0,arrivalEnd:0});assert.equal(all.best.departure_index,-1);assert.equal(all.best.arrival_index,-1);assert.deepEqual(all.best.total_dv,[]);
});
for(const [name,change] of Object.entries({
  'zero step':r=>r.step=0, 'negative mu':r=>r.mu=-1,'fractional revolutions':r=>r.maxRevolutions=.5,
  'no direction':r=>{r.prograde=false;r.retrograde=false;},'UTC scale':r=>r.timeScale='UTC',
  'unsorted epochs':r=>r.departure.epochs.reverse(),'nonfinite state':r=>r.departure.positions[0][0]=NaN,
  'missing grid sample':r=>r.step=30,'oversize grid':r=>r.departureEnd=1e9,
  'excess revolutions':r=>r.maxRevolutions=33, 'zero radius':r=>r.departure.positions[0]=[0,0,0],
  'mismatched shape':r=>r.arrival.velocities.pop(),
  'duplicate epoch':r=>r.departure.epochs[1]=r.departure.epochs[0],
})) test(`refuses ${name} without output`,async t=>{
  const r=hohmann();change(r);
  const harness=await createBrowserModuleHarness({wasmSource:fs.readFileSync(new URL('../dist/isomorphic/module.wasm',import.meta.url)),surface:'direct'});t.after(()=>harness.destroy());
  const response=await harness.invoke(encodeGridRequest(r));assert.notEqual(response.statusCode,0);assert.equal(response.outputs.length,0);assert.equal(response.errorCode,'invalid-grid-request');
});


test('same-ray and polar geometries are unresolved cells', async t => {
  for (const position of [[8e6,0,0],[0,0,8e6]]) {
    const request={...metadata, departure:{epochs:[0],positions:[[7e6,0,0]],velocities:[[0,7500,0]]},
      arrival:{epochs:[1000],positions:[position],velocities:[[0,7000,0]]},
      departureStart:0,departureEnd:0,arrivalStart:1000,arrivalEnd:1000,step:1};
    const {rows,best}=await run(t,request);
    assert.equal(rows[0].status[0],2); assert.equal(best.departure_index,-1);
  }
});

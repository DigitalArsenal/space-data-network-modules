import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ByteBuffer } from 'flatbuffers';
import { OEM } from 'spacedatastandards.org/lib/js/OEM/OEM.js';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import { gridPolicy, propagateCommonGrid, normalizeVimpel, runMatching, DEFAULT_MODEL } from '../app/common-grid.js';
import { opm } from './epoch-fixture.mjs';
import { oem } from './matching-fixture.mjs';
const grid={start:'2026-09-21T00:00:00Z',stepSeconds:10,samples:13};
async function load(name,t) {
 const root=new URL('../../../'+name+'/',import.meta.url);
 const h=await createBrowserModuleHarness({wasmSource:fs.readFileSync(new URL('dist/isomorphic/module.wasm',root)),manifest:JSON.parse(fs.readFileSync(new URL('plugin-manifest.json',root))),surface:'direct'});
 t.after(()=>h.destroy());return h;
}
test('grid refuses impossible dates, oversized arcs, excessive samples and sub-millisecond intervals',()=>{
 for(const bad of [{start:'2026-02-30T00:00:00Z'},{samples:10001},{stepSeconds:1e-4},{stepSeconds:86400}])assert.throws(()=>gridPolicy({...grid,...bad}));
});
test('selected PRW implementation, time and frame WASM produce a closed-form circular common grid',async t=>{
 const runtimes={propagator:await load('propagator/hpop',t),frames:await load('foundation/frames',t),time:await load('foundation/time',t)};
 // Analytic two-body circle, r=7000 km, mu=398600.4418 km^3/s^2,
 // GCRF/UTC at the stated epoch. Absolute tolerance 1e-3 km and 1e-6 km/s
 // permits UTC/JD representation quantization and native integration error.
 const r=7000,mu=398600.4418,w=Math.sqrt(mu/r**3);
 const seed=opm([r,0,0,0,r*w,0],{frame:'GCRF'});
 const result=await propagateCommonGrid(seed,grid,runtimes,{...DEFAULT_MODEL,j2:false,j3:false,j4:false,thirdBody:false});
 const b=OEM.getSizePrefixedRootAsOEM(new ByteBuffer(result.payload)).EPHEMERIS_DATA_BLOCK(0);
 let maxPosition=0,maxVelocity=0;
 for(let i=0;i<grid.samples;i++) {
   // TIM supplies the UTC -> TDB interval (periodic relativistic term).
   // Over 120 s its departure from coordinate seconds is < 4e-8 s.
   const a=w*i*grid.stepSeconds,expected=[r*Math.cos(a),r*Math.sin(a),0,-r*w*Math.sin(a),r*w*Math.cos(a),0];
   for(let j=0;j<6;j++){const residual=Math.abs(b.EPHEMERIS_DATA(i*6+j)-expected[j]);if(j<3)maxPosition=Math.max(maxPosition,residual);else maxVelocity=Math.max(maxVelocity,residual);}
 }
 assert.ok(maxPosition<.001,`position ${maxPosition} km`);assert.ok(maxVelocity<.000001,`velocity ${maxVelocity} km/s`);
 t.diagnostic(JSON.stringify({maximumPositionComponentKm:maxPosition,maximumVelocityComponentKmS:maxVelocity}));
 const module=await load('analysis/catalog-composer',t);
 const candidates=[{id:'a',provider:'a',nativeId:'1',recordId:'fixture:a'},{id:'b',provider:'b',nativeId:'2',recordId:'fixture:b'}];
 const checked=await runMatching({module,candidates,pairs:[{left:'a',right:'b'}],policy:{positionToleranceKm:.01,velocityToleranceKmS:.0001,finiteDifferenceToleranceKmS:.0001,minimumSpanSeconds:120},prepare:async()=>result});
 t.diagnostic(JSON.stringify(checked.report.matches[0]));assert.equal(checked.report.matches[0].status,'compatible');assert.match(checked.recipe.candidates[0].trajectorySha256,/^[a-f0-9]{64}$/);
});
test('public-format Vimpel normalization selects native ID without inventing identity',async t=>{
 const m=await load('files/orbit-products',t);
 const row='1,010201,01012026,21092026 000000,0,7000,0,0,0,90,37,0.02,15,0.5,10\n';
 const bytes=await normalizeVimpel(new TextEncoder().encode(row),'0010201',m);
 assert.equal(String.fromCharCode(...bytes.subarray(8,12)),'$OPM');
 await assert.rejects(normalizeVimpel(new TextEncoder().encode(row),'999',m),/exactly one/);
});
test('preparation failures abort the batch before matching',async()=>{
 let invoked=false;
 await assert.rejects(runMatching({module:{invoke(){invoked=true;}},candidates:[{},{}],pairs:[{}],policy:{},prepare:async()=>({payload:oem().subarray(1)})}),/bounded/);
 assert.equal(invoked,false);
});

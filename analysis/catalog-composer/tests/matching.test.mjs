import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { Builder } from 'flatbuffers';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
const manifest=JSON.parse(fs.readFileSync(new URL('../plugin-manifest.json',import.meta.url)));
const wasm=fs.readFileSync(new URL('../dist/isomorphic/module.wasm',import.meta.url));
import { oem } from './matching-fixture.mjs';
const candidate=(id,provider=id)=>({id,provider,nativeId:id,recordId:`immutable-${id}`});
const config=()=>({version:1,candidates:[candidate('a'),candidate('b')],pairs:[{left:'a',right:'b',evidence:{source:'datefirst',recordId:'crosswalk-edition'}}],positionToleranceKm:1,velocityToleranceKmS:.01,finiteDifferenceToleranceKmS:1e-8,minimumSpanSeconds:8});
async function invoke(t,r,arcs){const h=await createBrowserModuleHarness({wasmSource:wasm,manifest,surface:'direct'});t.after(()=>h.destroy());const payload=new TextEncoder().encode(JSON.stringify(r));return h.invoke({methodId:'match_catalog',inputs:[{portId:'recipe',typeRef:{wireFormat:'aligned-binary',requiredAlignment:1,byteLength:payload.length},payload},...arcs.map(payload=>({portId:'ephemerides',typeRef:{schemaName:'OEM.fbs',fileIdentifier:'$OEM',rootTypeName:'OEM'},payload}))]});}
async function report(t,r,arcs){const out=await invoke(t,r,arcs);assert.equal(out.statusCode,0,out.errorMessage);return JSON.parse(new TextDecoder().decode(out.outputs.find(x=>x.portId==='report').payload));}
test('analytic circular orbit passes FD check and retains crosswalk provenance',async t=>{const r=await report(t,config(),[oem(),oem()]);assert.equal(r.matches[0].status,'compatible');assert.ok(r.matches[0].leftFiniteDifferenceResidualKmS<1e-8);assert.equal(r.matches[0].maximumPositionResidualKm,0);assert.equal(r.matches[0].evidence.source,'datefirst');});
test('same orbital plane with different phase is rejected',async t=>{const r=await report(t,config(),[oem(),oem({phase:Math.PI})]);assert.equal(r.matches[0].status,'rejected');assert.ok(Math.abs(r.matches[0].maximumPositionResidualKm-14000)<1e-8);});
test('a false supplied velocity is insufficient evidence',async t=>{const r=await report(t,config(),[oem(),oem({badVelocity:true})]);assert.equal(r.matches[0].status,'insufficient');assert.ok(r.matches[0].rightFiniteDifferenceResidualKmS>7);});
test('frame and epoch mismatches require normalization',async t=>{for(const change of [{frame:4},{start:'2026-09-21T00:00:01Z'},{step:2}]){const r=await report(t,config(),[oem(),oem(change)]);assert.equal(r.matches[0].status,'insufficient');}});
test('competing candidates from one provider are ambiguous',async t=>{const c=config();c.candidates.push(candidate('c','b'));c.pairs.push({left:'a',right:'c'});const r=await report(t,c,[oem(),oem(),oem()]);assert.deepEqual(r.matches.map(x=>x.status),['ambiguous','ambiguous']);});
test('three agreeing distinct providers are compatible',async t=>{const c=config();c.candidates.push(candidate('c'));c.pairs.push({left:'a',right:'c'});const r=await report(t,c,[oem(),oem(),oem()]);assert.deepEqual(r.matches.map(x=>x.status),['compatible','compatible']);});
test('short arcs and coarse finite differencing cannot establish compatibility',async t=>{let c=config();c.minimumSpanSeconds=9;assert.equal((await report(t,c,[oem(),oem()])).matches[0].status,'insufficient');c=config();assert.equal((await report(t,c,[oem({step:100}),oem({step:100})])).matches[0].status,'insufficient');});
test('invalid tolerances, duplicate pairs and malformed buffers fail closed',async t=>{for(const change of [{positionToleranceKm:0},{minimumSpanSeconds:-1},{pairs:[{left:'a',right:'b'},{left:'b',right:'a'}]}])assert.notEqual((await invoke(t,{...config(),...change},[oem(),oem()])).statusCode,0);assert.notEqual((await invoke(t,config(),[oem(),new Uint8Array(16)])).statusCode,0);});
test('invalid UTC calendar epochs are rejected',async t=>{for(const start of ['nonsense','2026-02-30T00:00:00Z','2026-09-21T25:00:00Z'])assert.notEqual((await invoke(t,config(),[oem({start}),oem({start})])).statusCode,0);});

test('interior-Earth states are rejected before matching',async t=>{assert.notEqual((await invoke(t,config(),[oem({radius:6000}),oem({radius:6000})])).statusCode,0);});

// Independent analytic derivative, same units/frame/epoch as matching-fixture.
// A 0.02 km/s endpoint error exceeds the 1e-8 km/s numerical tolerance.
// Both arcs share the error, so pairwise agreement alone cannot detect it.
test('epoch and final two velocity samples must pass the physics check',async t=>{
 for(const index of [0,1,7,8]) {
  const arc=oem({velocityErrors:{[index]:.02}});
  const r=await report(t,config(),[arc,arc]);
  assert.equal(r.matches[0].status,'insufficient',`sample ${index}`);
  assert.ok(r.matches[0].leftFiniteDifferenceResidualKmS>.0199);
 }
});
test('minimum five-sample arcs validate every derivative stencil',async t=>{
 const c={...config(),minimumSpanSeconds:4};
 assert.equal((await report(t,c,[oem({n:5}),oem({n:5})])).matches[0].status,'compatible');
 for(let index=0;index<5;index++) {
  const arc=oem({n:5,velocityErrors:{[index]:.02}});
  assert.equal((await report(t,c,[arc,arc])).matches[0].status,'insufficient');
 }
});

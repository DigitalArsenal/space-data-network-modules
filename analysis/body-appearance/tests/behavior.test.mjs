import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {createBrowserModuleHarness} from 'space-data-module-sdk/host/browser-module';
import {encodeRequest} from '../codec.js';
import {invoke,measure} from './measurements.mjs';
const bytes=fs.readFileSync(new URL('../dist/isomorphic/module.wasm',import.meta.url));
test('authoritative population, rotation, and phase-function measurements',async t=>{
  const harness=await createBrowserModuleHarness({wasmSource:bytes,surface:'direct'});t.after(()=>harness.destroy());
  const report=await measure(harness);console.log(JSON.stringify(report));
});
test('requests fail explicitly for invalid geometry and unavailable calibrations',async t=>{
  const h=await createBrowserModuleHarness({wasmSource:bytes,surface:'direct'});t.after(()=>h.destroy());
  const base={body_id:499,level:10,x:0,y:0,seed:1,radius_m:1000};
  const cases=[['place',{...base,x:1024}],['place',{...base,seed:1.5}],['place',{...base,radius_m:NaN}],['place',{...base,rock_abundance:1.1}],
    ['place',{...base,body_id:301,rock_abundance:.01,rock_min_m:.1,rock_max_m:1}],
    ['place',{...base,body_id:301,crater_n1_km2:.001,crater_min_m:1,crater_max_m:10}],
    ['parameters',{model:'asteroid:D'}],['phase_curve',{model:'Venus',phase_rad:[0]}],
    ['rotate',{profile:'magnetic',latitude_rad:2,longitude_rad:0,epoch_tai_s:0,scene_tai_s:1}],
    ['phase_curve',{model:'hg1g2',G1:.8,G2:.8,phase_rad:[0]}]];
  for(const [method,q] of cases)assert.notEqual((await h.invoke(encodeRequest(method,q))).statusCode,0,JSON.stringify(q));
  const empty=await invoke(h,'place',base);assert.equal(empty.rock_count,0);assert.equal(empty.crater_count,0);
  const zero=await invoke(h,'phase_curve',{model:'hg1g2',G1:.4,G2:.3,phase_rad:[0]});assert.equal(zero.relative_flux[0],1);
});
test('every shipped table number has units, source and scope',()=>{
  const table=JSON.parse(fs.readFileSync(new URL('../data/parameters.json',import.meta.url),'utf8'));
  assert.ok(table.length>=30);
  for(const p of table){assert.ok(Number.isFinite(p.value));assert.match(p.doi,/^10\./);assert.ok(p.locator && p.scope && p.unit);}
  // No test-only planet oracle may become part of the runtime source closure.
  for(const name of fs.readdirSync(new URL('../src/',import.meta.url)))assert.doesNotMatch(fs.readFileSync(new URL('../src/'+name,import.meta.url),'utf8'),/import.*oracle|include.*oracle|3\.0334[eE]-12/);
});

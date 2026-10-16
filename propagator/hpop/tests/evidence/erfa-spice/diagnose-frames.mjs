#!/usr/bin/env node
// Offline measurement, one process at a time. No HPOP sources are changed.
import fs from 'node:fs';
import path from 'node:path';
import {build,here} from './frame-diagnostics.mjs';
import {createHPOPPropagator} from '../../../index.js';
import {createBrowserModuleHarness} from 'space-data-module-sdk/testing';
import {REFERENCE,requestInputs} from '../../lib/orekitCases.mjs';
import {decodeResult} from '../../lib/prwCodec.mjs';
const work=fs.mkdtempSync(path.join(here,'.diagnose-'));
try {
 const measure=await build(work);
 const diagnosis=measure('diagnose');
 const plugin=await createHPOPPropagator();
 const ex=plugin.exports, raw=[];
 const p=ex.malloc(56),out=ex.malloc(56),forces=ex.malloc(120);
 try {
  for(const seed of diagnosis.wasmSeeds){
   if(ex.plugin_init()!==0)throw new Error('plugin_init failed');
   new Float64Array(ex.memory.buffer,forces,15).set([398600.4418,0,0,0,0,0,0,0,0,0,1000,20,20,2.2,1.3]);
   if(ex.plugin_set_force_model(forces)!==0)throw new Error('force model failed');
   new Float64Array(ex.memory.buffer,p,7).set([seed.jdUtc,...seed.positionKm,...seed.velocityKmS]);
   ex.plugin_set_state(p);
   if(ex.plugin_propagate_path(seed.jdUtc,0,1,out)!==1)throw new Error('plugin_propagate_path failed');
   raw.push({...seed,ecefM:Array.from(new Float64Array(ex.memory.buffer,out,3))});
  }
 }finally{ex.free(p);ex.free(out);ex.free(forces);await plugin.destroy?.();}
 const rawPath=path.join(work,'wasm.json');fs.writeFileSync(rawPath,JSON.stringify(raw));
 diagnosis.wasmEcef=measure('wasm',rawPath);
 diagnosis.temeReplay=measure('teme');
 const c={...REFERENCE.cases.find(c=>c.orbit==='LEO400'&&c.forces==='F0-point-mass'),drag:true};
 const inputs=requestInputs(c,{edit(exec){exec.SAMPLE_EPOCHS=exec.SAMPLE_EPOCHS.slice(0,1);exec.TARGET_EPOCH=exec.SAMPLE_EPOCHS[0];}});
 const force={source:'tests/lib/orekitCases.mjs requestInputs: LEO400 F0-point-mass, override drag=true; keep only first requested sample as target (01:00 UTC). RK78 tolerance 1e-13, maxStep 300 s. Compare identical requests with/without earth_orientation input.',epochUtc:'2026-08-02T00:00:00.000',targetUtc:'2026-08-02T01:00:00.000',frame:'GCRF',units:'km, km/s',interpretation:'Total fallback-vs-CIO result, including Earth-orientation/model setting and integration effects; not an isolated precession-defect measurement.'};
 const harness=await createBrowserModuleHarness({wasmSource:fs.readFileSync(path.join(here,'../../../dist/isomorphic/module.wasm')),surface:'direct'});
 try{for(const name of ['withoutEop','withEop']){
  const response=await harness.invoke({methodId:'invoke',inputs:name==='withoutEop'?inputs.filter(i=>i.portId!=='earth_orientation'):inputs});
  if(response.statusCode!==0)throw new Error(`force reachability ${name}: ${response.errorMessage}`);
  const decoded=decodeResult(response);force[name]={statusCode:response.statusCode,positionKm:decoded.position,velocityKmS:decoded.velocity,epochTDBJD:decoded.epochJD,steps:decoded.steps};
 }}finally{harness.destroy();}
 const forcePath=path.join(work,'force.json');fs.writeFileSync(forcePath,JSON.stringify(force));diagnosis.forcePath=measure('force',forcePath);
 diagnosis.about='Measured offline in C++/shipped WASM. Coefficient table is read directly from pinned ERFA nut80.c. All 50 stored UTC epochs; angular comparisons at HPOP jdTtUsed. Metre values are rotation bounds at LEO 6778137 m, GPS 26560000 m, GEO 42164170 m, except wasmEcef entries are actual x-axis-state differences. No HPOP source changes.';
 fs.writeFileSync(path.join(here,'diagnosis.json'),JSON.stringify(diagnosis,null,1)+'\n');
 console.log(JSON.stringify({maxima:diagnosis.maxima,worstClock:diagnosis.worstClock,wasmEcef:diagnosis.wasmEcef,temeReplay:diagnosis.temeReplay},null,1));
}finally{fs.rmSync(work,{recursive:true,force:true});}

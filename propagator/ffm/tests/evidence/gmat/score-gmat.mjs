#!/usr/bin/env node
// Offline FFM refresh against pinned GMAT trajectories. All propagation is
// shipped WASM; positions and STMs are reduced by the existing C++ helpers.
// node tests/evidence/gmat/score-gmat.mjs <gmat.json> [--stm <gmat-stm.json>]
//   [--out summary.json] [--settings suite,steps30,finest] [--only substring]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';
import { REFERENCE, requestInputs } from '../../lib/orekitCases.mjs';
import { decodePrw, decodeResult, sds } from '../../lib/prwCodec.mjs';
import { here, sha256, buildMetrics } from './evidence.mjs';
import { ALL, CASES, wasm, manifest, buildMetrics as buildStmMetrics } from '../nyx/scoring.mjs';
import { readCache, scoreStored } from '../tudat/scoring.mjs';
import { assertMatchingNumbers } from '../recorded-numbers.mjs';
const {values:o,positionals}=parseArgs({options:{cache:{type:'string'},stm:{type:'string'},out:{type:'string'},settings:{type:'string',default:'suite,steps30,finest'},only:{type:'string'},'verify-recorded':{type:'string'}},allowPositionals:true});
const file=positionals[0];if(!file)throw new Error('usage: score-gmat.mjs <gmat.json> [--stm <gmat-stm.json>]');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const record=read(file),stm=o.stm?read(o.stm):null,settings=ALL.filter(s=>o.settings.split(',').includes(s.id));
const recorded=o['verify-recorded']?read(o['verify-recorded']):null;
const cache=o.cache?readCache(path.resolve(o.cache)):null;
const work=fs.mkdtempSync(path.join(here,'.score-gmat-'));
try {
 const metrics=buildMetrics(work),matrices=buildStmMetrics(work),rows=[];
 const run=async(g,setting,withStm=false)=>{
  const c=REFERENCE.cases.find(c=>`${c.orbit} ${c.forces}`===g.id);
  const inputs=requestInputs(c,{maxStep:setting.maxStep,...(setting.tolerance?{tolerance:setting.tolerance}:{}),edit:exec=>{
   if(g.atmosphere==='JACCHIA_ROBERTS')exec.FORCES.ATMOSPHERE_MODEL=sds.pcfAtmosphereFamily.JACCHIA_ROBERTS;
   if(withStm)Object.assign(exec,{INCLUDE_STM:true,STM_TECHNIQUE:sds.prwDerivativeTechnique.ANALYTIC,DENSITY_TREATMENT:sds.prwDensityTreatment.FINITE_DIFFERENCE,DYNAMIC_PARAMETERS:[]});
  }});
  const h=await createBrowserModuleHarness({wasmSource:wasm,manifest,surface:'direct'});
  try{const r=await h.invoke({methodId:'invoke',inputs});if(r.statusCode!==0)throw new Error(`${g.id}: ${r.errorCode}: ${r.errorMessage}`);return r;}finally{h.destroy();}
 };
 for(const g of record.cases.filter(g=>!o.only||g.id.includes(o.only))) {
  const c=REFERENCE.cases.find(c=>`${c.orbit} ${c.forces}`===g.id);
  const row={id:g.id,orbit:g.orbit,forceSet:g.forceSet,row:g.row,toleranceClass:g.toleranceClass,toleranceM:CASES.protocol.tolerancesM.gmat[g.toleranceClass],...(g.atmosphere?{atmosphere:g.atmosphere}:{}),icrfDriftM:g.icrfDriftM,
   orekitMinusGmat:g.atmosphere==='JACCHIA_ROBERTS'?null:metrics({mode:'positions',positions:c.samples.slice(1).map(s=>s.slice(1,4)),scale:1,samples:g.samples})};
  const cached=g.atmosphere==='JACCHIA_ROBERTS'?null:cache?.cases.find(c=>c.id===g.id);
  for(const s of settings){
   if(cached?.[s.id])row[s.id]=scoreStored(cached[s.id],g,metrics);
   else {const r=decodeResult(await run(g,s));row[s.id]={...metrics({mode:'positions',positions:r.samples.map(s=>s.position),scale:1000,samples:g.samples}),steps:r.samples.at(-1).integrationSteps};}
  }
  const gs=stm?.cases.find(s=>s.id===g.id);
  if(gs){
   let samples;
   if(cached?.suiteStm&&cached.suiteStm.parameterColumns.length===0)samples=cached.suiteStm.samples;
   else {const response=await run(g,ALL[0],true),r=decodePrw(response.outputs.find(o=>o.portId==='response').payload).EXECUTION_RESULT;samples=r.SAMPLES.map(s=>({STM:s.STM}));}
   row.stm=matrices({mode:'stm',samples,reference:gs.stm.map(phi=>({phi})),parameters:[]});
  }
  if(recorded)assertMatchingNumbers(row,recorded.cases.find(c=>c.id===row.id),row.id);
  rows.push(row);console.log(`${g.id}: ${settings.map(s=>`${s.id} ${row[s.id].worstM} m`).join(', ')}`);
 }
 const out=o.out??path.join(here,`summary-${path.basename(file,'.json')}.json`);
 fs.writeFileSync(out,JSON.stringify({note:'FFM shipped WASM against pinned NASA GMAT trajectories; maximum hourly 3D position difference over 24 h in meters, and relative STM column differences. All numerical reductions are C++.',
  module:{version:read(path.join(here,'../../../package.json')).version,sha256:sha256('../../../dist/isomorphic/module.wasm')},
  gmat:{file:path.basename(file),sha256:sha256(path.resolve(file)),tool:record.tool,settings:record.settings,...(o.stm?{stmFile:path.basename(o.stm),stmSha256:sha256(path.resolve(o.stm))}:{})},node:process.version,host:os.cpus()[0].model,
  settings,tolerancesM:CASES.protocol.tolerancesM.gmat,cases:rows,skipped:record.skipped},null,1)+'\n');
 console.log(`Wrote ${out}`);
}finally{fs.rmSync(work,{recursive:true,force:true});}

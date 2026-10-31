// Method E2E of the open DCA producer, on real inputs read in place and never copied into this repository.
//   1. The publication rule: real operator files with their own Last-Modified through plan_operator and parse_operator.
//   2. The record: real energy arcs through calibrate_log_density against an independent oracle (the frozen E13 solver at
//      the supplied checkout, and this file's own arithmetic for the hold, the lag and the shrink), with the flow's typed
//      config off and on, then the same bytes on the headless browser and native WasmEdge.
// Inputs: OPEN_DCA_ORACLE (default: the stack's experiments checkout), OPEN_DCA_ARCS, OPEN_DCA_PUBLISHED, OPEN_DCA_PLANET_DIRS.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {Builder,ByteBuffer} from 'flatbuffers';
import * as S from 'spacedatastandards.org/lib/js/DCL/main.js';
import {createBrowserModuleHarness} from 'space-data-module-sdk/host/browser-module';
import {runtimeParity} from '../../../data-source/space-weather/tests/runtime-parity.mjs';
import {load,input,encodeTimerTick,decodeHttpRequest,encodeHttpResponse} from '../../../flows/open-dca/tests/inputs.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const reference=process.env.OPEN_DCA_ORACLE||path.resolve(root,'../../../../ancillary-packages/orbit-accuracy-experiments');
const {solveCommonMode,arcCenterOffsetMs}=await import(pathToFileURL(path.join(reference,'experiments/e13-open-dca/common-mode.mjs')));
const sample=new Set(JSON.parse(await fs.readFile(path.join(reference,'experiments/e13-open-dca/planet-sample.json'))).calibration);
const arcsFile=process.env.OPEN_DCA_ARCS||'/opt/data/sdn-archive/e13-open-dca/planet-arcs/testB-g24lean.msis.jsonl';
const planetDirs=(process.env.OPEN_DCA_PLANET_DIRS||'/opt/data/sdn-archive/hac/planet-ephemerides/history:/opt/data/sdn-archive/e13-open-dca/planet-live').split(':');
const kernelFile=process.env.OPEN_DCA_KERNEL||'/opt/data/sdn-archive/hac/naif-kernels/spk/planets/de440s.bsp';
const published=JSON.parse(await fs.readFile(process.env.OPEN_DCA_PUBLISHED||'/opt/data/sdn-archive/open-dca-fix/planet-published.json')).days;
const H=3600000,D=24*H;
const publishedMs=(day)=>{assert(published[day],`no publication time on record for ${day}`);return Date.parse(published[day]);};
const dayName=(ms)=>new Date(ms).toISOString().slice(0,10).replaceAll('-','');
// The day's last copy on record: a later directory's copy of a day replaces an earlier one's.
async function planetFile(day){
 let bytes=null;
 for(const dir of planetDirs){try{bytes=await fs.readFile(path.join(dir,`planet_${day}.states`));}catch(e){if(e.code!=='ENOENT')throw e;}}
 assert(bytes,`no copy of ${day}`);return bytes;
}
const evidence=await fs.mkdtemp(path.join(os.tmpdir(),'open-dca-method-'));
const receipt={status:'RUNNING'};

// ---- 1. The publication rule --------------------------------------------------------------------------------------------
const operator=await load('data-source/operator-states-public');
const kernel=await fs.readFile(kernelFile);
const tick=(issue)=>input('tick',encodeTimerTick({triggerId:'daily',firedMs:issue}),'TimerTick.fbs','TICK','TimerTick');
const planned=async(issue)=>(await operator.call('plan_operator',[tick(issue)])).outputs.map(o=>decodeHttpRequest(o.payload));
// One response per request; answer(day) may rewrite a day file's status, headers or body.
async function responses(issue,answer=(_,r)=>r){
 const out=[];
 for(const q of await planned(issue)){
  let r;
  if(q.url.endsWith('.bsp'))r={status:200,headers:{'last-modified':'Mon, 01 Jan 2024 00:00:00 GMT'},body:kernel};
  else{
   const day=q.url.slice(-15,-7);
   let ok=null;try{ok=await planetFile(day);}catch(e){if(!/no copy/.test(e.message))throw e;}
   r=answer(day,ok?{status:200,headers:{'last-modified':published[day]},body:ok}:{status:403,headers:{},body:Buffer.alloc(0)});
  }
  out.push(input('response',encodeHttpResponse({url:q.url,context:q.context,retrievedMs:issue,...r}),'HttpResponse.fbs','HRSP','HttpResponse'));
 }
 return out;
}
const lineageDays=(oem)=>[...oem.COMMENT.matchAll(/planet_(\d{8})\.states=|(\d{8})\.states=/g)].map(m=>m[1]||m[2]);
async function parse(frames){
 const parsed=await operator.call('parse_operator',frames);
 const oem=S.OEM.getSizePrefixedRootAsOEM(new ByteBuffer(parsed.outputs.find(f=>f.portId==='operator_states').payload)).unpack();
 assert(parsed.outputs.some(f=>f.portId==='kernel'));
 return oem;
}
const newestState=(oem)=>Math.max(...oem.EPHEMERIS_DATA_BLOCK.flatMap(b=>b.EPHEMERIS_DATA_LINES.map(l=>Date.parse(l.EPOCH))));
const refusedWith=async(frames,pattern)=>{const r=await operator.harness.invoke({methodId:'parse_operator',inputs:frames});assert.notEqual(r.statusCode,0);assert.equal(r.outputs.length,0);assert.match(r.errorMessage,pattern);};
try{
 // The last day with a copy on record, read at two issue times either side of its publication.
 const lastDay=Object.keys(published).sort().at(-1),dayStart=Date.parse(`${lastDay.slice(0,4)}-${lastDay.slice(4,6)}-${lastDay.slice(6,8)}T00:00:00Z`);
 const out=publishedMs(lastDay),before=out-60000,after=out+25*60000;
 assert.equal(Math.floor(before/D)*D,dayStart,'the file is published on its own UTC day');
 // No hour of day in the plan: the same 32 day files and the kernel at any time of the day.
 for(const issue of [before,after,dayStart]){
  const urls=(await planned(issue)).map(q=>q.url);
  assert.equal(urls.length,33);assert.equal(urls.filter(u=>u.endsWith('.states')).length,32);assert(urls[31].endsWith(`planet_${dayName(dayStart)}.states`),urls[31]);assert(urls[32].endsWith('de440s.bsp'));
 }
 // Published after the issue: its Last-Modified, or the source's 403, keeps it out. The run goes on and says what it read.
 const stated=await parse(await responses(before));
 assert(!lineageDays(stated).includes(lastDay),'a file published after the issue contributes nothing');assert.equal(lineageDays(stated).length,31);
 const forbidden=await parse(await responses(before,(day,r)=>day===lastDay?{status:403,headers:{},body:Buffer.alloc(0)}:r));
 assert.deepEqual(lineageDays(forbidden),lineageDays(stated));assert.equal(newestState(forbidden),newestState(stated));
 // Published before the issue: it enters, and the newest state moves on.
 const fresh=await parse(await responses(after));
 assert(lineageDays(fresh).includes(lastDay),'a file public at the issue contributes');assert.equal(lineageDays(fresh).length,32);
 assert(newestState(fresh)>newestState(stated),'the file published before the issue adds newer states');
 // A file last written early in its own day is as good as any: the rule names no hour.
 const earliest=Object.keys(published).filter(d=>d<lastDay).sort((a,b)=>(publishedMs(a)-Date.parse(`${a.slice(0,4)}-${a.slice(4,6)}-${a.slice(6,8)}T00:00:00Z`))-(publishedMs(b)-Date.parse(`${b.slice(0,4)}-${b.slice(4,6)}-${b.slice(6,8)}T00:00:00Z`)))[0];
 const window=await parse(await responses(publishedMs(earliest)+25*60000));
 assert(lineageDays(window).includes(earliest),`the early file ${earliest} contributes`);
 // A source that does not say when, or a request that failed, stops the run: nothing else can show it was public.
 await refusedWith(await responses(after,(day,r)=>day===lastDay?{...r,headers:{}}:r),/no publication time/);
 await refusedWith(await responses(after,(day,r)=>day===lastDay?{...r,status:500}:r),/Operator request failed/);
 receipt.publicationRule={lastFilesRead:lineageDays(fresh).length,earlyFile:earliest};
 console.log('Publication rule: PASS on real files');
}finally{await operator.destroy();}

// ---- 2. The record -----------------------------------------------------------------------------------------------------
const rows=(await fs.readFile(arcsFile,'utf8')).trim().split('\n').map(JSON.parse).filter(a=>sample.has(a.hwid)).map(a=>({...a,B:a.cdAreaOverMass??a.cdAreaOverMassN,sigmaB:a.sigmaB??a.sigmaLnB*a.cdAreaOverMassN,utcB:a.utcB??new Date(Date.parse(a.utcA)+(a.ttB-a.ttA)).toISOString()})).filter(a=>a.B>0&&a.sigmaB/a.B<=0.5&&a.hours>=20&&a.hours<=28);
assert(rows.length>=60,'Need at least 60 genuine NRLMSISE-00 energy arc fits');
// The file each arc's newest state first appeared in.
const firstFile=new Map();
const days=[...new Set(rows.map(a=>a.utcB.slice(0,10).replaceAll('-','')))].sort();
for(const day of days)for(const line of (await planetFile(day)).toString().split('\n')){const f=line.trim().split(/\s+/);if(f.length<9)continue;const key=`${f[0].toLowerCase()}|${Date.UTC(2000,0,1,12)+Math.round(Number(f[1])*1e3)}`;if(!firstFile.has(key))firstFile.set(key,day);}
const arcs=rows.map(a=>({dove:a.hwid,startMs:Date.parse(a.utcA),endMs:Date.parse(a.utcB),y:Math.log(a.B),B:a.B,sigma:a.sigmaB/a.B,file:firstFile.get(`${a.hwid}|${a.ttB}`)??a.utcB.slice(0,10).replaceAll('-','')}));
const selected=(issue)=>arcs.filter(a=>published[a.file]&&publishedMs(a.file)<=issue);
const table=(name,value)=>Object.assign(new S[`${name}T`](),value);
const request=(issue,chosen)=>table('DCL',{CREATED_AT_MS:BigInt(issue),ATMOSPHERE:table('ATM',{MODEL:S.AtmosphericModelFamily.NRLMSIS00E}),OBJECTS:chosen.map(a=>table('dclObject',{ID:a.dove,FIRST_MS:BigInt(a.startMs),LAST_MS:BigInt(a.endMs),LN_B:a.y,LN_B_SIGMA:a.sigma,BALLISTIC_COEFFICIENT_M2_KG:a.B,OK:true}))});
const frame=(v)=>{const b=new Builder(1024);S.DCL.finishDCLBuffer(b,v.pack(b));return {portId:'request',typeRef:{schemaName:'DCL.fbs',fileIdentifier:'$DCL',rootTypeName:'DCL',wireFormat:'flatbuffer'},payload:b.asUint8Array().slice()};};
const oracle=(issue,chosen)=>{
 const used=chosen.filter(a=>a.startMs>=issue-30*D);
 const sol=solveCommonMode(used,{anchorMs:Math.round(Math.floor(issue/D)*D+arcCenterOffsetMs(used)),nodeHours:24,baseline:{kind:'randomWalk',stepSigma:0.005},smoothSigma:0.05,huberK:1.5,iterations:60,tolerance:1e-5,minDovesPerNode:6,minNodeInfo:1.5,scaleSweeps:8});
 assert(sol.converged,'Frozen E13 oracle must converge on this evidence window');
 return {...sol,first:sol.supported.indexOf(true),last:sol.supported.lastIndexOf(true)};
};
// The shrink, written from its definition: per supported node, over the supported nodes in its trailing window.
const shrink=(sol,sigma,windowHours)=>sol.s.map((v,i)=>{
 if(!sol.supported[i])return v;
 const w=sol.s.filter((_,j)=>j<=i&&sol.supported[j]&&sol.nodeMs[i]-sol.nodeMs[j]<=windowHours*H);
 if(w.length<3)return v;
 const mean=w.reduce((a,x)=>a+x,0)/w.length,variance=w.reduce((a,x)=>a+(x-mean)**2,0)/(w.length-1);
 return mean+(variance>sigma*sigma?1-sigma*sigma/variance:0)*(v-mean);
});
const newestFile=days.at(-1),issue=publishedMs(newestFile)+25*60000;
const wasmPath=path.join(root,'dist/isomorphic/module.wasm'),manifest=JSON.parse(await fs.readFile(path.join(root,'plugin-manifest.json'))),wasmSource=await fs.readFile(wasmPath);
const harness=async(config)=>createBrowserModuleHarness({wasmSource,manifest,surface:'direct',...(config?{hostOptions:{config}}:{})});
const unpack=(r)=>{assert.equal(r.statusCode,0,r.errorMessage);assert.equal(r.outputs.length,1);return S.DCL.getRootAsDCL(new ByteBuffer(r.outputs[0].payload)).unpack();};
const chosen=selected(issue),value=request(issue,chosen),sol=oracle(issue,chosen);
const off=await harness();
let maxError=0;
try{
 // Config off: the solve as published, every value the oracle's, the last one held.
 const actual=unpack(await off.invoke({methodId:'calibrate_log_density',inputs:[frame(value)]})),c=actual.CORRECTION;
 assert.equal(actual.STATUS,S.dclStatus.Solved);assert.equal(c.FORM,S.dclCorrectionForm.LogDensityNodes);assert.equal(actual.OBJECTS.length,0);assert.equal(actual.STATES,null);assert.equal(c.NODE_VALUES_K.length,0);
 assert.equal(Number(actual.SETTINGS.TO_MS),sol.nodeMs[sol.last]);assert.equal(c.NODE_TIMES_MS.length,sol.last-sol.first+2);
 for(let i=0;i<=sol.last-sol.first;i++){assert.equal(Number(c.NODE_TIMES_MS[i]),sol.nodeMs[sol.first+i]);maxError=Math.max(maxError,Math.abs(c.NODE_LOG_DENSITY_SCALE_DIMENSIONLESS[i]-sol.s[sol.first+i]));}
 assert(maxError<2e-9,`Frozen E13 maximum log-density error ${maxError}`);
 const n=c.NODE_TIMES_MS.length;
 assert.equal(Number(c.NODE_TIMES_MS[n-1]),sol.nodeMs[sol.last]+48*H,'the hold node is 48 hours past the last solve epoch');
 assert.equal(c.NODE_LOG_DENSITY_SCALE_DIMENSIONLESS[n-1],c.NODE_LOG_DENSITY_SCALE_DIMENSIONLESS[n-2],'no ramp past the last solve epoch');
 assert.equal(actual.FIT.ITERATIONS,sol.sweeps);assert.equal(actual.FIT.CONVERGED,true);
 assert.match(actual.PROVENANCE.LINEAGE,/public-at-issue; history30d; hold48h; lag0h; shrink-off;/);
 // One minute before the file: an older record, read on the same arcs by the publication rule.
 const early=publishedMs(newestFile)-60000,older=unpack(await off.invoke({methodId:'calibrate_log_density',inputs:[frame(request(early,selected(early)))]}));
 assert(Number(older.SETTINGS.TO_MS)<Number(actual.SETTINGS.TO_MS),'the file public at the issue moves the last solve epoch on');
 // Refusals: an arc that ends after the issue, a stale fleet, another atmosphere.
 const cases=[{methodId:'calibrate_log_density',inputs:[frame(request(Math.max(...chosen.map(a=>a.endMs))-H,chosen))]},{methodId:'calibrate_log_density',inputs:[frame(request(issue+20*D,chosen))]},{methodId:'calibrate_log_density',inputs:[frame(table('DCL',{...value,ATMOSPHERE:table('ATM',{MODEL:S.AtmosphericModelFamily.JB08})}))]}];
 for(const test of cases){const refused=await off.invoke(test);assert.notEqual(refused.statusCode,0);assert.equal(refused.outputs.length,0);}
 assert.match((await off.invoke(cases[0])).errorMessage,/ends after the issue/);assert.match((await off.invoke(cases[1])).errorMessage,/more than 48 hours/);
}finally{await off.destroy();}
// Config on: the same solve, moved and shrunk by the values the lineage states.
const config={open_dca_lag_hours:9,open_dca_noise_sigma:0.065,open_dca_shrink_window_hours:168};
const on=await harness(config);
let maxShrinkError=0;
try{
 const actual=unpack(await on.invoke({methodId:'calibrate_log_density',inputs:[frame(value)]})),c=actual.CORRECTION,want=shrink(sol,0.065,168);
 assert.equal(Number(actual.SETTINGS.TO_MS),sol.nodeMs[sol.last]-9*H);assert.equal(Number(actual.SETTINGS.FROM_MS),sol.nodeMs[sol.first]-9*H);
 for(let i=0;i<=sol.last-sol.first;i++){assert.equal(Number(c.NODE_TIMES_MS[i]),sol.nodeMs[sol.first+i]-9*H);maxShrinkError=Math.max(maxShrinkError,Math.abs(c.NODE_LOG_DENSITY_SCALE_DIMENSIONLESS[i]-want[sol.first+i]));}
 assert(maxShrinkError<2e-9,`Shrink maximum log-density error ${maxShrinkError}`);
 assert(c.NODE_LOG_DENSITY_SCALE_DIMENSIONLESS.some((v,i)=>i<=sol.last-sol.first&&Math.abs(v-sol.s[sol.first+i])>1e-3),'the shrink changed the record');
 const n=c.NODE_TIMES_MS.length;assert.equal(Number(c.NODE_TIMES_MS[n-1]),sol.nodeMs[sol.last]-9*H+48*H);assert.equal(c.NODE_LOG_DENSITY_SCALE_DIMENSIONLESS[n-1],c.NODE_LOG_DENSITY_SCALE_DIMENSIONLESS[n-2]);
 assert.match(actual.PROVENANCE.LINEAGE,/hold48h; lag9h; shrink-sigma0\.065-window168h;/);
}finally{await on.destroy();}
// A config that does not say what it means is refused.
for(const bad of [{open_dca_lag_hours:-1},{open_dca_lag_hours:49},{open_dca_noise_sigma:0.065},{open_dca_shrink_window_hours:168}]){
 const h=await harness(bad);
 try{const r=await h.invoke({methodId:'calibrate_log_density',inputs:[frame(value)]});assert.notEqual(r.statusCode,0,JSON.stringify(bad));assert.equal(r.outputs.length,0);}finally{await h.destroy();}
}
// The same bytes on the headless browser and native WasmEdge, config on.
process.env.PATH=`${path.join(os.homedir(),'.wasmedge/bin')}:${process.env.PATH}`;
const parity=await runtimeParity({wasmPath,manifest,cases:[{methodId:'calibrate_log_density',inputs:[frame(value)]},{methodId:'calibrate_log_density',inputs:[frame(request(issue+20*D,chosen))]}],evidence,config});
Object.assign(receipt,{status:'PASS',arcs:chosen.length,fleet:new Set(chosen.map(a=>a.dove)).size,maxError,maxShrinkError,iterations:sol.sweeps,parity});
await fs.writeFile(path.join(evidence,'receipt.json'),JSON.stringify(receipt,null,1));
console.log(`PASS open DCA producer: ${chosen.length} real energy arcs, ${sol.sweeps} iterations, max |delta ln rho| ${maxError} (shrink ${maxShrinkError}); browser/native byte parity; ${evidence}`);
process.exit(0);

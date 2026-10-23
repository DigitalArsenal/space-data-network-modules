// Orchestration and FlatBuffer marshaling only; parsing and frame math use WASM.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import * as fb from 'flatbuffers';
import * as P from 'spacedatastandards.org/lib/js/PRW/main.js';
import * as F from 'spacedatastandards.org/lib/js/FIL/main.js';
import * as D from 'spacedatastandards.org/lib/js/DCL/main.js';
import {SPW} from 'spacedatastandards.org/lib/js/SPW/SPW.js';
import {EOP} from 'spacedatastandards.org/lib/js/EOP/EOP.js';
import {createBrowserModuleHarness} from 'space-data-module-sdk/host/browser-module';
import {encodeTimerTick,decodeHttpRequest,encodeHttpResponse} from 'space-data-module-sdk/runtime-contracts';
import {fullForceRequest,kernelRecord} from '../../../propagator/ffm/catalog.mjs';
import {createHash} from 'node:crypto';
export const modules=fileURLToPath(new URL('../../../',import.meta.url));
export const table=(name,fields)=>Object.assign(new P[`${name}T`](),fields);
export const input=(portId,code,payload)=>({portId,typeRef:{schemaName:code+'.fbs',fileIdentifier:'$'+code,rootTypeName:code,wireFormat:'flatbuffer'},payload});
export function fil(bytes,name='ephemeris.txt',port='meme'){
 const b=new fb.Builder(bytes.length+256);b.finish(Object.assign(new F.FILT(),{NAME:name,CONTENT:bytes}).pack(b),'$FIL');return input(port,'FIL',b.asUint8Array().slice());
}
export function prw(port,arm,record){const b=new fb.Builder(1024);b.finishSizePrefixed(Object.assign(new P.PRWT(),{[arm]:record}).pack(b),'$PRW');return input(port,'PRW',b.asUint8Array().slice());}
export function dcl(epoch,logScale){
 const b=new fb.Builder(256),correction=Object.assign(new D.dclCorrectionT(),{FORM:D.dclCorrectionForm.LogDensityNodes,NODE_TIMES_MS:[BigInt(Date.parse(epoch+'Z'))],NODE_LOG_DENSITY_SCALE_DIMENSIONLESS:[logScale]});
 b.finish(Object.assign(new D.DCLT(),{STATUS:D.dclStatus.Solved,ATMOSPHERE:Object.assign(new D.ATMT(),{MODEL:D.AtmosphericModelFamily.NRLMSIS00E}),CORRECTION:correction}).pack(b),'$DCL');return input('density_correction','DCL',b.asUint8Array().slice());
}
function records(bytes,Type){const out=[];for(let at=0;at<bytes.length;){const n=new DataView(bytes.buffer,bytes.byteOffset+at,4).getUint32(0,true);out.push(Type[`getSizePrefixedRootAs${Type.name}`](new fb.ByteBuffer(bytes.subarray(at,at+n+4))).unpack());at+=n+4;}return out;}
async function harness(relative){const root=path.join(modules,relative);return createBrowserModuleHarness({wasmSource:fs.readFileSync(path.join(root,'dist/isomorphic/module.wasm')),manifest:JSON.parse(fs.readFileSync(path.join(root,'plugin-manifest.json'))),surface:'direct'});}
export async function environment(){
 const eop=await harness('data-source/eop-parser');let rows;
 try {const r=await eop.invoke({methodId:'parse_finals2000a',inputs:[fil(fs.readFileSync(process.env.OD_EOP_FILE||'/opt/data/sdn-archive/hac/iers-eop/2026/2026-10-13/finals.daily.iau2000.txt'),'eop.txt','body')]});assert.equal(r.statusCode,0,r.errorMessage);rows=records(r.outputs.find(o=>o.portId==='records').payload,EOP);}finally{await eop.destroy();}
 const weather=await harness('data-source/space-weather');let spw,provenance=[];
 try{
  const tick={portId:'tick',typeRef:{schemaName:'TimerTick.fbs',fileIdentifier:'TICK',rootTypeName:'TimerTick',wireFormat:'flatbuffer'},payload:encodeTimerTick({triggerId:'operator-fit',firedMs:Date.now()})};
  const plan=await weather.invoke({methodId:'plan_weather',inputs:[tick]});assert.equal(plan.statusCode,0,plan.errorMessage);
  const inputs=[];
  for(const frame of plan.outputs.filter(o=>o.portId==='request')){
   const req=decodeHttpRequest(frame.payload);let body;
   for(let attempt=0;attempt<2;++attempt){try{const r=await fetch(req.url,{headers:req.headers,signal:AbortSignal.timeout(90000)});assert.equal(r.status,200,req.url);body=new Uint8Array(await r.arrayBuffer());break;}catch(e){if(attempt)throw e;}}
   provenance.push({url:req.url,sha256:createHash('sha256').update(body).digest('hex')});
   inputs.push({portId:'response',typeRef:{schemaName:'HttpResponse.fbs',fileIdentifier:'HRSP',rootTypeName:'HttpResponse',wireFormat:'flatbuffer'},payload:encodeHttpResponse({url:req.url,status:200,body,retrievedMs:Date.now()})});
  }
  const r=await weather.invoke({methodId:'parse_weather',inputs});assert.equal(r.statusCode,0,r.errorMessage);spw=records(r.outputs.find(o=>o.portId==='records').payload,SPW);
 }finally{await weather.destroy();}
 const kernel=kernelRecord(fs.readFileSync(process.env.OD_KERNEL_FILE||'/opt/data/sdn-archive/hac/naif-kernels/spk/planets/de440s.bsp'));
 return {provenance,inputs:[input('kernel','PRW',kernel),prw('earth_orientation','EARTH_ORIENTATION',table('PRWEarthOrientation',{ROWS:rows})),prw('space_weather','SPACE_WEATHER',table('PRWSpaceWeatherTable',{ROWS:spw}))]};
}
export function configuration(epoch){return prw('configuration','EXECUTION_REQUEST',fullForceRequest({epoch,state:[7000000,0,0,0,7500,0],cdAm:.003,crAm:.02}));}

// Orchestration and FlatBuffer marshaling only; parsing and frame math use WASM.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import * as fb from 'flatbuffers';
import * as P from 'spacedatastandards.org/lib/js/PRW/main.js';
import * as F from 'spacedatastandards.org/lib/js/FIL/main.js';
import * as O from 'spacedatastandards.org/lib/js/OEM/main.js';
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
// Independent test fixture: a known 10 m/s impulse executed by the published
// FFM propagator. The host only labels the requested UTC samples as OEM KVN.
export async function plantedManeuver(epoch,env){
 const start=Date.parse(epoch+'Z'),label=s=>new Date(start+s*1000).toISOString().replace('Z','');
 const instant=s=>table('TIMInstant',{TIME_SYSTEM:P.timingStandard.UTC,EPOCH_FORMAT:P.timEpochRepresentation.ISO8601,ISO8601:label(s)});
 const seconds=Array.from({length:73},(_,i)=>i*600);
 const request=fullForceRequest({epoch,state:[7000000,0,0,0,7500,1000],target:label(43200),cdAm:.003,crAm:.02});
 request.SAMPLE_EPOCHS=seconds.map(instant);
 request.IMPULSES=[table('PRWImpulse',{EPOCH:instant(21900),DELTA_V:table('FRMVector3',{X:0,Y:10,Z:0}),VECTOR_BASIS:P.prwSteeringBasis.INTEGRATION_FRAME})];
 const h=await harness('propagator/ffm');
 try{
  const r=await h.invoke({methodId:'invoke',inputs:[prw('request','EXECUTION_REQUEST',request),...env.inputs]});assert.equal(r.statusCode,0,r.errorMessage);
  const payload=r.outputs.find(o=>o.portId==='response').payload;
  const output=P.PRW.getSizePrefixedRootAsPRW(new fb.ByteBuffer(payload)).unpack().EXECUTION_RESULT;
  assert.equal(output.SAMPLES.length,seconds.length);
  const header='CCSDS_OEM_VERS = 2.0\nMETA_START\nOBJECT_NAME = PLANTED-MANEUVER\nOBJECT_ID = SYNTHETIC\nCENTER_NAME = EARTH\nREF_FRAME = GCRF\nTIME_SYSTEM = UTC\nMETA_STOP\n';
  const lines=output.SAMPLES.map((s,i)=>{const p=s.STATE.STATE.POSITION,v=s.STATE.STATE.VELOCITY;return label(seconds[i])+' '+[p.X,p.Y,p.Z,v.X,v.Y,v.Z].map(x=>x/1000).join(' ');});
  const covariance='COVARIANCE_START\nEPOCH = '+label(0)+'\nCOV_REF_FRAME = GCRF\n0.01\n0 0.02\n0 0 0.03\n0 0 0 0.000001\n0 0 0 0 0.000002\n0 0 0 0 0 0.000003\nCOVARIANCE_STOP\n';
  const kvn=fil(new TextEncoder().encode(header+lines.join('\n')+'\n'+covariance),'planted.oem');
  const ot=(name,fields)=>Object.assign(new O[name+'T'](),fields);
  const frame=ot('RFM',{REFERENCE_FRAME_type:O.RFMUnion.CelestialFrameWrapper,REFERENCE_FRAME:ot('CelestialFrameWrapper',{frame:O.CelestialFrame.GCRF})});
  const block=ot('ephemerisDataBlock',{OBJECT:ot('CAT',{OBJECT_NAME:'PLANTED-MANEUVER',OBJECT_ID:'SYNTHETIC'}),CENTER_NAME:'EARTH',REFERENCE_FRAME:frame,TIME_SYSTEM:O.timingStandard.UTC,
    EPHEMERIS_DATA_LINES:output.SAMPLES.map((s,i)=>{const p=s.STATE.STATE.POSITION,v=s.STATE.STATE.VELOCITY;return ot('ephemerisDataLine',{EPOCH:label(seconds[i]),X:p.X/1000,Y:p.Y/1000,Z:p.Z/1000,X_DOT:v.X/1000,Y_DOT:v.Y/1000,Z_DOT:v.Z/1000});}),
    COVARIANCE_MATRIX_LINES:[ot('covarianceMatrixLine',{EPOCH:label(0),COV_REFERENCE_FRAME:frame,CX_X:.01,CY_Y:.02,CZ_Z:.03,CX_DOT_X_DOT:.000001,CY_DOT_Y_DOT:.000002,CZ_DOT_Z_DOT:.000003})]});
  const b=new fb.Builder(4096);b.finish(ot('OEM',{EPHEMERIS_DATA_BLOCK:[block]}).pack(b),'$OEM');
  return {kvn,typed:input('oem','OEM',b.asUint8Array().slice())};
 }finally{await h.destroy();}
}

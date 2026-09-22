// Verification adapter only. All orbital physics / frame transforms run in WASM.
// JS serializes canonical SDS requests and routes the binary module outputs.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { Builder,ByteBuffer } from 'flatbuffers';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import { FRM,FRMFrameTransformRequestT,frmOperationCode,frmStateRepresentation } from '../../../foundation/frames/node_modules/spacedatastandards.org/lib/js/FRM/main.js';
import { frame,system,state,rfmAxisType } from '../../../foundation/frames/tests/rfm_selector_harness.mjs';
import { execution,encodePrw,decodeResult,instant,TYPE,sds,makeTable } from '../../../propagator/hpop/tests/lib/prwCodec.mjs';
import { oemStates } from './epoch-fixture.mjs';
const root=new URL('../../../',import.meta.url);
export async function runtime(relative) {
 const bytes=fs.readFileSync(new URL(relative+'/dist/isomorphic/module.wasm',root));
 const h=await createBrowserModuleHarness({wasmSource:bytes,manifest:JSON.parse(fs.readFileSync(new URL(relative+'/plugin-manifest.json',root))),surface:'direct'});
 return {h,sha:createHash('sha256').update(bytes).digest('hex')};
}
export async function createPropagator() {
 const frames=await runtime('foundation/frames'),hpop=await runtime('propagator/hpop'),time=await runtime('foundation/time');
 async function tdb(jd) {
  const b=new Builder(512),q=makeTable('TIM',{CONVERSION_REQUEST:makeTable('TIMConversionRequest',{SOURCE:instant(jd,'UTC'),TARGET_TIME_SYSTEM:sds.timingStandard.TDB,TARGET_EPOCH_FORMAT:sds.timEpochRepresentation.JULIAN_DATE})});
  b.finish(q.pack(b),'$TIM');const out=await time.h.invoke({methodId:'convert_time',inputs:[{portId:'request',typeRef:{schemaName:'TIM.fbs',fileIdentifier:'$TIM',rootTypeName:'TIM'},payload:b.asUint8Array()}]});
  if(out.statusCode!==0)throw new Error(out.errorMessage);const r=sds.TIM.getRootAsTIM(new ByteBuffer(out.outputs[0].payload)).CONVERSION_RESULT();if(r.STATUS()!==0)throw new Error(r.ERROR_MESSAGE());return r.TARGET().JULIAN_DATE();
 }
 async function transform(values,epoch,inverse=false) {
  const from=inverse?'GCRF':'J2000',to=inverse?'J2000':'GCRF';
  const source=system(from,inverse?rfmAxisType.ICRF:rfmAxisType.MEAN_EQUATOR_EQUINOX_J2000),target=system(to,inverse?rfmAxisType.MEAN_EQUATOR_EQUINOX_J2000:rfmAxisType.ICRF);
  source.EPOCH=target.EPOCH=epoch;const input=state(values.slice(0,3).map(x=>x*1000),values.slice(3).map(x=>x*1000),from);input.EPOCH=epoch;
  const q=Object.assign(new FRMFrameTransformRequestT(),{OPERATION:frmOperationCode.STATE_TRANSFORM,SOURCE_COORDINATE_SYSTEM:source,TARGET_COORDINATE_SYSTEM:target,SOURCE_STATE:input,TARGET_REPRESENTATION:frmStateRepresentation.CARTESIAN,EPOCH:epoch,EPOCH_TIME_SYSTEM:'UTC'});
  const out=await frames.h.invoke({methodId:'transform_frame_position',inputs:[frame(q)]});if(out.statusCode!==0)throw new Error(out.errorMessage);
  const r=FRM.getRootAsFRM(new ByteBuffer(out.outputs[0].payload)).FRAME_TRANSFORM_RESULT();if(r.STATUS()!==0)throw new Error(r.ERROR_MESSAGE());
  const s=r.TARGET_STATE();return [s.POSITION().X(),s.POSITION().Y(),s.POSITION().Z(),s.VELOCITY().X(),s.VELOCITY().Y(),s.VELOCITY().Z()].map(x=>x/1000);
 }
 const forces={centralBody:true,j2:true,j3:true,j4:true,thirdBody:true,srp:false,drag:false};
 const integrator={method:'RKF78',initialStep:10,minStep:1e-5,maxStep:60,absTolerance:1e-11,relTolerance:1e-11};
 async function propagate(values,epoch,n=17,step=600) {
  const pv=await transform(values,epoch),epochJD=Date.parse(epoch)/86400000+2440587.5;
  const q=execution({position:pv.slice(0,3),velocity:pv.slice(3),epochJD,epochTimeScale:'UTC',targetJD:epochJD+(n-1)*step/86400,forces,integrator});
  q.SAMPLE_EPOCHS=[];for(let i=1;i<n;i++)q.SAMPLE_EPOCHS.push(instant(await tdb(epochJD+i*step/86400)));q.TARGET_EPOCH=q.SAMPLE_EPOCHS.at(-1);
  const out=await hpop.h.invoke({methodId:'invoke',inputs:[{portId:'request',typeRef:TYPE,payload:encodePrw('EXECUTION_REQUEST',q)}]});if(out.statusCode!==0)throw new Error(out.errorMessage);
  const result=decodeResult(out);if(result.samples.length!==n-1)throw new Error('HPOP omitted requested sample epochs');
  const samples=[...values];
  for(let i=1;i<n;i++) {
   // A frame-bias rotation is constant, but still invoke the frame module for
   // each sample. The epoch string here labels the same requested UTC instant.
   const utc=new Date(Date.parse(epoch)+i*step*1000).toISOString();
   samples.push(...await transform([...result.samples[i-1].position,...result.samples[i-1].velocity],utc,true));
  }
  return {values:samples,oem:oemStates(samples,{epoch,step}),result};
 }
 return {propagate,policy:{propagatorId:'com.orbpro.hpop',propagatorArtifactSha256:hpop.sha,forceModel:{...forces,ephemerisSource:'Analytical',integrator,limitation:'J2-J4/analytical Sun-Moon; no GOST atmosphere or fitted SRP'},frameTransformationRef:`foundation.frames:${frames.sha}:J2000-to-GCRF-and-back`},destroy:async()=>{await frames.h.destroy();await hpop.h.destroy();await time.h.destroy();}};
}

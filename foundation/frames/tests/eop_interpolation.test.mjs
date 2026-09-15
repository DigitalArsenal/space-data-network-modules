import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import * as fb from 'flatbuffers';
import {FRM,FRMT,FRMFrameTransformRequestT,frmOperationCode,frmResultStatus,RFMCoordinateSystemT,RFMOriginT,rfmOriginKind,rfmAxisType} from 'spacedatastandards.org/lib/js/FRM/main.js';
import {EOP,EOPT} from 'spacedatastandards.org/lib/js/EOP/main.js';
import {createBrowserModuleHarness} from 'space-data-module-sdk/testing';
import {parseRequest} from '../../../data-source/eop-parser/tests/harness.mjs';
import {AS2R,typeRef,eop,invokeRequest,sofaMatrix} from './eop_harness.mjs';
function decoded(r){assert.equal(r.statusCode,0,r.errorMessage);return FRM.getRootAsFRM(new fb.ByteBuffer(r.outputs[0].payload)).FRAME_TRANSFORM_RESULT();}
function matrix(r){const result=decoded(r);assert.equal(result.STATUS(),frmResultStatus.OK,result.ERROR_MESSAGE());const m=result.ROTATION_DCM();return [m.M11(),m.M12(),m.M13(),m.M21(),m.M22(),m.M23(),m.M31(),m.M32(),m.M33()];}
const maxError=(a,b)=>Math.max(...a.map((v,i)=>Math.abs(v-b[i])));
async function harness(t){const h=await createBrowserModuleHarness({wasmSource:fs.readFileSync(new URL('../dist/isomorphic/module.wasm',import.meta.url)),surface:'direct'});t.after(()=>h.destroy());return h;}
test('SOFA Earth Attitude section 5.6 published GCRS to ITRS matrix',async t=>{
 // Source https://www.iausofa.org/s/sofa_pn_c.pdf revision 1.7 pp17-18,25-27.
 // 2007-04-05 12:00 UTC; TT and UT1 from ERFA UTC conversions. Dimensionless,
 // row-major GCRS->ITRS, xp/yp and dX/dY as printed in the cookbook.
 // 1e-12 tolerance allows printed-decimal rounding and libm differences.
 const h=await harness(t);const actual=matrix(await h.invoke(invokeRequest(undefined,[eop()])));const error=maxError(actual,sofaMatrix);console.log(`AUTH SOFA 5.6 maximum matrix error=${error}`);assert.ok(error<1e-12);
});
test('real finals2000A table nodes and midpoint agree with independently transcribed values',async t=>{
 const h=await harness(t);const p=await createBrowserModuleHarness({wasmSource:fs.readFileSync(new URL('../../../data-source/eop-parser/dist/isomorphic/module.wasm',import.meta.url)),surface:'direct'});t.after(()=>p.destroy());
 const response=await p.invoke(parseRequest('finals2000a'));assert.equal(response.statusCode,0,response.errorMessage);
 const stream=Buffer.from(response.outputs.find(x=>x.portId==='records').payload);
 const rows=[];for(let at=0;at<stream.length;){const n=stream.readUInt32LE(at);at+=4;const payload=stream.subarray(at,at+n);const row=EOP.getRootAsEOP(new fb.ByteBuffer(payload));if([60000,60001].includes(row.MJD()))rows.push({portId:'earth_orientation',typeRef,payload});at+=n;}
 // Linear interpolation at noon, using the published decimals at MJD 60000 and 60001.
 for(const [epoch,f]of [['2023-02-25T00:00:00Z',0],['2023-02-25T12:00:00Z',.5],['2023-02-26T00:00:00Z',1]]){
  const lerp=(a,b)=>a+f*(b-a);
  const expected=eop({x:lerp(-.039677,-.040919),y:lerp(.305150,.308147),dut1:lerp(-.0151470,-.0155598),dx:lerp(.000296,.000305),dy:lerp(-.000086,-.000067),lod:lerp(.0005482,.0002539),convention:1});
  const actual=matrix(await h.invoke(invokeRequest(epoch,rows)));const explicit=matrix(await h.invoke(invokeRequest(epoch,[expected])));const error=maxError(actual,explicit);assert.ok(error<1e-14);console.log(`INTERPOLATION ${epoch} matrix error=${error}`);
 }
 const prefixed=Buffer.concat(rows.map(r=>{const n=Buffer.alloc(4);n.writeUInt32LE(r.payload.length);return Buffer.concat([n,r.payload]);}));
 const a=matrix(await h.invoke(invokeRequest('2023-02-25T12:00:00Z',rows)));const b=matrix(await h.invoke(invokeRequest('2023-02-25T12:00:00Z',[{portId:'earth_orientation',typeRef,payload:prefixed}])));assert.deepEqual(a,b);
});
test('UT1 interpolation does not smear the 2016 leap second',async t=>{
 // Published finals2000A MJD57753/57754: -0.4077601/+0.5912821 s; ERFA/IERS
 // TAI-UTC 36/37 s. Independent linear UT1-TAI expectation at 43200/86401.
 // xp/yp fixed to isolate the discontinuity; UTC epoch, GCRS->ITRS matrix.
 const h=await harness(t),t0={mjd:57753,date:'2016-12-31T00:00:00Z',dut1:-.4077601},t1={mjd:57754,date:'2017-01-01T00:00:00Z',dut1:.5912821};
 for(const [epoch,seconds]of [['2016-12-31T12:00:00Z',43200],['2016-12-31T23:59:60Z',86400]]){
  const expected=-.4077601+(seconds/86401)*(.5912821-1+.4077601);
  const actual=matrix(await h.invoke(invokeRequest(epoch,[eop(t0),eop(t1)])));const direct=matrix(await h.invoke(invokeRequest(epoch,[eop({dut1:expected})])));const error=maxError(actual,direct);assert.ok(error<1e-14);console.log(`LEAP ${epoch} matrix error=${error}`);
 }
});
test('EOP tables reject mixed provenance, unsorted dates, extrapolation and invalid buffers',async t=>{
 const h=await harness(t);const a=eop(),b=eop({mjd:54196,date:'2007-04-06T00:00:00Z'});
 for(const rows of [[b,a],[a,a],[a,eop({mjd:54196,date:'2007-04-06T00:00:00Z',series:2})],[a,eop({mjd:54196,date:'2007-04-06T00:00:00Z',cid:'other'})],[{...a,payload:Buffer.from('bad')}],[a,eop({mjd:54196})]])assert.equal(decoded(await h.invoke(invokeRequest(undefined,rows))).STATUS(),frmResultStatus.INVALID_INPUT);
 assert.equal(decoded(await h.invoke(invokeRequest('2007-04-07T00:00:00Z',[a,b]))).STATUS(),frmResultStatus.INVALID_INPUT);
});
test('explicit double zero and mixed precision fields follow SDS field presence',async t=>{
 const h=await harness(t);const a=matrix(await h.invoke(invokeRequest(undefined,[eop({x:0,legacyX:1})])));const b=matrix(await h.invoke(invokeRequest(undefined,[eop({x:0})])));assert.deepEqual(a,b);
 // Only x has an HP field; y/dUT1 must still use float fallback.
 const builder=new fb.Builder(512);EOP.startEOP(builder);EOP.addXPoleWanderRadiansHp(builder,1e-7);EOP.addYPoleWanderRadians(builder,2e-6);EOP.addUt1MinusUtcSeconds(builder,.2);EOP.finishEOPBuffer(builder,EOP.endEOP(builder));
 const partial={portId:'earth_orientation',typeRef,payload:builder.asUint8Array()};
 const expected=eop({x:1e-7/AS2R,y:Math.fround(2e-6)/AS2R,dut1:Math.fround(.2),dx:0,dy:0});
 assert.ok(maxError(matrix(await h.invoke(invokeRequest(undefined,[partial]))),matrix(await h.invoke(invokeRequest(undefined,[expected]))))<1e-14);
});

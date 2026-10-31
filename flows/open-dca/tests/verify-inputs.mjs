// E2E input contract: real public daily files, the publication rule, and the
// independent E13 time/frame modules before the energy-arc comparison.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {load,responses,S,ByteBuffer,decodeHttpResponse,encodeHttpResponse} from './inputs.mjs';
import {readInputs} from './offline.mjs';
export async function verifyInputs(dir){
 const reference=process.env.OPEN_DCA_ORACLE,artifacts=process.env.OPEN_DCA_REFERENCE_ARTIFACTS;
 const {convertIso}=await import(pathToFileURL(path.join(reference,'harness/time.mjs')));
 const {toGcrf}=await import(pathToFileURL(path.join(reference,'experiments/e13-open-dca/vendor/frames.mjs')));
 const operator=await load('data-source/operator-states-public');
 const time=await load('foundation/time',path.join(artifacts,'foundation/time/dist/isomorphic/module.wasm'));
 const frames=await load('foundation/frames',path.join(artifacts,'foundation/frames/dist/isomorphic/module.wasm'));
 try{
  const batch=await responses(dir,'operator',33),parsed=await operator.call('parse_operator',batch);
  const invalid=batch.map(f=>({...f})),r=decodeHttpResponse(invalid[0].payload);
  const {'last-modified':_,...unstated}=r.headers;invalid[0].payload=encodeHttpResponse({...r,headers:unstated});
  const refused=await operator.harness.invoke({methodId:'parse_operator',inputs:invalid});
  assert.notEqual(refused.statusCode,0);assert.match(refused.errorMessage,/no publication time/);assert.equal(refused.outputs.length,0);
  const oem=S.OEM.getSizePrefixedRootAsOEM(new ByteBuffer(parsed.outputs.find(f=>f.portId==='operator_states').payload)).unpack();
  const prepared=(await readInputs(dir)).filter(f=>f.portId==='request').map(f=>S.DCL.getRootAsDCL(new ByteBuffer(f.payload)).unpack());
  let checked=0,maxPositionErrorM=0,maxVelocityErrorMs=0;
  for(const block of oem.EPHEMERIS_DATA_BLOCK){
   const actual=prepared.find(d=>d.ID===block.OBJECT.OBJECT_ID);assert(actual);
   for(const i of new Set([0,block.EPHEMERIS_DATA_LINES.length-1])){
    const row=block.EPHEMERIS_DATA_LINES[i],got=actual.STATES.EPHEMERIS.EPHEMERIS_DATA_LINES[i];
    const utc=(await convertIso({invoke:(m,f)=>time.call(m,f)},row.EPOCH,'TT','UTC')).replace(/Z$/,'');
    const ms=Date.parse(utc.slice(0,19)+'Z')+Number('0.'+(utc.split('.')[1]||'0'))*1000;
    assert(Math.abs(Date.parse(got.EPOCH+'Z')-ms)<=0.51,'TT to UTC millisecond rounding');
    const expected=await toGcrf({invoke:(m,f)=>frames.call(m,f)},'MEAN_EQUATOR_EQUINOX_J2000',got.EPOCH,[row.X,row.Y,row.Z,row.X_DOT,row.Y_DOT,row.Z_DOT].map(x=>x*1000));
    const values=[got.X,got.Y,got.Z,got.X_DOT,got.Y_DOT,got.Z_DOT].map(x=>x*1000);
    for(let j=0;j<6;j++){const e=Math.abs(values[j]-expected[j]);if(j<3)maxPositionErrorM=Math.max(maxPositionErrorM,e);else maxVelocityErrorMs=Math.max(maxVelocityErrorMs,e);}
    checked++;
   }
  }
  assert(maxPositionErrorM<1e-7&&maxVelocityErrorMs<1e-10,'Independent ERFA bias conversion');
  return {checked,maxPositionErrorM,maxVelocityErrorMs,unstatedPublicationTime:'REJECTED'};
 }finally{for(const m of [operator,time,frames])await m.destroy();}
}

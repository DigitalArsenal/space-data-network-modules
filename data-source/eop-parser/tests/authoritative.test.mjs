import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {createBrowserModuleHarness} from 'space-data-module-sdk/testing';
import {bodies,parseRequest,decodeRecords,meta,notice,response,body,encodeFil,TYPE} from './harness.mjs';
const AS2R=Math.PI/648000;
const names=['X_POLE_WANDER_RADIANS_HP','Y_POLE_WANDER_RADIANS_HP','UT1_MINUS_UTC_SECONDS_HP','X_CELESTIAL_POLE_OFFSET_RADIANS_HP','Y_CELESTIAL_POLE_OFFSET_RADIANS_HP','LENGTH_OF_DAY_CORRECTION_SECONDS_HP'];
// Sources: fixtures/provenance.json specifies original published line numbers and hashes.
// ITRS polar motion, GCRS IAU2000A CIP offsets, MJD 60000 at 00:00 UTC.
// Independently transcribed source decimals; angles converted from arcsec (finals dX/dY from mas).
const published={finals2000a:[-.039677,.305150,-.0151470,.000296,-.000086,.0005482],c04:[-.039675,.305058,-.0151458,.000246,-.000066,.0005449],paris:[-.039675,.305058,-.0151458,.000246,-.000066,.0005449]};
test('published IERS/Paris MJD 60000 values survive parsing into SDS doubles',async t=>{
 const h=await createBrowserModuleHarness({wasmSource:fs.readFileSync(new URL('../dist/isomorphic/module.wasm',import.meta.url)),surface:'direct'});t.after(()=>h.destroy());
 for(const source of Object.keys(bodies)){
  const r=await h.invoke(parseRequest(source));assert.equal(r.statusCode,0,r.errorMessage);
  const rows=decodeRecords(r),row=rows.find(x=>x.MJD===60000);assert.ok(row);
  const expected=published[source].map((v,i)=>[0,1,3,4].includes(i)?v*AS2R:v);
  const errors=names.map((n,i)=>Math.abs(row[n]-expected[i]));
  // 2e-21 rad / 1e-18 s bound only binary64 conversion/serialization, not EOP accuracy.
  errors.forEach((e,i)=>assert.ok(e<([0,1,3,4].includes(i)?2e-21:1e-18),`${source} ${names[i]} error ${e}`));
  assert.equal(row.DATE,'2023-02-25T00:00:00Z');assert.equal(row.SERIES,{finals2000a:5,c04:2,paris:6}[source]);assert.equal(row.IAU_CONVENTION,1);assert.equal(row.DATA_TYPE,0);
  assert.equal(row.UT1_MINUS_UTC_SECONDS,Math.fround(expected[2]));
  assert.equal(row.X_POLE_WANDER_RADIANS,Math.fround(expected[0]));
  const sigmas=source==='finals2000a'?[.000043,.000047,.0000075,.000256,.000073,.0000044]:[.000063,.000061,.0000212,.000053,.000043,.0000283];
  const sigmaNames=['X_POLE_WANDER_UNCERTAINTY_RADIANS','Y_POLE_WANDER_UNCERTAINTY_RADIANS','UT1_MINUS_UTC_UNCERTAINTY_SECONDS','X_CELESTIAL_POLE_OFFSET_UNCERTAINTY_RADIANS','Y_CELESTIAL_POLE_OFFSET_UNCERTAINTY_RADIANS','LENGTH_OF_DAY_UNCERTAINTY_SECONDS'];
  for(let i=0;i<6;i++)assert.equal(row[sigmaNames[i]],Math.fround(sigmas[i]*([0,1,3,4].includes(i)?AS2R:1)));
  const sha=createHash('sha256').update(bodies[source]).digest('hex'),m=meta(r);assert.equal(m.tags.batchId,sha);assert.equal(m.provenance.sourceSha256,sha);assert.equal(row.DATA_SET_CID,'f01551220'+sha);
  assert.equal(m.schema,'EOP.fbs');assert.equal(m.provenance.normalizedCount,rows.length);assert.deepEqual(m.provenance.schemaCounts,{'EOP.fbs':rows.length});assert.equal(m.provenance.parser,'eop-parser');assert.equal(m.provenance.parserVersion,source);
  assert.equal(m.tags.sourceName,{finals2000a:'IERS finals2000A Bulletin A columns',c04:'IERS EOP 20 C04',paris:'Paris Observatory EOP 20 C04 legacy IAU2000 format'}[source]);assert.match(m.tags.sourceUrl,/^https:\/\/(datacenter.iers.org|hpiers.obspm.fr)\//);assert.equal(row.DATA_SET_EPOCH,null);
  const snapshot=r.outputs.map(x=>({portId:x.portId,payload:Buffer.from(x.payload)}));
  const http=await h.invoke(parseRequest(source,bodies[source],true));assert.equal(http.statusCode,0,http.errorMessage);
  // the same records either way; the meta differs only by the HTTP status the provenance records
  assert.deepEqual(Buffer.from(http.outputs.find(x=>x.portId==='records').payload),snapshot.find(x=>x.portId==='records').payload);
  assert.deepEqual({...meta(http),provenance:{...meta(http).provenance,httpStatus:0}},meta(r));assert.equal(meta(http).provenance.httpStatus,200);
  console.log(`AUTH ${source} MJD 60000 max angle error=${Math.max(...errors.filter((_,i)=>[0,1,3,4].includes(i)))} rad; max time error=${Math.max(errors[2],errors[5])} s`);
 }
});
test('fixture excerpts have independently recorded SHA-256 checksums',()=>{
 for(const f of JSON.parse(fs.readFileSync(new URL('fixtures/provenance.json',import.meta.url)))){
  const bytes=fs.readFileSync(new URL('fixtures/'+f.file,import.meta.url));assert.equal(createHash('sha256').update(bytes).digest('hex'),f.excerpt_sha256);
 }
});
test('prediction flags, blanks, malformed rows, HTTP and input bounds',async t=>{
 const h=await createBrowserModuleHarness({wasmSource:fs.readFileSync(new URL('../dist/isomorphic/module.wasm',import.meta.url)),surface:'direct'});t.after(()=>h.destroy());
 const good=await h.invoke(parseRequest('finals2000a'));assert.equal(good.statusCode,0,good.errorMessage);
 const rows=decodeRecords(good);assert.equal(rows.filter(r=>r.DATA_TYPE===1).length,2);assert.deepEqual(meta(good).provenance.warnings,['1 empty future rows skipped']);
 const predicted=rows.find(r=>r.DATA_TYPE===1);assert.equal(predicted.LENGTH_OF_DAY_CORRECTION_SECONDS_HP,0);
 const line=bodies.finals2000a.toString().split('\n').find(x=>x.includes('60000.00'));
 const bad=[Buffer.from(line.slice(0,65)),Buffer.from(line.slice(0,18)+'     NaN '+line.slice(27)),Buffer.from(line.replace('60000.00','60000.50')),Buffer.from(line+'\n'+line),Buffer.from('<html>upstream error</html>')];
 for(const b of bad){const r=await h.invoke(parseRequest('finals2000a',b));assert.notEqual(r.statusCode,0);assert.equal(r.outputs.length,0);}
 const mixed=Buffer.from(line.slice(0,95)+'P'+line.slice(96));assert.equal(decodeRecords(await h.invoke(parseRequest('finals2000a',mixed)))[0].DATA_TYPE,1);
 for(const r of [{status:500,body:Buffer.from('oops')},{status:200,body:new Uint8Array(0)},{status:0,error:'refused'}])assert.notEqual((await h.invoke({methodId:'parse_finals2000a',inputs:[response(r)]})).statusCode,0);
 // frames that are not the port's type are refused
 assert.notEqual((await h.invoke({methodId:'parse_finals2000a',inputs:[{portId:'body',typeRef:TYPE.FIL,payload:Buffer.from(bodies.finals2000a)}]})).statusCode,0);
 assert.notEqual((await h.invoke({methodId:'parse_finals2000a',inputs:[{portId:'response',typeRef:TYPE.HRSP,payload:encodeFil(bodies.finals2000a)}]})).statusCode,0);
 // body and response together, or neither
 assert.notEqual((await h.invoke({methodId:'parse_c04',inputs:[body(bodies.c04),response({status:200,body:bodies.c04})]})).statusCode,0);
 assert.notEqual((await h.invoke({methodId:'parse_c04',inputs:[]})).statusCode,0);
 // over the 16 MiB bound
 assert.notEqual((await h.invoke(parseRequest('c04',Buffer.alloc(16*1024*1024+1,0x20)))).statusCode,0);
 const unchanged=await h.invoke({methodId:'parse_c04',inputs:[response({status:304})]});assert.equal(unchanged.statusCode,0);assert.deepEqual(unchanged.outputs.map(x=>x.portId),['unchanged']);
 assert.deepEqual(notice(unchanged),{kind:'unchanged',schema:'EOP.fbs',providerId:'',sourceName:'IERS EOP 20 C04',batchId:'',count:1,reason:'not-modified',items:['https://hpiers.obspm.fr/iers/eop/eopc04/eopc04.1962-now'],atMs:0});
 // the issue epoch a $FIL names (MODIFIED_AT_MS) is every row's DATA_SET_EPOCH
 const issued=decodeRecords(await h.invoke({methodId:'parse_paris',inputs:[body(bodies.paris,{modifiedAtMs:Date.UTC(2026,8,15,14,35,15,555)})]}));
 assert.ok(issued.length>0&&issued.every(x=>x.DATA_SET_EPOCH==='2026-09-15T14:35:15Z'));
 const duplicate=parseRequest('c04');duplicate.inputs.push(duplicate.inputs[0]);assert.notEqual((await h.invoke(duplicate)).statusCode,0);
});

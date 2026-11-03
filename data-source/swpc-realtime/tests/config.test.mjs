import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createBrowserModuleHarness} from 'space-data-module-sdk/host/browser-module';
import {encodeModuleConfig,encodeTimerTick,encodeHttpResponse} from 'space-data-module-sdk/runtime-contracts';
const read=p=>fs.readFile(new URL(p,import.meta.url));
const manifest=JSON.parse(await read('../plugin-manifest.json'));
const sources=JSON.parse(await read('./fixtures/provenance.json'));
const frame=(portId,payload,schemaName,fileIdentifier,rootTypeName)=>({portId,payload,typeRef:{schemaName,fileIdentifier,rootTypeName,wireFormat:'flatbuffer',byteLength:payload.length}});
const config=payload=>frame('config',payload,'ModuleConfig.fbs','MCFG','ModuleConfig');
const empty=config(encodeModuleConfig({}));
const tick=frame('tick',encodeTimerTick({triggerId:'minute',firedMs:1}),'TimerTick.fbs','TICK','TimerTick');
const responses=await Promise.all(sources.map(async s=>frame('response',encodeHttpResponse({url:s.url,status:200,body:await read('./fixtures/'+s.file),retrievedMs:Date.parse(s.retrieved_at)}),'HttpResponse.fbs','HRSP','HttpResponse')));
const h=await createBrowserModuleHarness({wasmSource:await read('../dist/isomorphic/module.wasm'),manifest,surface:'direct'});
let accepted=0,refused=0;
try {
 for(const [code,start,end] of [['sws',0,9],['swa',9,10],['sfe',10,11]])for(const prefix of ['plan','parse']) {
  const methodId=prefix+'_'+code,inputs=prefix==='plan'?[tick]:responses.slice(start,end);
  const baseline=await h.invoke({methodId,inputs});assert.equal(baseline.statusCode,0,baseline.errorMessage);
  const output=r=>r.outputs.map(o=>[o.portId,Buffer.from(o.payload)]);
  for(const configured of [[empty,...inputs],[...inputs,empty]]) {
   const result=await h.invoke({methodId,inputs:configured});assert.equal(result.statusCode,0,result.errorMessage);assert.deepEqual(output(result),output(baseline));accepted++;
  }
  const invalid=[['JSON',config(Buffer.from('{}'))],['truncated MCFG',config(encodeModuleConfig({}).subarray(0,9))],['unsupported settings',config(encodeModuleConfig({url:'https://invalid.example'}))],['wrong FlatBuffer',config(tick.payload)]];
  for(const [label,bad] of invalid) {
   const result=await h.invoke({methodId,inputs:[...inputs,bad]});assert.notEqual(result.statusCode,0,methodId+' '+label);assert.equal(result.outputs.length,0);refused++;
  }
  const duplicate=await h.invoke({methodId,inputs:[empty,...inputs,empty]});assert.notEqual(duplicate.statusCode,0);assert.equal(duplicate.outputs.length,0);refused++;
  const recovered=await h.invoke({methodId,inputs});assert.equal(recovered.statusCode,0,recovered.errorMessage);assert.deepEqual(output(recovered),output(baseline));
 }
 console.log(`PASS typed MCFG: 6 methods, ${accepted} equivalent configured calls, ${refused} invalid configs refused`);
} finally {await h.destroy();}

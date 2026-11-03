import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createBrowserModuleHarness} from 'space-data-module-sdk/host/browser-module';
import {encodeHttpResponse} from 'space-data-module-sdk/runtime-contracts';
const manifest=JSON.parse(await fs.readFile(new URL('../plugin-manifest.json',import.meta.url)));
const sources=JSON.parse(await fs.readFile(new URL('./fixtures/provenance.json',import.meta.url))).slice(0,9);
const bodies=await Promise.all(sources.map(s=>fs.readFile(new URL('./fixtures/'+s.file,import.meta.url))));
const frame=(i,body=bodies[i],status=200)=>{const payload=encodeHttpResponse({url:sources[i].url,status,body,retrievedMs:Date.parse(sources[i].retrieved_at)});return {portId:'response',payload,typeRef:{schemaName:'HttpResponse.fbs',fileIdentifier:'HRSP',rootTypeName:'HttpResponse',wireFormat:'flatbuffer',byteLength:payload.length}};};
const valid=sources.map((_,i)=>frame(i));const h=await createBrowserModuleHarness({wasmSource:await fs.readFile(new URL('../dist/isomorphic/module.wasm',import.meta.url)),manifest,surface:'direct'});
try{
 const mutations=[['missing source',valid.slice(1)],['duplicate source',[valid[1],...valid.slice(1)]],['304',[frame(0,Buffer.alloc(0),304),...valid.slice(1)]],['invalid JSON',[frame(0,Buffer.from('[')),...valid.slice(1)]],['empty body',[frame(0,Buffer.alloc(0)),...valid.slice(1)]]];
 for(const [label,mutate] of [['unknown quantity',a=>{a[0].unexpected_measurement=42;}],['invalid date',a=>{a[0].time_tag='2026-02-30T00:00:00';}],['bad flag type',a=>{a[0].active='yes';}]]){const a=JSON.parse(bodies[0]);mutate(a);mutations.push([label,[frame(0,Buffer.from(JSON.stringify(a))),...valid.slice(1)]]);}
 for(const [label,inputs]of mutations){const r=await h.invoke({methodId:'parse_sws',inputs});assert.notEqual(r.statusCode,0,label);assert.equal(r.outputs.length,0,label+' emits nothing');}
 const good=await h.invoke({methodId:'parse_sws',inputs:valid});assert.equal(good.statusCode,0,good.errorMessage);console.log(`PASS ${mutations.length} malformed/incomplete batches refused; subsequent valid batch succeeds`);
}finally{await h.destroy();}

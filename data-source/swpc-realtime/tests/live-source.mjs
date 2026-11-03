// Optional live source acceptance, separate from deterministic CID-readback E2E.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createBrowserModuleHarness} from 'space-data-module-sdk/host/browser-module';
import {encodeHttpResponse,decodeIngestRequest} from 'space-data-module-sdk/runtime-contracts';
const list=JSON.parse(await fs.readFile(new URL('./fixtures/provenance.json',import.meta.url)));
const inputs=await Promise.all(list.map(async s=>{const r=await fetch(s.url,{signal:AbortSignal.timeout(90000)});assert.equal(r.status,200,s.url);const body=new Uint8Array(await r.arrayBuffer());const payload=encodeHttpResponse({url:s.url,status:200,body,retrievedMs:Date.now()});return {portId:'response',payload,typeRef:{schemaName:'HttpResponse.fbs',fileIdentifier:'HRSP',rootTypeName:'HttpResponse',wireFormat:'flatbuffer',byteLength:payload.length}};}));
const h=await createBrowserModuleHarness({wasmSource:await fs.readFile(new URL('../dist/isomorphic/module.wasm',import.meta.url)),manifest:JSON.parse(await fs.readFile(new URL('../plugin-manifest.json',import.meta.url))),surface:'direct'});
try{for(const [code,a,b]of [['SWS',0,9],['SWA',9,10],['SFE',10,11]]){const r=await h.invoke({methodId:'parse_'+code.toLowerCase(),inputs:inputs.slice(a,b)});assert.equal(r.statusCode,0,r.errorMessage);const m=decodeIngestRequest(r.outputs.find(o=>o.portId==='meta').payload);console.log('PASS full live '+code+' '+m.provenance.normalizedCount+' records');}}finally{await h.destroy();}

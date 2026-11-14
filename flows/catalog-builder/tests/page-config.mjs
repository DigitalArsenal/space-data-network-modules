import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as fb from 'flatbuffers';
import {PIV} from 'spacedatastandards.org/lib/js/PIV/PIV.js';
import * as Q from 'spacedatastandards.org/lib/js/QRP/main.js';
import {createBrowserModuleHarness} from 'space-data-module-sdk/host/browser-module';
import {encodeModuleConfig,encodeHostCallResult} from 'space-data-module-sdk/runtime-contracts';

export async function verifyPageConfig(){
 const manifest=JSON.parse(fs.readFileSync(new URL('../../../hostcap/flatsql-query/plugin-manifest.json',import.meta.url)));
 const wasm=new URL('../dist/flow/flatsql-query/dist/isomorphic/module.wasm',import.meta.url);
 const pack=(x,prefix=false)=>{const b=new fb.Builder(256);prefix?b.finishSizePrefixed(x.pack(b),'$QRP'):b.finish(x.pack(b),'$QRP');return Buffer.from(b.asUint8Array());};
 const frame=(portId,payload,config=false)=>({portId,payload,typeRef:{schemaName:config?'ModuleConfig.fbs':'QRP.fbs',fileIdentifier:config?'MCFG':'$QRP',rootTypeName:config?'ModuleConfig':'QRP',wireFormat:'flatbuffer'}});
 let calls=0,observed;
 const instantiate=WebAssembly.instantiate;
 WebAssembly.instantiate=async(source,imports)=>{
  let memory,response;
  const host={...imports.space_data_module_host,call(_op,_opSize,pointer,size){
   const wire=PIV.getRootAsPIV(new fb.ByteBuffer(new Uint8Array(memory.buffer,pointer,size).slice())).unpack().REQUEST;
   assert.equal(wire.METHOD_ID,'storage.index_page');++calls;
   const tab=wire.INPUTS.find(p=>p.PORT_ID==='request');
   observed=Q.QRP.getRootAsQRP(new fb.ByteBuffer(Uint8Array.from(wire.PAYLOAD_ARENA.slice(tab.OFFSET,tab.OFFSET+tab.SIZE)))).unpack();
   const header=Object.assign(new Q.QRPT(),{KIND:Q.qrpKind.Page,STATUS:Q.qrpStatus.Ok,RECORD_COUNT:0});
   response=encodeHostCallResult({ok:true,op:'storage.flatsql_query_stream',raw:{stream:pack(header,true)}});return 0;
  },response_len:()=>response.length,read_response(pointer,size){const n=Math.min(size,response.length);new Uint8Array(memory.buffer).set(response.subarray(0,n),pointer);return n;}};
  const result=await instantiate(source,{...imports,space_data_module_host:host});memory=(result.instance??result).exports.memory;return result;
 };
 let h;
 try{h=await createBrowserModuleHarness({wasmSource:fs.readFileSync(wasm),manifest,surface:'direct'});}finally{WebAssembly.instantiate=instantiate;}

 const request=frame('query',pack(Object.assign(new Q.QRPT(),{KIND:Q.qrpKind.Request,SCHEMA_NAME:'CAT.fbs',LIMIT:100,MAX_BYTES:8388608n})));
 try{
  const configured=await h.invoke({methodId:'index_page',inputs:[request,frame('config',encodeModuleConfig({limit:3,max_bytes:4096}),true)]});
  assert.equal(configured.statusCode,0,configured.errorMessage);assert.equal(calls,1);assert.equal(observed.LIMIT,3);assert.equal(Number(observed.MAX_BYTES),4096);
  for(const config of [{limit:0},{limit:1001},{limit:1.5},{max_bytes:11},{max_bytes:8388609},{limit:'3'},{unknown:1}]){
   const refused=await h.invoke({methodId:'index_page',inputs:[request,frame('config',encodeModuleConfig(config),true)]});assert.notEqual(refused.statusCode,0);assert.equal(calls,1,'invalid settings are refused before host access');
  }
 }finally{h.destroy();}
}

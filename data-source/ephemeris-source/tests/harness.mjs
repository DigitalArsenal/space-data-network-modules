// Shared test plumbing on the typed contracts (1.0). $SRG frames are built and read through the SDS TypeScript bindings
// (lib/ts/SRG, bundled once with esbuild: SRG is newer than the published JS lib); HttpResponse frames through the SDK's
// runtime contracts. nativeFixture runs the WasmEdge-lane host adapter under node:wasi with a space_data_module_host
// that answers typed $PIV hostcalls: decodeHostCall -> the test's handler -> encodeHostCallResult.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {WASI} from 'node:wasi';
import {build} from 'esbuild';
import * as flatbuffers from 'flatbuffers';
import {encodePluginInvokeRequest,decodePluginInvokeResponse} from 'space-data-module-sdk/invoke';
import {decodeHostCall,encodeHostCallResult,encodeHttpResponse,encodeModuleConfig,encodeTimerTick} from 'space-data-module-sdk/runtime-contracts';
const require=createRequire(import.meta.url);
export const moduleRoot=fileURLToPath(new URL('..',import.meta.url));
export const standardsRoot=path.dirname(require.resolve('spacedatastandards.org/package.json'));
export const fixtures=JSON.parse(fs.readFileSync(new URL('fixtures/discovery.json',import.meta.url)));
export const manifest=JSON.parse(fs.readFileSync(new URL('../plugin-manifest.json',import.meta.url)));
export const wasm=fs.readFileSync(new URL('../dist/isomorphic/module.wasm',import.meta.url));

// lib/ts/SRG/main.ts does not (yet) re-export the SRG tables themselves, so the entry names their files.
const tsDir=path.join(standardsRoot,'lib/ts/SRG');
const bundle=path.join(os.tmpdir(),`ephemeris-srg-v2-${fs.statSync(path.join(tsDir,'SRG.ts')).mtimeMs}.mjs`);
if(!fs.existsSync(bundle))await build({stdin:{contents:['SRG','SRGProvider','SRGResource','SRGContentReceipt','SRGRetrievalSettings','SRGRetrievalStatus','srgRetrievalState'].map((f)=>`export * from ${JSON.stringify(path.join(tsDir,f+'.ts'))};`).join('\n'),resolveDir:tsDir,loader:'ts'},
  bundle:true,format:'esm',platform:'node',outfile:bundle,nodePaths:[path.join(moduleRoot,'node_modules')],logLevel:'silent'});
export const sds=await import(pathToFileURL(bundle));
export const TYPE={
 SRG:{schemaName:'SRG.fbs',fileIdentifier:'$SRG',rootTypeName:'SRG',wireFormat:'flatbuffer'},
 HRSP:{schemaName:'HttpResponse.fbs',fileIdentifier:'HRSP',rootTypeName:'HttpResponse',wireFormat:'flatbuffer'},
 NCD:{schemaName:'NCD.fbs',fileIdentifier:'$NCD',rootTypeName:'NCD',wireFormat:'flatbuffer'},
 TICK:{schemaName:'TimerTick.fbs',fileIdentifier:'TICK',rootTypeName:'TimerTick',wireFormat:'flatbuffer'},
};
// One size-prefixed $SRG from object-API fields.
export function srg({settings,resources,receipts,status}={}) {
 const t=new sds.SRGT();
 if(settings)t.SETTINGS=Object.assign(new sds.SRGRetrievalSettingsT(),settings);
 if(resources)t.RESOURCES=resources.map((r)=>Object.assign(new sds.SRGResourceT(),r));
 if(receipts)t.RECEIPTS=receipts.map((r)=>Object.assign(new sds.SRGContentReceiptT(),r));
 if(status)t.STATUS=Object.assign(new sds.SRGRetrievalStatusT(),status);
 const b=new flatbuffers.Builder(1024);b.finishSizePrefixed(t.pack(b),'$SRG');return b.asUint8Array().slice();
}
export const readSrg=(bytes)=>{const b=Uint8Array.from(bytes);assert(new TextDecoder().decode(b.subarray(8,12))==='$SRG','not a size-prefixed $SRG');return sds.SRG.getSizePrefixedRootAsSRG(new flatbuffers.ByteBuffer(b)).unpack();};
function assert(ok,message){if(!ok)throw new Error(message);}
export const STATE=sds.srgRetrievalState;
export const srgPort=(portId,fields)=>({portId,typeRef:TYPE.SRG,payload:srg(fields)});
export const settingsPort=(source_id,epoch_seconds=fixtures.epoch_seconds)=>srgPort('settings',{settings:{SOURCE_ID:source_id,EPOCH_MS:BigInt(epoch_seconds)*1000n}});
export const responsePort=(portId,url,body,{status=200,context,headers={}}={})=>({portId,typeRef:TYPE.HRSP,payload:encodeHttpResponse({url,status,headers,body:typeof body==='string'?new TextEncoder().encode(body):new Uint8Array(body),context,retrievedMs:Date.UTC(2026,8,9)})});
// The HttpResponses of a fixture source's listings (discovery.json keeps them keyed by URL).
export const listingPorts=(responses)=>Object.entries(responses).map(([url,r])=>responsePort('responses',url,r.body_encoding==='base64'?Buffer.from(r.body,'base64'):r.body??'',{status:r.status??200}));
// A resource's HttpResponse: CONTEXT its job ($SRG with that one resource).
export const jobResponse=(resource,body)=>responsePort('response',resource.URL??'https://example.invalid/',body,{context:srg({resources:[resource]})});
export const outputs=(r,p)=>r.outputs.filter((x)=>x.portId===p);
export const statusOf=(r)=>{if(r.statusCode!==0)throw new Error(r.errorMessage);return readSrg(outputs(r,'status')[0].payload).STATUS;};
export const tick=()=>({portId:'tick',typeRef:TYPE.TICK,payload:encodeTimerTick({triggerId:'ephemeris-pull',firedMs:Date.UTC(2026,8,9)})});

// The WasmEdge-lane adapter under node:wasi. handler(op, call) answers {result, raw, lists} (or throws, which the
// module sees as a failed hostcall); plugin.getConfig gets a plain object and is encoded as one ModuleConfig.
export async function nativeFixture(handler) {
 const wasi=new WASI({version:'preview1',args:[],env:{},returnOnExit:true});let instance,response=new Uint8Array(0);
 const memory=()=>new Uint8Array(instance.exports.memory.buffer);
 const host={
  call(opPtr,opLen,ptr,len){
   let call;
   try{call=decodeHostCall(memory().slice(ptr,ptr+len));let answer=handler(call.op,call);
    if(call.op==='plugin.getConfig')answer={raw:{config:encodeModuleConfig(answer??{})}};
    response=encodeHostCallResult({ok:true,op:call.op,...(answer??{})});}
   catch(error){response=encodeHostCallResult({ok:false,error:{code:'failed',message:String(error.message)}});}
   return 0;
  },
  response_len(){return response.length;},
  read_response(dst,n){const m=Math.min(n,response.length);memory().set(response.subarray(0,m),dst);return m;},
 };
 const binary=fs.readFileSync(new URL('../host-adapter/dist/isomorphic/module.wasm',import.meta.url));
 instance=(await WebAssembly.instantiate(binary,{wasi_snapshot_preview1:wasi.wasiImport,space_data_module_host:host})).instance;
 wasi.start(instance);const e=instance.exports;
 return {invoke(request){const bytes=encodePluginInvokeRequest(request),p=e.plugin_alloc(bytes.length),n=e.plugin_alloc(4);new Uint8Array(e.memory.buffer,p,bytes.length).set(bytes);const r=e.plugin_invoke_stream(p,bytes.length,n);const size=new DataView(e.memory.buffer).getUint32(n,true);const result=decodePluginInvokeResponse(new Uint8Array(e.memory.buffer,r,size).slice());e.plugin_free(p,bytes.length);e.plugin_free(n,4);e.plugin_free(r,size);return result;}};
}

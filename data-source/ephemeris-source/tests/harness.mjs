import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {WASI} from 'node:wasi';
import {encodePluginInvokeRequest,decodePluginInvokeResponse} from 'space-data-module-sdk/invoke';
const require=createRequire(import.meta.url);
const sdk=path.resolve(path.dirname(require.resolve('space-data-module-sdk')),'..');
const {createHostcallBridge}=await import(pathToFileURL(path.join(sdk,'src/host/abi.js')));
export const moduleRoot=fileURLToPath(new URL('..',import.meta.url));
export const fixtures=JSON.parse(fs.readFileSync(new URL('fixtures/discovery.json',import.meta.url)));
export const manifest=JSON.parse(fs.readFileSync(new URL('../plugin-manifest.json',import.meta.url)));
export const wasm=fs.readFileSync(new URL('../dist/isomorphic/module.wasm',import.meta.url));
export const input=(portId,value)=>{const payload=value instanceof Uint8Array?value:Buffer.from(JSON.stringify(value));return {portId,payload,typeRef:{wireFormat:'aligned-binary',requiredAlignment:1,byteLength:payload.length}};};
export const output=(r,p)=>JSON.parse(Buffer.from(r.outputs.find(x=>x.portId===p).payload));
// Node WASI integration fixture. Browser/native parity is tested on the core.
export async function nativeFixture(dispatch) {
 const wasi=new WASI({version:'preview1',args:[],env:{},returnOnExit:true});let instance;
 const bridge=createHostcallBridge({dispatch,getMemory:()=>instance.exports.memory,maxRequestBytes:48*1024*1024,maxResponseBytes:48*1024*1024});
 const binary=fs.readFileSync(new URL('../host-adapter/dist/isomorphic/module.wasm',import.meta.url));
 instance=(await WebAssembly.instantiate(binary,{wasi_snapshot_preview1:wasi.wasiImport,...bridge.imports})).instance;
 wasi.start(instance);const e=instance.exports;
 return {invoke(request){const bytes=encodePluginInvokeRequest(request),p=e.plugin_alloc(bytes.length),n=e.plugin_alloc(4);new Uint8Array(e.memory.buffer,p,bytes.length).set(bytes);const r=e.plugin_invoke_stream(p,bytes.length,n);const size=new DataView(e.memory.buffer).getUint32(n,true);const result=decodePluginInvokeResponse(new Uint8Array(e.memory.buffer,r,size).slice());e.plugin_free(p,bytes.length);e.plugin_free(n,4);e.plugin_free(r,size);return result;}};
}

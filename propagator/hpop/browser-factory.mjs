// Diagnostic factory over the canonical SDK browser harness. All calculations
// run in dist/isomorphic/module.wasm; this file only adapts calling conventions.
import {createBrowserModuleHarness} from 'space-data-module-sdk/host/browser-module';
export default async function HPOPModule(options={}) {
  const wasmSource=options.wasmBinary??await(await fetch(new URL('module.wasm',import.meta.url))).arrayBuffer();
  const harness=await createBrowserModuleHarness({wasmSource,surface:'direct',sharedMemory:true});
  const exports=harness.instance.exports;
  exports.hpop_initialize?.();
  const api={asm:exports,__initialize:()=>exports.hpop_initialize?.(),__harness:harness};
  for(const [name,value] of Object.entries(exports)) if(typeof value==='function'){api[name]=value;api[`_${name}`]=value;}
  for(const [name,Type] of Object.entries({HEAPU8:Uint8Array,HEAP8:Int8Array,HEAPU32:Uint32Array,HEAP32:Int32Array,HEAPF32:Float32Array,HEAPF64:Float64Array}))Object.defineProperty(api,name,{get:()=>new Type(exports.memory.buffer)});
  api.UTF8ToString=ptr=>{const heap=api.HEAPU8;let end=ptr;while(heap[end])end++;return new TextDecoder().decode(heap.subarray(ptr,end));};
  api.lengthBytesUTF8=text=>new TextEncoder().encode(text).length;
  api.stringToUTF8=(text,ptr,max)=>{const bytes=new TextEncoder().encode(text);api.HEAPU8.set(bytes.subarray(0,max-1),ptr);api.HEAPU8[ptr+Math.min(bytes.length,max-1)]=0;};
  api.ccall=(name,resultType,argTypes=[],args=[])=>{
    const allocated=[];
    try {const actual=args.map((v,i)=>{if(argTypes[i]!=='string')return v;const bytes=new TextEncoder().encode(`${v}\0`);const ptr=exports.malloc(bytes.length);api.HEAPU8.set(bytes,ptr);allocated.push(ptr);return ptr;});const value=exports[name](...actual);return resultType==='string'?api.UTF8ToString(value):value;}
    finally{for(const ptr of allocated)exports.free(ptr);}
  };
  api.cwrap=(name,resultType,argTypes)=>(...args)=>api.ccall(name,resultType,argTypes,args);
  return api;
}

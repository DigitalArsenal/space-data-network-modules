import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import {loadModule} from 'space-data-module-sdk/host/isomorphic';

const require=createRequire(import.meta.url);
const summarize=r=>({status:r.statusCode,error:r.errorMessage||'',outputs:(r.outputs||[]).map(o=>({port:o.portId,type:o.typeRef,sha256:createHash('sha256').update(o.payload).digest('hex')}))});

// Same bytes and fixed source responses on the real headless browser and native WasmEdge.
// Docker is waived by the owner, 2026-10-22. This function never starts it.
// `config`: the node config the module's plugin.getConfig answers on both legs (default none).
export async function runtimeParity({wasmPath,manifest,cases,evidence,config}) {
 const bundle=path.join(evidence,'browser-harness.js');
 await build({stdin:{contents:`export {createBrowserModuleHarness} from 'space-data-module-sdk/host/browser-module';`,resolveDir:path.dirname(require.resolve('space-data-module-sdk')),sourcefile:'parity-entry.js'},bundle:true,format:'esm',platform:'browser',outfile:bundle});
 const assets=new Map([['/module.wasm',await fs.readFile(wasmPath)],['/harness.js',await fs.readFile(bundle)]]);
 const descriptions=cases.map((c,i)=>({...c,inputs:c.inputs.map((f,j)=>{const url=`/case-${i}-${j}.bin`;assets.set(url,Buffer.from(f.payload));return {...f,payload:undefined,url};})}));
 const server=http.createServer((req,res)=>{res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Embedder-Policy','require-corp');if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Space weather runtime parity</title>');return;}const bytes=assets.get(req.url);res.statusCode=bytes?200:404;res.setHeader('Content-Type',req.url.endsWith('.js')?'text/javascript':'application/octet-stream');res.end(bytes);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 let browser,native;
 try {
  browser=await chromium.launch({headless:true}); // Playwright defaults to Chromium headless shell.
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const actual=await page.evaluate(async({manifest,cases,config})=>{
   if(!crossOriginIsolated||typeof SharedArrayBuffer==='undefined')throw Error('Browser lacks COOP/COEP and SharedArrayBuffer');
   const {createBrowserModuleHarness}=await import('/harness.js');
   const harness=await createBrowserModuleHarness({wasmSource:new Uint8Array(await(await fetch('/module.wasm')).arrayBuffer()),manifest,surface:'direct',...(config?{hostOptions:{config}}:{})});
   const results=[];
   try{for(const c of cases){const inputs=await Promise.all(c.inputs.map(async({url,...f})=>({...f,payload:new Uint8Array(await(await fetch(url)).arrayBuffer())})));const r=await harness.invoke({...c,inputs});const outputs=[];for(const o of r.outputs||[]){const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',o.payload));outputs.push({port:o.portId,type:o.typeRef,sha256:Array.from(hash,b=>b.toString(16).padStart(2,'0')).join('')});}results.push({status:r.statusCode,error:r.errorMessage||'',outputs});}}finally{await harness.destroy();}return results;
  },{manifest,cases:descriptions,config});
  assert.deepEqual(errors,[],'Headless browser errors');
  native=await loadModule({wasmSource:wasmPath,manifest,runtimeKind:'wasmedge',surface:'direct',...(config?{config}:{})});
  for(let i=0;i<cases.length;i++)assert.deepEqual(summarize(await native.invoke(cases[i])),actual[i],`Browser/native parity: ${cases[i].methodId} case ${i}`);
  return {status:'PASS',cases:cases.length,browser:'Chromium headless shell',native:'WasmEdge',docker:'WAIVED: owner ruling 2026-10-22',outputs:actual};
 } finally {if(native)await native.destroy();if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
}

// Browser replay of exact real-source encoder frames. This is runtime parity;
// it does not substitute for the separately owned console interaction checks.
import fs from 'node:fs';import path from 'node:path';import http from 'node:http';
import os from 'node:os';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(new URL('../../../files/geotiff/package.json',import.meta.url));
const {build}=require('esbuild');const {chromium}=require('playwright-core');
const [scratch]=process.argv.slice(2);assert.ok(scratch&&!scratch.startsWith('/tmp/'));
const root=fileURLToPath(new URL('../../terrain-source/',import.meta.url));
const resolveDir=fileURLToPath(new URL('../../../files/geotiff/',import.meta.url));
const frames=JSON.parse(fs.readFileSync(path.join(scratch,'frames.json')));
const executablePath=process.env.HEADLESS_SHELL;assert.match(executablePath??'',/chrome-headless-shell$/);
const entry=`import {createBrowserModuleHarness} from 'space-data-module-sdk/host/browser-module';
window.run=async()=>{
 const get=async p=>{const r=await fetch(p);if(!r.ok)throw Error(p+': '+r.status);return new Uint8Array(await r.arrayBuffer());};
 const manifest=await(await fetch('/manifest.json')).json();
 const h=await createBrowserModuleHarness({wasmSource:await get('/module.wasm'),manifest,surface:'direct'});
 try{
 const frames=${JSON.stringify(frames)};const inputs=[];for(const f of frames)inputs.push({portId:f.portId,typeRef:f.typeRef,payload:await get('/'+f.file)});
 const r=await h.invoke({methodId:'tile',inputs});if(r.statusCode!==0)throw Error(r.errorMessage);
 const got=Uint8Array.from(r.outputs.find(o=>o.portId==='records').payload),expected=await get('/records.bin');
 if(got.length!==expected.length||got.some((v,i)=>v!==expected[i]))throw Error('browser packed records differ');
 const result={crossOriginIsolated,identicalBytes:got.length,pass:true};document.body.textContent=JSON.stringify(result,null,2);return result;
 }finally{await h.destroy();}
};`;
const bundle=await build({stdin:{contents:entry,resolveDir},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
const files=new Map([['/module.wasm',path.join(root,'dist/parity/module.wasm')],['/manifest.json',path.join(root,'plugin-manifest.json')],['/records.bin',path.join(scratch,'records.bin')],...frames.map(f=>['/'+f.file,path.join(scratch,f.file)])]);
const server=http.createServer((req,res)=>{
 res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Embedder-Policy','require-corp');
 if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end('<!doctype html><body><script type="module" src="/bundle.js"></script>');}
 if(req.url==='/bundle.js'){res.setHeader('Content-Type','text/javascript');return res.end(bundle.outputFiles[0].contents);}
 const file=files.get(req.url);if(!file){res.statusCode=404;return res.end();}res.end(fs.readFileSync(file));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
try{
 browser=await chromium.launch({headless:true,executablePath});const page=await browser.newPage();const errors=[],failures=[];
 page.on('pageerror',e=>errors.push(String(e)));page.on('requestfailed',r=>failures.push(r.url()));page.on('response',r=>{if(r.status()>=400)failures.push(r.url());});
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>typeof window.run==='function');
 const report=await page.evaluate(()=>window.run());assert.deepEqual(errors,[]);assert.deepEqual(failures,[]);
 const screenshot=path.join(scratch,'browser.png');await page.screenshot({path:screenshot});
 const evidence={...report,errors,failures,screenshot,load:os.loadavg(),docker:'waived by owner 2026-10-22'};
 fs.writeFileSync(path.join(scratch,'browser.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
}finally{await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));}

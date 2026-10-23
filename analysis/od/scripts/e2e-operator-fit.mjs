#!/usr/bin/env node
// Public SpaceX MEME: EME2000 km/km/s, UTC. Fit criterion: median < .6 km,
// compared with the owner's 2026-10-10 .6–.75 km 72-h fit. Not prediction truth.
// JS orchestrates WASM and computes statistics; raw ephemerides never leave RAM.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import * as fb from 'flatbuffers';
import {OCM} from 'spacedatastandards.org/lib/js/OCM/OCM.js';
import {loadModule} from 'space-data-module-sdk/host/isomorphic';
import {headlessShell} from '../../../propagator/ffm/tests/lib/headlessShell.mjs';
import {environment,configuration,fil,dcl} from './operator-environment.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),wasmPath=path.join(root,'dist/isomorphic/module.wasm');
const reportPath=process.env.OD_REPORT||path.join(root,'.build-operator/e2e.json');
const limit=Number(process.env.OD_FIXTURE_LIMIT||25);
const dir=process.env.OD_FIXTURES||'/opt/data/sdn-archive/hac/starlink-ephemerides/sample-20261009';
const names=fs.readdirSync(dir).filter(n=>n.endsWith('.txt')&&n.startsWith('MEME_')).sort().slice(0,limit);
assert.equal(names.length,limit,'Required public fixtures unavailable');
const wasm=fs.readFileSync(wasmPath),manifest=JSON.parse(fs.readFileSync(path.join(root,'plugin-manifest.json')));
const report={status:'RUNNING',sha256:createHash('sha256').update(wasm).digest('hex'),rows:[],docker:'WAIVED by owner 2026-10-22',freshFilePrediction:'Not measured: historical fixture corpus has one issuance per satellite; fit RMS is forecast reproduction only.'};
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'operator-fit-e2e-'));
let server,browser,native;
const save=()=>{fs.mkdirSync(path.dirname(reportPath),{recursive:true});fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');};
function decoded(response){assert.equal(response.statusCode,0,response.errorMessage);return response.outputs.filter(o=>o.portId==='ocm').map(o=>{const c=OCM.getSizePrefixedRootAsOCM(new fb.ByteBuffer(o.payload)).unpack();return {record:c,user:Object.fromEntries(c.USER_DEFINED_PARAMETERS.map(p=>[p.PARAM_NAME,p.PARAM_VALUE]))};});}
try{
 const env=await environment();report.weather=env.provenance;console.log('Environment parsed through EOP and space-weather WASM');
 const bundle=await build({stdin:{contents:'export {createBrowserModuleHarness} from "space-data-module-sdk/host/browser-module";',resolveDir:root},bundle:true,format:'esm',platform:'browser',write:false});
 const assets=new Map([['/module.wasm',wasm],['/harness.js',bundle.outputFiles[0].contents]]);
 server=http.createServer((req,res)=>{res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Embedder-Policy','require-corp');if(req.url==='/'){res.end('<!doctype html><title>Operator fit E2E</title>');return;}const b=assets.get(req.url);res.statusCode=b?200:404;res.setHeader('Content-Type',req.url.endsWith('.js')?'text/javascript':'application/octet-stream');res.end(b);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 browser=await chromium.launch({headless:true,executablePath:headlessShell()});const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.evaluate(async manifest=>{if(!crossOriginIsolated)throw Error('COI required');const {createBrowserModuleHarness}=await import('/harness.js');window.make=async config=>createBrowserModuleHarness({wasmSource:new Uint8Array(await(await fetch('/module.wasm')).arrayBuffer()),manifest,surface:'direct',hostOptions:{config}});},manifest);
 const run=async(request,config)=>{
  const descriptors=request.inputs.map((f,i)=>{const url=`/input-${i}`;assets.set(url,f.payload);return {...f,payload:undefined,url};});
  return page.evaluate(async({descriptors,config})=>{const h=await window.make(config);try{const inputs=[];for(const {url,...f} of descriptors)inputs.push({...f,payload:new Uint8Array(await(await fetch(url)).arrayBuffer())});const r=await h.invoke({methodId:'fit_ffm',inputs});return {...r,outputs:r.outputs.map(o=>({...o,payload:Array.from(o.payload)}))};}finally{await h.destroy();}},{descriptors,config}).then(r=>({...r,outputs:r.outputs.map(o=>({...o,payload:new Uint8Array(o.payload)}))}));
 };
 const config={sampleSeconds:600,maxIterations:12,ballisticPrior:.02,dataSource:'SpaceX public MEME'};
 for(const name of names){
  const bytes=fs.readFileSync(path.join(dir,name));const text=bytes.toString('utf8');const match=/ephemeris_start:(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)/.exec(text);assert(match,'MEME start metadata');const epoch=match[1]+'T'+match[2];
  const base={methodId:'fit_ffm',inputs:[fil(bytes,name),configuration(epoch),...env.inputs]};
  for(const correction of [false,true]){
   const request=correction?{...base,inputs:[...base.inputs,dcl(epoch,0.6931471805599453)]}:base;
   const start=performance.now(),result=await run(request,config),elapsed=(performance.now()-start)/1000;
   const segments=decoded(result);const row={file:name,dca:correction?'constant ln(2) mechanics':'absent',wallSeconds:elapsed,segments:segments.map(s=>({rmsKm:Number(s.user.FIT_RMS_KM),ballistic:Number(s.user.B_EFF_M2_KG),kappa:Number(s.user.KAPPA_GIVEN_B_PRIOR),samples:s.record.ORBIT_DETERMINATION.OBS_USED,formalCovariance:!!s.user.FORMAL_COVARIANCE_LTM}))};
   report.rows.push(row);console.log(JSON.stringify(row));save();
   if(name===names[0]&&!correction){
    const refused=await run(base,{...config,fitWindowSeconds:172801});assert.notEqual(refused.statusCode,0);assert.match(refused.errorMessage,/blend-join/);report.joinRefusal='PASS';
    native=await loadModule({wasmSource:wasmPath,manifest,runtimeKind:'wasmedge',surface:'direct',config});
    const other=await native.invoke(request);const hashes=r=>r.outputs.map(o=>[o.portId,createHash('sha256').update(o.payload).digest('hex')]);assert.equal(other.statusCode,0,other.errorMessage);assert.deepEqual(hashes(other),hashes(result));report.parity='byte-identical headless browser/native WasmEdge';await native.destroy();native=null;
   }
  }
 }
 assert.deepEqual(errors,[]);
 for(const dca of ['absent','constant ln(2) mechanics']){const rms=report.rows.filter(r=>r.dca===dca).flatMap(r=>r.segments.map(s=>s.rmsKm)).sort((a,b)=>a-b);const median=rms[Math.floor(rms.length/2)];assert(median<.6,`${dca}: median ${median} km`);(report.medians??={})[dca]=median;}
 const aot=execFileSync(process.env.SDN_NODE_BINARY||'/opt/data/sdn-archive/bin/spacedatanetwork',['prewarm-aot','--cache-dir',path.join(scratch,'aot'),'--flow',wasmPath],{encoding:'utf8',timeout:180000,maxBuffer:8*1024*1024});assert(!/FAILED|Not implemented instructions/.test(aot));report.aot='PASS exact artifact, node WasmEdge 0.16.4';
 assert(report.maneuverSegmentation==='PASS','Planted-maneuver segmentation evidence is required');
 report.status='PASS';
}catch(error){report.status='FAIL';report.error=error.stack;throw error;}
finally{await native?.destroy();await browser?.close();if(server?.listening)await new Promise(resolve=>server.close(resolve));fs.rmSync(scratch,{recursive:true,force:true});save();}

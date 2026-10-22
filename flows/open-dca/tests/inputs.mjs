// Local evidence only: raw operator inputs are kept in a private temp directory.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
export const modules=fileURLToPath(new URL('../../../',import.meta.url));
export const require=createRequire(path.join(modules,'data-source/operator-states-public/package.json'));
export const {createBrowserModuleHarness}=await import(pathToFileURL(require.resolve('space-data-module-sdk/host/browser-module')));
export const {encodeTimerTick,decodeHttpRequest,encodeHttpResponse}=await import(pathToFileURL(require.resolve('space-data-module-sdk/runtime-contracts')));
export const {Builder,ByteBuffer}=require('flatbuffers');
export const S=await import(pathToFileURL(require.resolve('spacedatastandards.org/lib/js/DCL/main.js')));
export const input=(portId,payload,schemaName,fileIdentifier,rootTypeName)=>({portId,payload,typeRef:{schemaName,fileIdentifier,rootTypeName,wireFormat:'flatbuffer'}});
export async function load(folder,wasmFile){const manifest=JSON.parse(await fs.readFile(path.join(modules,folder,'plugin-manifest.json')));const harness=await createBrowserModuleHarness({wasmSource:await fs.readFile(wasmFile||path.join(modules,folder,'dist/isomorphic/module.wasm')),manifest,surface:'direct'});return {harness,manifest,async call(methodId,inputs){const r=await harness.invoke({methodId,inputs});assert.equal(r.statusCode,0,`${folder}/${methodId}: ${r.errorMessage}`);return r;},destroy:()=>harness.destroy()};}
export async function capture(dir){
 await fs.mkdir(dir,{recursive:true});let info;
 try{info=JSON.parse(await fs.readFile(path.join(dir,'capture.json')));return info;}catch(e){if(e.code!=='ENOENT')throw e;}
 const issue=Date.now(),groups=[];
 for(const [name,folder,methodId]of [['operator','data-source/operator-states-public','plan_operator'],['weather','data-source/space-weather','plan_weather']]){
  const m=await load(folder);try{const r=await m.call(methodId,[input('tick',encodeTimerTick({triggerId:'daily',firedMs:issue}),'TimerTick.fbs','TICK','TimerTick')]);const requests=r.outputs.map(o=>decodeHttpRequest(o.payload));groups.push({name,requests:requests.length});
   for(const [i,q]of requests.entries()){
    const file=path.join(dir,`${name}-${i}.fb`);let exists=false;try{await fs.access(file);exists=true;}catch{}
    if(exists)continue;
    const response=await fetch(q.url,{headers:q.headers,signal:AbortSignal.timeout(90000)});assert.equal(response.status,200,q.url);
    const body=Buffer.from(await response.arrayBuffer());assert(body.length<=Number(q.maxBytes||100e6));
    const payload=encodeHttpResponse({url:q.url,status:200,headers:Object.fromEntries(response.headers),body,context:q.context,retrievedMs:issue});
    await fs.writeFile(file,payload);await fs.writeFile(path.join(dir,`${name}-${i}.raw`),body);
    console.log(`Captured ${name} ${i+1}/${requests.length}: ${body.length} bytes`);
    if(q.url.includes('ephemerides.planet-labs.com'))await new Promise(r=>setTimeout(r,3000));
   }
  }finally{await m.destroy();}
 }
 info={issue,groups};await fs.writeFile(path.join(dir,'capture.json'),JSON.stringify(info));return info;
}
export async function responses(dir,name,n){return Promise.all(Array.from({length:n},async(_,i)=>input('response',await fs.readFile(path.join(dir,`${name}-${i}.fb`)),'HttpResponse.fbs','HRSP','HttpResponse')));}
export async function prepare(dir){
 const info=await capture(dir),operator=await load('data-source/operator-states-public'),weather=await load('data-source/space-weather'),density=await load('analysis/density-calibration'),eop=await load('data-source/eop-parser',path.join(modules,'flows/open-dca/dist/transport/eop-parser/dist/isomorphic/module.wasm'));
 try{
  const parsed=await operator.call('parse_operator',await responses(dir,'operator',34));
  const converted=await density.call('prepare_operator_states',[{...parsed.outputs.find(o=>o.portId==='operator_states')}]);
  const eopParsed=await eop.call('parse_finals2000a',[{...parsed.outputs.find(o=>o.portId==='eop_response'),portId:'response'}]);
  const earth=await operator.call('wrap_eop',[eopParsed.outputs.find(o=>o.portId==='records')]);
  const weatherParsed=await weather.call('parse_weather',await responses(dir,'weather',4));
  const spw=await operator.call('wrap_weather',[weatherParsed.outputs.find(o=>o.portId==='records')]);
  const inputs=[...converted.outputs,...earth.outputs,...spw.outputs,parsed.outputs.find(o=>o.portId==='kernel')];
  for(const [i,f]of inputs.entries())await fs.writeFile(path.join(dir,`fit-${i}.fb`),f.payload);
  await fs.writeFile(path.join(dir,'fit-frames.json'),JSON.stringify(inputs.map(({payload,...f},i)=>({...f,file:`fit-${i}.fb`}))));
  console.log(`Prepared ${converted.outputs.length} private state series and typed weather/EOP/kernel`);return {info,inputs};
 }finally{for(const m of [operator,weather,density,eop])await m.destroy();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await prepare(process.argv[2]);

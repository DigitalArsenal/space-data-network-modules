import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {ByteBuffer} from 'flatbuffers';
import {createBrowserModuleHarness} from 'space-data-module-sdk/host/browser-module';
import {encodeTimerTick,decodeHttpRequest,encodeHttpResponse,decodeIngestRequest} from 'space-data-module-sdk/runtime-contracts';
import {localNode} from './local-node.mjs';
import {nativePublication} from './native-publication.mjs';
import {hash,verifySws,verifySwa,verifyFlares} from './source-oracle.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),require=createRequire(import.meta.url);
const sds=path.dirname(require.resolve('spacedatastandards.org/package.json'));
const types={};for(const code of ['SWS','SWA','SFE'])types[code]=(await import(pathToFileURL(path.join(sds,'lib/js',code,code+'.js'))))[code];
const fixture=path.join(root,'tests/fixtures'),provenance=JSON.parse(await fs.readFile(path.join(fixture,'provenance.json')));
const sources=await Promise.all(provenance.map(async p=>({...p,bytes:await fs.readFile(path.join(fixture,p.file))})));
for(const s of sources)assert.equal(hash(s.bytes),s.sha256);
const input=(portId,payload,schemaName,fileIdentifier,rootTypeName)=>({portId,payload,typeRef:{schemaName,fileIdentifier,rootTypeName,wireFormat:'flatbuffer',byteLength:payload.length}});
const responses=sources.map(s=>input('response',encodeHttpResponse({url:s.url,status:200,body:s.bytes,retrievedMs:Date.parse(s.retrieved_at)}),'HttpResponse.fbs','HRSP','HttpResponse'));
function frames(bytes){bytes=Buffer.from(bytes);const a=[];for(let i=0;i<bytes.length;){const n=bytes.readUInt32LE(i);assert(n>8&&i+n+4<=bytes.length);a.push(bytes.subarray(i,i+n+4));i+=n+4;}return a;}
function decode(b,c){return types[c]['getSizePrefixedRootAs'+c](new ByteBuffer(b)).unpack();}
const binary=process.env.SDN_NODE_BINARY??path.join(root,'tests/bin/spacedatanetwork');
let h,node;const stats={};
try{
 try{await fs.access(path.join(root,'tests/fixture-flow/runtime/runtime.wasm'));const replay=JSON.parse(await fs.readFile(path.join(root,'tests/fixture-flow/runtime/plugin-manifest.json')));assert.equal(replay.version,JSON.parse(await fs.readFile(path.join(root,'plugin-manifest.json'))).version);}catch{
  await new Promise((resolve,reject)=>{const p=spawn(process.execPath,[path.resolve(root,'../../flows/swpc-realtime/build.mjs'),'--unsigned','--fixtures'],{stdio:'inherit'});p.once('error',reject);p.once('exit',c=>c===0?resolve():reject(Error('Fixture flow build failed')));});
 }
 h=await createBrowserModuleHarness({wasmSource:await fs.readFile(path.join(root,'dist/isomorphic/module.wasm')),manifest:JSON.parse(await fs.readFile(path.join(root,'plugin-manifest.json'))),surface:'direct'});
 for(const [code,start,end]of [['sws',0,9],['swa',9,10],['sfe',10,11]]){
  const plan=await h.invoke({methodId:'plan_'+code,inputs:[input('tick',encodeTimerTick({triggerId:'minute',firedMs:1}),'TimerTick.fbs','TICK','TimerTick')]});assert.equal(plan.statusCode,0,plan.errorMessage);assert.deepEqual(plan.outputs.map(o=>decodeHttpRequest(o.payload).url),sources.slice(start,end).map(s=>s.url));
 }
 node=await localNode(binary);
 node.config.publishing={enabled:false};node.config.flows.enabled=false;
 await node.start();
 async function add(b){const f=new FormData();f.append('file',new Blob([b]),'record.fb');const r=await fetch(node.rpc+'/api/v0/add?pin=true&cid-version=1',{method:'POST',body:f,signal:AbortSignal.timeout(30000)});assert.equal(r.status,200);return JSON.parse((await r.text()).trim()).Hash;}
 async function cat(cid){const r=await fetch(node.rpc+'/api/v0/cat?arg='+encodeURIComponent(cid),{method:'POST',signal:AbortSignal.timeout(30000)});assert.equal(r.status,200);return Buffer.from(await r.arrayBuffer());}
 for(const [code,start,end,check]of [['SWS',0,9,verifySws],['SWA',9,10,verifySwa],['SFE',10,11,verifyFlares]]){
  const inputs=responses.slice(start,end);const result=await h.invoke({methodId:'parse_'+code.toLowerCase(),inputs});assert.equal(result.statusCode,0,result.errorMessage);
  const meta=decodeIngestRequest(result.outputs.find(o=>o.portId==='meta').payload);assert.equal(meta.schema,code+'.fbs');assert.equal(meta.tags.providerId,'space-weather');assert.equal(meta.tags.sourceName,'noaa-swpc-rt');
  const actual=[];for(const bytes of frames(result.outputs.find(o=>o.portId==='records').payload)){const cid=await add(bytes),back=await cat(cid);assert.deepEqual(back,bytes);actual.push(decode(back,code));}
  stats[code]=check(actual,code==='SWS'?sources.slice(0,9):sources[start]);console.log(`PASS ${code} native-node CID readback ${JSON.stringify(stats[code])}`);
  const invalid=inputs.slice();invalid[0]=input('response',encodeHttpResponse({url:sources[start].url,status:200,body:Buffer.from('truncated'),retrievedMs:1}),'HttpResponse.fbs','HRSP','HttpResponse');const refusal=await h.invoke({methodId:'parse_'+code.toLowerCase(),inputs:invalid});assert.notEqual(refusal.statusCode,0);assert(!refusal.outputs.some(o=>o.portId==='records'));
 }
 await node.stop();node=null;
 const published=await nativePublication(root,binary);
 stats.publishedSWS=verifySws(frames(published.records.SWS).map(b=>decode(b,'SWS')),sources.slice(0,9));
 stats.publishedSWA=verifySwa(frames(published.records.SWA).map(b=>decode(b,'SWA')),sources[9]);
 stats.publishedSFE=verifyFlares(frames(published.records.SFE).map(b=>decode(b,'SFE')),sources[10]);
 console.log('PASS scheduled native flow -> signed SWS/SWA/SFE lanes -> CID readback '+JSON.stringify(published.cids));
 console.log('PASS swpc-realtime '+JSON.stringify(stats));
}catch(e){process.exitCode=1;console.error('FAIL '+e.stack);}finally{if(h)await h.destroy();if(node)await node.stop();}
process.exit(process.exitCode??0);

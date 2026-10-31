// The composed flow, drained in this process: the artifact the node runs, one timer tick, every source answered from local copies, nothing published. Ten Doves over eight days keep it
// to a few dozen arcs. What a module's own E2E cannot see, its stack and memory as linked into the flow, and the path from the tick to the record, are exercised here.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {modules,require,input,encodeTimerTick,decodeHttpResponse,S,ByteBuffer} from './inputs.mjs';
const {createFlowRuntimeHost}=await import(pathToFileURL(require.resolve('space-data-module-sdk/flow')));
const {createHostcallBridge}=await import(pathToFileURL(path.resolve(path.dirname(require.resolve('space-data-module-sdk/flow')),'../host/abi.js')));
const DOVES=['4001','250a','251b','251e','2501','252d','2538','253b','253c','300b'],PUBLIC_DAYS=8,H=3600000,D=24*H;
const dayName=(ms)=>new Date(ms).toISOString().slice(0,10).replaceAll('-','');
// `planet(day)`: the day's last copy, or null. `published`: day -> Last-Modified.
export async function composedRun({runtimeDir,fixture,planet,published,kernelFile,config,publicDays=PUBLIC_DAYS}){
 const {issue}=JSON.parse(await fs.readFile(path.join(fixture,'capture.json')));
 const answers=new Map();
 for(const name of ['eop-0','weather-0','weather-1','weather-2','weather-3','weather-4']){const r=decodeHttpResponse(await fs.readFile(path.join(fixture,`${name}.fb`)));answers.set(r.url,{status:r.status,headers:r.headers,body:r.body});}
 answers.set('https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/planets/de440s.bsp',{status:200,headers:{},body:await fs.readFile(kernelFile)});
 const newest=Math.floor(issue/D)*D-D;
 for(let k=0;k<33;k++){
  const day=dayName(newest-k*D),bytes=k<publicDays?await planet(day):null,url=`https://ephemerides.planet-labs.com/planet_${day}.states`;
  answers.set(url,bytes?{status:200,headers:{'last-modified':published[day]},body:Buffer.from(bytes.toString().split('\n').filter(l=>DOVES.includes(l.trim().split(/\s+/)[0]?.toLowerCase())).join('\n')+'\n')}:{status:403,headers:{},body:Buffer.alloc(0)});
 }
 answers.set(`https://ephemerides.planet-labs.com/planet_${dayName(issue)}.states`,{status:403,headers:{},body:Buffer.alloc(0)});
 const asked=[];let records=null,memory=null;
 const dispatch=(op,params)=>{
  if(op==='plugin.getConfig')return config??{};
  if(op==='http.request'){asked.push(params.url);const a=answers.get(params.url);return a?{status:a.status,url:params.url,headers:a.headers,body:a.body}:{status:404,url:params.url,headers:{},body:new Uint8Array(0)};}
  if(op==='storage.ingest_with_source'){records=params.records;return {};}
  throw new Error(`host operation ${op} is not expected of this flow`);
 };
 const bridge=createHostcallBridge({dispatch,getMemory:()=>memory,maxRequestBytes:64<<20,maxResponseBytes:128<<20});
 const manifest=JSON.parse(await fs.readFile(path.join(runtimeDir,'plugin-manifest.json')));
 const flow=await createFlowRuntimeHost({wasmSource:await fs.readFile(path.join(runtimeDir,'runtime.wasm')),manifest,runtimeTarget:null,extraImports:bridge.imports});
 memory=flow.memory;
 assert(memory,'the flow host exposes its memory');
 flow.enqueueTriggerFrame(0,{bytes:encodeTimerTick({triggerId:'daily',firedMs:issue}),portId:'tick',alignment:8,wireFormat:'flatbuffer'});
 await flow.drain({'sdn.flow.egress:emit':async()=>({statusCode:0})},{maxIterations:1000});
 const nodes=[];for(let i=0;i<flow.nodeCount;i++){const state=flow.getNodeState(i);nodes.push({nodeId:flow.getNodeDispatchDescriptor(i).nodeId,status:state.lastStatus,invocations:Number(state.invocationCount)});}
 return {issue,asked,records,nodes};
}

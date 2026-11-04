import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {createFlowRuntimeHost} from 'space-data-module-sdk/flow';
import {encodeTimerTick} from 'space-data-module-sdk/runtime-contracts';
const require=createRequire(import.meta.url);
export async function flowReplay(root,expected){
 await new Promise((resolve,reject)=>{const p=spawn(process.execPath,[path.resolve(root,'../../flows/lvdb-source/build.mjs'),'--unsigned','--fixtures'],{stdio:'inherit'});p.once('error',reject);p.once('exit',c=>c===0?resolve():reject(Error('Fixture flow build '+c)));});
 const {createHostcallBridge}=await import(pathToFileURL(path.resolve(path.dirname(require.resolve('space-data-module-sdk/flow')),'../host/abi.js')));
 let memory;const calls=[];const bridge=createHostcallBridge({dispatch:(op,params)=>{assert.equal(op,'storage.ingest_with_source');calls.push(params);return {};},getMemory:()=>memory,maxRequestBytes:64<<20,maxResponseBytes:64<<20});
 const dir=path.join(root,'tests/fixture-flow/runtime');const flow=await createFlowRuntimeHost({wasmSource:await fs.readFile(path.join(dir,'runtime.wasm')),manifest:JSON.parse(await fs.readFile(path.join(dir,'plugin-manifest.json'))),runtimeTarget:null,extraImports:bridge.imports});memory=flow.memory;
 flow.enqueueTriggerFrame(0,{bytes:encodeTimerTick({triggerId:'minute',firedMs:1}),portId:'tick',alignment:8,wireFormat:'flatbuffer'});
 await flow.drain({'sdn.flow.egress:emit':async()=>({statusCode:0})},{maxIterations:1000});
 for(let i=0;i<flow.nodeCount;i++){const state=flow.getNodeState(i);assert.equal(state.lastStatus,0,flow.getNodeDispatchDescriptor(i).nodeId);assert.equal(Number(state.invocationCount),1);}
 assert.equal(calls.length,1);assert.equal(calls[0].schema,'SSY.fbs');assert.equal(calls[0].provider_id,'lvdb');assert.equal(calls[0].source_name,'comb-all');assert.deepEqual(Buffer.from(calls[0].records),Buffer.from(expected));
 console.log('PASS composed retrieval flow: 7 nodes, release marker + 4 sources, 1727 SSY records at typed storage boundary');
}

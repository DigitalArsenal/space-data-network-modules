import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createFlowRuntimeHost} from 'space-data-module-sdk/flow';
import {encodeTimerTick} from 'space-data-module-sdk/runtime-contracts';
const require=createRequire(import.meta.url),root=fileURLToPath(new URL('../',import.meta.url));
const {createHostcallBridge}=await import(pathToFileURL(path.resolve(path.dirname(require.resolve('space-data-module-sdk/flow')),'../host/abi.js')));
let memory;const calls=[];const bridge=createHostcallBridge({dispatch:(op,params)=>{assert.equal(op,'storage.ingest_with_source');calls.push(params);return {};},getMemory:()=>memory,maxRequestBytes:64<<20,maxResponseBytes:64<<20});
const dir=path.join(root,'tests/fixture-flow/runtime');const flow=await createFlowRuntimeHost({wasmSource:await fs.readFile(path.join(dir,'runtime.wasm')),manifest:JSON.parse(await fs.readFile(path.join(dir,'plugin-manifest.json'))),runtimeTarget:null,extraImports:bridge.imports});memory=flow.memory;
flow.enqueueTriggerFrame(0,{bytes:encodeTimerTick({triggerId:'minute',firedMs:1}),portId:'tick',alignment:8,wireFormat:'flatbuffer'});
await flow.drain({'sdn.flow.egress:emit':async()=>({statusCode:0})},{maxIterations:1000});
for(let i=0;i<flow.nodeCount;i++){const state=flow.getNodeState(i);assert.equal(state.lastStatus,0,flow.getNodeDispatchDescriptor(i).nodeId);assert.equal(Number(state.invocationCount),1);}
assert.deepEqual(calls.map(c=>c.schema).sort(),['SFE.fbs','SWA.fbs','SWS.fbs']);

console.log('PASS composed replay flow: 15 nodes, 9 SWS responses, 1 SWA response, 1 SFE response, 3 storage ingests');

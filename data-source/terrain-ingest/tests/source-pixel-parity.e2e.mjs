// Real Pluto source bytes through shipped, no-host-bridge parity, and native
// WasmEdge artifacts. Store exact typed frames for the real-browser replay.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';import {fileURLToPath} from 'node:url';
import {createBrowserModuleHarness} from 'space-data-module-sdk/testing';
import {loadModule} from 'space-data-module-sdk/host/isomorphic';
import {createRasterLane} from '../flow-bodies.mjs';
const [configPath,scratch]=process.argv.slice(2);assert.ok(scratch);fs.mkdirSync(scratch,{recursive:true});
const cfg=JSON.parse(fs.readFileSync(configPath));
const root=fileURLToPath(new URL('../../terrain-source/',import.meta.url));
const manifest=JSON.parse(fs.readFileSync(path.join(root,'plugin-manifest.json')));
let inputs;
const lane=await createRasterLane(cfg,{onTileInputs:x=>{inputs=x;}});
let records;
try {records=await lane.tile([{level:7,x:240,y:64,childAvailability:0}]);}finally{await lane.destroy();}
const frames=inputs.map((x,i)=>{const file=`input-${i}.bin`;fs.writeFileSync(path.join(scratch,file),x.payload);return {...x,payload:undefined,file};});
fs.writeFileSync(path.join(scratch,'records.bin'),records);fs.writeFileSync(path.join(scratch,'frames.json'),JSON.stringify(frames));
const checks=[];
for(const native of [false,true]) {
 const wasmPath=path.join(root,'dist/parity/module.wasm');
 const h=native?await loadModule({wasmSource:wasmPath,runtimeKind:'wasmedge',surface:'command',enableThreads:true,wasmEdgeBinary:process.env.WASMEDGE_BINARY??`${process.env.HOME}/.wasmedge/bin/wasmedge`}):await createBrowserModuleHarness({wasmSource:fs.readFileSync(wasmPath),manifest,surface:'direct'});
 try {const r=await h.invoke({methodId:'tile',inputs});assert.equal(r.statusCode,0,r.errorMessage);const bytes=Buffer.from(r.outputs.find(o=>o.portId==='records').payload);assert.deepEqual(bytes,records);checks.push({runtime:native?'wasmedge':'parity-browser-harness',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}finally{await h.destroy();}
}
fs.writeFileSync(path.join(scratch,'parity.json'),JSON.stringify({pass:true,checks,docker:'waived by owner 2026-10-22'},null,2));console.log(JSON.stringify({pass:true,checks}));

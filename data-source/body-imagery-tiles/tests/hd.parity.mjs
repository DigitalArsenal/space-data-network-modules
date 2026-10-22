// The new operation on the SAME artifact in real headless Chromium and native WasmEdge.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {encodeHttpResponse,encodeModuleConfig} from 'space-data-module-sdk/runtime-contracts';
import {runParityHarness,formatParityReport} from 'space-data-module-sdk/testing';
const work=process.env.HD_E2E_WORK;if(!work)throw Error('HD_E2E_WORK required');
const type=(s,id,r)=>({schemaName:s,fileIdentifier:id,rootTypeName:r,wireFormat:'flatbuffer'});
const unit={source:'moon-lo-uvvis',level:9,row:283,x:454,tiles:1};
const body=Buffer.from(Array.from({length:65536},(_,i)=>32+i%192));
const cases=[];
for(const [id,u] of [['moon-window',unit],['ctx-window',{source:'mars-ctx-mc13',level:13,row:4930,x:11700,tiles:1}],['protected-level',{...unit,level:8}]])cases.push({id,request:{methodId:'tiles_window',inputs:[{portId:'unit',typeRef:type('ModuleConfig.fbs','MCFG','ModuleConfig'),payloadBase64:Buffer.from(encodeModuleConfig(u)).toString('base64')},{portId:'rows_0',typeRef:type('HttpResponse.fbs','HRSP','HttpResponse'),payloadBase64:Buffer.from(encodeHttpResponse({status:200,body})).toString('base64')}]}});
const fixture=path.join(work,'hd-parity-fixture.json');fs.writeFileSync(fixture,JSON.stringify({name:'HD bounded windows; owner Docker waiver',threadCounts:[1],config:{jpeg_quality:95,retrieved_at:'2026-10-22T00:00:00.000Z'},cases}));
const report=await runParityHarness({wasmPath:fileURLToPath(new URL('../dist/isomorphic/module.wasm',import.meta.url)),fixturePath:fixture,lanes:['browser','wasmedge'],surface:'direct',wasmEdgeRunnerBinary:path.join(work,'native-wasi-runner'),chromeBinary:process.env.SDM_CHROME_BINARY,timeoutMs:60000,autoBuildDockerImage:false});
fs.writeFileSync(path.join(work,'hd-parity.json'),JSON.stringify(report,null,2)+'\n');console.log(formatParityReport(report));process.exit(report.ok?0:1);

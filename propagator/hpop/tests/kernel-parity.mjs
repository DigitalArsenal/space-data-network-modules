// Same byte payload through browser/V8, native WasmEdge, container WasmEdge.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as flatbuffers from 'flatbuffers';
import { NCD } from 'spacedatastandards.org/lib/js/NCD/NCD.js';
import { ncdContainerFormat } from 'spacedatastandards.org/lib/js/NCD/ncdContainerFormat.js';
import { normalizeParityFixture, runParityHarness, formatParityReport } from 'space-data-module-sdk/testing';
const kernel=fs.readFileSync(new URL('../../../files/orbit-products/tests/fixtures/de440/de440-2026.bsp',import.meta.url));
const builder=new flatbuffers.Builder(128);
NCD.startNCD(builder);NCD.addFormat(builder,ncdContainerFormat.SPK_DAF);NCD.addSourceByteLength(builder,BigInt(kernel.length));
NCD.finishSizePrefixedNCDBuffer(builder,NCD.endNCD(builder));
const frame=Buffer.concat([builder.asUint8Array(),kernel]);
const request=(operation,params,useKernel=true)=>({methodId:'invoke',inputs:[
  {portId:'request',typeRef:{schemaName:'orbpro.hpop.InvokeRequest',rootTypeName:'InvokeRequest'},payloadHex:Buffer.from(JSON.stringify({operation,params})).toString('hex')},
  ...(useKernel?[{portId:'kernel',typeRef:{schemaName:'NCD.fbs',fileIdentifier:'$NCD',rootTypeName:'NCD'},payloadHex:frame.toString('hex')}]:[])
]});
const propagation={epochJD:2461041.5,targetJD:2461041.5+60/86400,position:[7000,0,0],velocity:[0,7.5,1],forces:{j2:false,thirdBody:true,srp:true}};
const cases=[
  ...[10,301,5].map(target=>({id:`de440-target-${target}`,request:request('ephemeris',{target,center:399,epochTDBJD:2461041.5})})),
  {id:'de440-out-of-coverage',request:request('ephemeris',{target:10,center:399,epochTDBJD:2451545})},
  {id:'de440-propagation',request:request('propagate',propagation)},
  {id:'analytical-propagation',request:request('propagate',propagation,false)},
];
const plan=await normalizeParityFixture({name:'TMPL lane01 HPOP diagnostic CMake artifact',cases});
const report=await runParityHarness({wasmPath:fileURLToPath(new URL('../dist/isomorphic/module.wasm',import.meta.url)),plan,timeoutMs:60000,log:console.log});
console.log(formatParityReport(report));
assert.equal(report.ok,true,JSON.stringify(report.failures));

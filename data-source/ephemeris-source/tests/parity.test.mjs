import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';import {createHash} from 'node:crypto';
import * as flatbuffers from 'flatbuffers';
import {NCD} from 'spacedatastandards.org/lib/js/NCD/NCD.js';
import {decodePluginInvokeResponse} from 'space-data-module-sdk/invoke';
import {defaultParityLaneRunners,normalizeParityFixture,runParityHarness,formatParityReport} from 'space-data-module-sdk/testing';
import {fixtures,input,moduleRoot} from './harness.mjs';
// The raw file the NCD descriptor describes. Its SHA-256 and length are computed
// here, independently of the module, so every lane is held to the same answer.
const RAW_BODY=Buffer.from('CCSDS_OEM_VERS = 2.0\nCOMMENT fixture body preserved exactly\n');
test('identical source discovery bytes in browser, native and container WasmEdge',{skip:process.env.SDN_RUN_EPHEMERIS_PARITY!=='1'},async()=>{
 const wire=(port,value)=>{const f=input(port,value);return {portId:port,typeRef:f.typeRef,payloadBase64:Buffer.from(f.payload).toString('base64')};};
 const cases=Object.entries(fixtures.responses).map(([source_id,responses])=>({id:source_id,request:{methodId:'discover_sources',inputs:[wire('config',{source_id,epoch_seconds:fixtures.epoch_seconds}),wire('responses',responses)]},expect:'ok'}));
 for(const source_id of Object.keys(fixtures.responses))cases.push({id:'plan-'+source_id,request:{methodId:'plan_source_requests',inputs:[wire('config',{source_id,epoch_seconds:fixtures.epoch_seconds})]},expect:'ok'});
 cases.push({id:'raw-ncd',request:{methodId:'describe_artifact',inputs:[wire('resource',{source_id:'iss',url:'https://nasa-public-data.s3.amazonaws.com/iss-coords/current/ISS_OEM/ISS.OEM_J2K_EPH.txt',resource_id:'ISS.OEM_J2K_EPH.txt',format:'ccsds-oem-kvn'}),wire('receipt',{cid:'bafkreifixture'}),wire('body',RAW_BODY)]},expect:'ok'});
 cases.push({id:'declared-coverage',request:{methodId:'describe_coverage',inputs:[wire('resource',{format:'ccsds-oem-kvn'}),wire('body',Buffer.from('CCSDS_OEM_VERS = 2.0\nMETA_START\nOBJECT_ID = 1998-067-A\nOBJECT_NAME = ISS\nMETA_STOP\n'))]},expect:'ok'});
 for(const format of ['tle','eumetsat-tle-js']) {const lines=['1 99301U 26099A   26252.00000000  .00000000  00000+0  31250-4 0  0002','2 99301  98.2411 120.4417 0001234  77.1203 283.0412 14.30210042    05'];const body=Buffer.from(format==='tle'?lines.join('\n'):lines.map(line=>'sga1_TLE[i++] = '+JSON.stringify(line)+';').join('\n'));cases.push({id:'coverage-'+format,request:{methodId:'describe_coverage',inputs:[wire('resource',{format}),wire('body',body)]},expect:'ok'});}
 // Keep each lane's response bytes as well, so the descriptor is checked in what
 // every runtime emitted and not only in their agreement.
 const observed=[];
 const laneRunners=Object.fromEntries(Object.entries(defaultParityLaneRunners).map(([lane,runner])=>[lane,async(context)=>{const runs=await runner(context);observed.push(...runs.map(run=>({...run,lane})));return runs;}]));
 const plan=await normalizeParityFixture({name:'ephemeris-source',threadCounts:[1],cases});const report=await runParityHarness({wasmPath:path.join(moduleRoot,'dist/isomorphic/module.wasm'),plan,laneRunners,autoBuildDockerImage:false,timeoutMs:30000,log:console.log});console.log(formatParityReport(report));assert.equal(report.ok,true,formatParityReport(report));assert.equal(report.lanes.length,3);
 const ncdRuns=observed.filter(run=>run.caseId==='raw-ncd');
 assert.deepEqual(ncdRuns.map(run=>run.lane).sort(),['browser','docker-wasmedge','wasmedge']);
 for(const run of ncdRuns){
  const response=decodePluginInvokeResponse(run.stdout);assert.equal(response.statusCode,0,`${run.lane}: ${response.errorMessage}`);
  const descriptor=response.outputs.find(frame=>frame.portId==='descriptor').payload;
  const ncd=NCD.getSizePrefixedRootAsNCD(new flatbuffers.ByteBuffer(Uint8Array.from(descriptor)));
  assert.equal(ncd.SOURCE_SHA256(),createHash('sha256').update(RAW_BODY).digest('hex'),run.lane);
  assert.equal(ncd.SOURCE_BYTE_LENGTH(),BigInt(RAW_BODY.length),run.lane);
  assert.equal(ncd.SOURCE_CID(),'bafkreifixture',run.lane);
 }
});

import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';
import {normalizeParityFixture,runParityHarness,formatParityReport} from 'space-data-module-sdk/testing';
import {fixtures,input,moduleRoot} from './harness.mjs';
test('identical source discovery bytes in browser, native and container WasmEdge',{skip:process.env.SDN_RUN_EPHEMERIS_PARITY!=='1'},async()=>{
 const wire=(port,value)=>{const f=input(port,value);return {portId:port,typeRef:f.typeRef,payloadBase64:Buffer.from(f.payload).toString('base64')};};
 const cases=Object.entries(fixtures.responses).map(([source_id,responses])=>({id:source_id,request:{methodId:'discover_sources',inputs:[wire('config',{source_id,epoch_seconds:fixtures.epoch_seconds}),wire('responses',responses)]},expect:'ok'}));
 for(const source_id of Object.keys(fixtures.responses))cases.push({id:'plan-'+source_id,request:{methodId:'plan_source_requests',inputs:[wire('config',{source_id,epoch_seconds:fixtures.epoch_seconds})]},expect:'ok'});
 cases.push({id:'raw-ncd',request:{methodId:'describe_artifact',inputs:[wire('resource',{source_id:'iss',url:'https://nasa-public-data.s3.amazonaws.com/iss-coords/current/ISS_OEM/ISS.OEM_J2K_EPH.txt',resource_id:'ISS.OEM_J2K_EPH.txt',format:'ccsds-oem-kvn'}),wire('receipt',{cid:'bafkreifixture'}),wire('body',Buffer.from('CCSDS_OEM_VERS = 2.0\nCOMMENT fixture body preserved exactly\n'))]},expect:'ok'});
 cases.push({id:'declared-coverage',request:{methodId:'describe_coverage',inputs:[wire('resource',{format:'ccsds-oem-kvn'}),wire('body',Buffer.from('CCSDS_OEM_VERS = 2.0\nMETA_START\nOBJECT_ID = 1998-067A\nOBJECT_NAME = ISS\nMETA_STOP\n'))]},expect:'ok'});
 const plan=await normalizeParityFixture({name:'ephemeris-source',threadCounts:[1],cases});const report=await runParityHarness({wasmPath:path.join(moduleRoot,'dist/isomorphic/module.wasm'),plan,autoBuildDockerImage:false,timeoutMs:30000,log:console.log});console.log(formatParityReport(report));assert.equal(report.ok,true,formatParityReport(report));assert.equal(report.lanes.length,3);
});

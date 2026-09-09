import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { normalizeParityFixture, runParityHarness, formatParityReport } from 'space-data-module-sdk/testing';

test('the same artifact plans identical routes in browser and native/container WasmEdge', {skip:process.env.SDN_RUN_CLOUDFLARE_PARITY!=='1'}, async()=> {
  const snapshot={zoneId:'68ba799987854c13e1689f2dd15fc428',zoneName:'spacedatanetwork.org',now:1001,recordsComplete:true,records:[],managedRecordIds:{},nodes:[{peerId:'16Uiu2HAmCL9enDzrbxJS8xKjFXVYVogjtbaJw2KQc45EYE6KkzRL',included:true,profileVerified:true,originVerified:true,verifiedAt:1000,publicArtifactsOnly:true,originIpv4:'167.172.219.213'}]};
  const payloadUtf8=JSON.stringify(snapshot);
  const request={methodId:'plan',inputs:[{portId:'snapshot',payloadUtf8,typeRef:{wireFormat:'aligned-binary',requiredAlignment:1,byteLength:new TextEncoder().encode(payloadUtf8).length}}]};
  const plan=await normalizeParityFixture({name:'cloudflare-registrar',threadCounts:[1],cases:[{id:'verified-public-peer',request,expect:'ok'}]});
  const report=await runParityHarness({wasmPath:fileURLToPath(new URL('../dist/isomorphic/module.wasm',import.meta.url)),plan,autoBuildDockerImage:false,timeoutMs:30000,log:message=>console.log(message)});
  console.log(formatParityReport(report));
  assert.equal(report.ok,true,formatParityReport(report));assert.equal(report.lanes.length,3);
});

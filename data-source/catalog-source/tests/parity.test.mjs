import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { normalizeParityFixture, runParityHarness, formatParityReport } from 'space-data-module-sdk/testing';

test('the same parser artifact agrees in Chromium and native/container WasmEdge', {skip:process.env.SDN_RUN_CATALOG_PARITY !== '1'}, async () => {
  const source = '#JCAT\tSatcat\tName\tPiece\tType\tLDate\tPrimary\tPerigee\tPF\tApogee\tAF\tInc\tIF\nS40899\tNNA\tLuliang-1\t2015-049A\tP\t2015 Sep 19\tEarth\t500\t\t508\t\t97.46\t\n';
  const request = payloadUtf8 => ({methodId:'parse_gcat',inputs:[{portId:'source',payloadUtf8,typeRef:{wireFormat:'aligned-binary',requiredAlignment:1,byteLength:new TextEncoder().encode(payloadUtf8).length}}]});
  const plan = await normalizeParityFixture({name:'catalog-source',threadCounts:[1],cases:[
    {id:'native-key-with-no-norad',request:request(source),expect:'ok'},
    {id:'damaged-edition',request:request(source+'bad\trow\n'),expect:'ok'},
  ]});
  const report = await runParityHarness({wasmPath:fileURLToPath(new URL('../dist/isomorphic/module.wasm',import.meta.url)),plan,autoBuildDockerImage:false,timeoutMs:30000,log:message=>console.log(message)});
  console.log(formatParityReport(report));
  assert.equal(report.ok,true,formatParityReport(report));
  assert.equal(report.lanes.length,3);
});

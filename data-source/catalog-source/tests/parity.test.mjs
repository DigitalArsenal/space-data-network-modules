import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { normalizeParityFixture, runParityHarness, formatParityReport } from 'space-data-module-sdk/testing';

test('the same parser artifact agrees in Chromium and native/container WasmEdge', {skip:process.env.SDN_RUN_CATALOG_PARITY !== '1'}, async () => {
  const source = '#JCAT\tSatcat\tName\tPiece\tType\tLDate\tPrimary\tPerigee\tPF\tApogee\tAF\tInc\tIF\nS40899\tNNA\tLuliang-1\t2015-049A\tP\t2015 Sep 19\tEarth\t500\t\t508\t\t97.46\t\n';
  const request = payloadUtf8 => ({methodId:'parse_gcat',inputs:[{portId:'source',payloadUtf8,typeRef:{wireFormat:'aligned-binary',requiredAlignment:1,byteLength:new TextEncoder().encode(payloadUtf8).length}}]});
  const mccants = 'Prowler\n1 90007U 90097E   21305.13119867 0.00000000  00000-0  00000-0 0    01\n2 90007  14.4403 350.3137 0040735 245.2740 114.3135  1.00206833    00\n';
  const mccantsRequest = value => ({...request(value),methodId:'parse_mccants_tle_catalog'});
  const plan = await normalizeParityFixture({name:'catalog-source',threadCounts:[1],cases:[
    {id:'native-key-with-no-norad',request:request(source),expect:'ok'},
    {id:'damaged-edition',request:request(source+'bad\trow\n'),expect:'ok'},
    {id:'mccants-analyst-identity',request:mccantsRequest(mccants),expect:'ok'},
    {id:'mccants-truncated-edition',request:mccantsRequest(mccants+'Incomplete object\n'),expect:'ok'},
  ]});
  const report = await runParityHarness({wasmPath:fileURLToPath(new URL('../dist/isomorphic/module.wasm',import.meta.url)),plan,autoBuildDockerImage:false,timeoutMs:30000,log:message=>console.log(message)});
  if (process.env.CATALOG_PARITY_REPORT) await fs.writeFile(process.env.CATALOG_PARITY_REPORT,JSON.stringify(report,null,2)+'\n');
  console.log(formatParityReport(report));
  assert.equal(report.ok,true,formatParityReport(report));
  assert.equal(report.lanes.length,3);
});

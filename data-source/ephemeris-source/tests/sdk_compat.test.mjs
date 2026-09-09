import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {createBrowserModuleHarness} from 'space-data-module-sdk/host/browser-module';
import {validateArtifactWithStandards} from 'space-data-module-sdk/compliance';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fixtures,manifest,wasm,input,output,moduleRoot} from './harness.mjs';
const counts={'spacex-starlink':2,'eutelsat-oneweb':1,planet:2,iss:1,ses:1,intelsat:2,telesat:2,'css-tiangong':1,'gps-precise':1,'glonass-precise':1,'esa-pod':3,eumetsat:2,cpf:2};
const standardsRoot=path.dirname(createRequire(import.meta.url).resolve('spacedatastandards.org/package.json'));
for(const [source_id,responses] of Object.entries(fixtures.responses)) test(`discovers ${source_id} authoritative registry format`,async()=>{
 const h=await createBrowserModuleHarness({wasmSource:wasm,manifest,surface:'direct'});
 try {const r=await h.invoke({methodId:'discover_sources',inputs:[input('config',{source_id,epoch_seconds:fixtures.epoch_seconds}),input('responses',responses)]});assert.equal(r.statusCode,0,r.errorMessage);const resources=output(r,'resources');assert.equal(resources.length,counts[source_id]);assert.equal(new Set(resources.map(x=>x.url)).size,resources.length);assert.ok(resources.every(x=>x.source_id===source_id));if(source_id==='cpf')assert.ok(resources.some(x=>x.url.endsWith('_10.esa')));if(source_id==='gps-precise')assert.match(resources[0].url,/OPSULT_20262480600/);}
 finally{await h.destroy();}
});
test('core and adapter both satisfy published SDK and SDS contracts',async()=>{
 for(const prefix of ['', 'host-adapter/']) {const m=JSON.parse(fs.readFileSync(path.join(moduleRoot,prefix,'plugin-manifest.json')));const report=await validateArtifactWithStandards({wasmPath:path.join(moduleRoot,prefix,'dist/isomorphic/module.wasm'),manifest:m,standardsRoot});assert.equal(report.ok,true,JSON.stringify(report.errors));}
});
test('rejects a foreign source origin without emitting a descriptor',async()=>{
 const h=await createBrowserModuleHarness({wasmSource:wasm,manifest,surface:'direct'});
 try {const rejected=await h.invoke({methodId:'describe_artifact',inputs:[input('resource',{source_id:'iss',url:'https://foreign.example/file',format:'ccsds-oem-kvn'}),input('receipt',{cid:'testcid'}),input('body',Buffer.from('CCSDS_OEM_VERS = 2.0'))]});assert.notEqual(rejected.statusCode,0);assert.equal(rejected.outputs.length,0);const next=await h.invoke({methodId:'describe_sources',inputs:[]});assert.equal(next.statusCode,0);}finally{await h.destroy();}
});

// Declared object coverage: describe_coverage on a job's HttpResponse, and the adapter's backfill_coverage over archived
// $NCD descriptors (each file read back by CID through a typed ipfs.cat and checked against its descriptor).
import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserModuleHarness} from 'space-data-module-sdk/host/browser-module';
import {ByteBuffer} from 'flatbuffers';
import {CAT} from 'spacedatastandards.org/lib/js/CAT/main.js';
import {wasm,manifest,jobResponse,srgPort,nativeFixture,statusOf,STATE,TYPE,outputs} from './harness.mjs';
const cats=(bytes)=>{const out=[];for(let at=0;at<bytes.length;){const n=new DataView(bytes.buffer,bytes.byteOffset+at).getUint32(0,true)+4;out.push(CAT.getSizePrefixedRootAsCAT(new ByteBuffer(bytes.slice(at,at+n))));at+=n;}return out;};
// CCSDS OEM KVN metadata declares OBJECT_ID as the international designator.
test('publishes only international designators declared inside complete OEM metadata blocks',async(t)=>{
 const host=await createBrowserModuleHarness({wasmSource:wasm,manifest,surface:'direct'});t.after(()=>host.destroy());
 const body=Buffer.from('CCSDS_OEM_VERS = 2.0\nCOMMENT OBJECT_ID = 2020-001A\nMETA_START\nOBJECT_NAME = ISS\nOBJECT_ID = 1998-067-A\nMETA_STOP\nMETA_START\nOBJECT_ID = 25544\nMETA_STOP\nMETA_START\nOBJECT_ID = 2021-001B\n');
 const result=await host.invoke({methodId:'describe_coverage',inputs:[jobResponse({FORMAT:'ccsds-oem-kvn'},body)]});
 assert.equal(result.statusCode,0,result.errorMessage);
 const rows=cats(outputs(result,'catalog')[0].payload);assert.equal(rows.length,1);
 assert.equal(rows[0].OBJECT_ID(),'1998-067A');assert.equal(rows[0].NORAD_CAT_ID(),0);assert.equal(rows[0].OBJECT_NAME(),'ISS');
});

test('rebuilds coverage from a bounded, hash-verified archive page without fetching the provider',async(t)=>{
 const host=await createBrowserModuleHarness({wasmSource:wasm,manifest,surface:'direct'});t.after(()=>host.destroy());
 const body=Buffer.from('CCSDS_OEM_VERS = 2.0\nMETA_START\nOBJECT_NAME = ISS\nOBJECT_ID = 1998-067-A\nMETA_STOP\n');
 const resource={SOURCE_ID:'iss',URL:'https://nasa-public-data.s3.amazonaws.com/iss-coords/current/ISS_OEM/ISS.OEM_J2K_EPH.txt',RESOURCE_ID:'ISS.OEM_J2K_EPH.txt',FORMAT:'ccsds-oem-kvn'};
 const described=await host.invoke({methodId:'describe_artifact',inputs:[jobResponse(resource,body),srgPort('receipt',{receipts:[{CID:'bafkreifixture'}]})]});assert.equal(described.statusCode,0,described.errorMessage);
 const ncd=outputs(described,'descriptor')[0].payload;let corrupt=false,stored=0;
 const adapter=await nativeFixture((op,call)=>{
  if(op==='ipfs.cat'){assert.equal(call.params.CID,'bafkreifixture');return {raw:{data:corrupt?Buffer.from('corrupt'):body}};}
  if(op==='storage.ingest_with_source'){assert.equal(call.params.SCHEMA,'CAT.fbs');assert.equal(call.params.PROVIDER_ID,'ephemeris-provider:iss');assert.equal(call.params.SOURCE_NAME,'iss');assert.equal(call.params.SOURCE_URL,'ipfs://bafkreifixture');
   assert.equal(CAT.getSizePrefixedRootAsCAT(new ByteBuffer(call.raw.records)).OBJECT_ID(),'1998-067A');assert.equal(call.lists.provenance[0].PARSER_VERSION,'primary-object-coverage/0.2.0');stored++;return {result:{INSERTED:1n}};}
  throw Error('Unexpected capability '+op);
 });
 const descriptors={portId:'descriptors',typeRef:TYPE.NCD,payload:ncd};
 assert.equal(adapter.invoke({methodId:'configure',inputs:[srgPort('settings',{settings:{SOURCE_ID:'iss'}})]}).statusCode,0);
 let result=adapter.invoke({methodId:'backfill_coverage',inputs:[descriptors]});const s=statusOf(result);
 assert.deepEqual([s.SCANNED_COUNT,s.SUPPORTED_COUNT,s.NEXT_OFFSET,s.STATE,s.SOURCE_ID],[1,1,1,STATE.Complete,'iss']);assert.equal(stored,1);
 corrupt=true;result=adapter.invoke({methodId:'backfill_coverage',inputs:[descriptors]});assert.notEqual(result.statusCode,0);assert.match(result.errorMessage,/does not match/);assert.equal(stored,1);
 result=adapter.invoke({methodId:'backfill_coverage',inputs:[srgPort('page',{settings:{MAX_RESOURCES:5}}),descriptors]});assert.notEqual(result.statusCode,0);assert.equal(stored,1);
 corrupt=false;result=adapter.invoke({methodId:'backfill_coverage',inputs:[srgPort('page',{settings:{MAX_RESOURCES:1},status:{NEXT_OFFSET:7}}),descriptors]});
 assert.deepEqual([statusOf(result).NEXT_OFFSET,statusOf(result).STATE],[8,STATE.InProgress]);
});

test('extracts primary TLE international designators, verifies both checksums, and never uses numeric IDs as identities',async(t)=>{
 const host=await createBrowserModuleHarness({wasmSource:wasm,manifest,surface:'direct'});t.after(()=>host.destroy());
 const check=(line)=>{line=line.slice(0,68).padEnd(68);return line+[...line].reduce((sum,c)=>sum+(/\d/.test(c)?Number(c):c==='-'?1:0),0)%10;};
 const first=check('1 60481U 24149P   26252.19802083  .00000000  00000+0  84314-3 0    0'),second=check('2 60481 097.3714 336.1650 0001501 341.8259 059.4190 15.43694059    0');
 const duplicate=check(first.replace('60481','60519')),paired=check(second.replace('60481','60519'));
 const unresolved=check(first.replace('24149P  ','PLANET  '));
 for(const format of ['tle','eumetsat-tle-js']){
  const lines=[first,second,duplicate,paired,unresolved,second,first.slice(0,68)+(Number(first[68])+1)%10,second];
  const body=Buffer.from(format==='tle'?'0 FLOCK 4BE 7\n'+lines.join('\n'):lines.map((line)=>'sga1_TLE[i++] = '+JSON.stringify(line)+';').join('\n'));
  const result=await host.invoke({methodId:'describe_coverage',inputs:[jobResponse({FORMAT:format},body)]});assert.equal(result.statusCode,0,result.errorMessage);
  const rows=cats(outputs(result,'catalog')[0].payload);assert.equal(rows[0].OBJECT_ID(),'2024-149P');assert.equal(rows[0].NORAD_CAT_ID(),0);
 }
});

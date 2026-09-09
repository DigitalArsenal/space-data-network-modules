import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import { ByteBuffer } from 'flatbuffers';
import { CAT } from 'spacedatastandards.org/lib/js/CAT/main.js';
import { wasm,manifest,input } from './harness.mjs';
// CCSDS OEM KVN metadata declares OBJECT_ID as the international designator.
// These exact identity cases test metadata extraction, not orbital numerics.
test('publishes only international designators declared inside complete OEM metadata blocks',async t=>{
 const host=await createBrowserModuleHarness({wasmSource:wasm,manifest,surface:'direct'});t.after(()=>host.destroy());
 const body=Buffer.from('CCSDS_OEM_VERS = 2.0\nCOMMENT OBJECT_ID = 2020-001A\nMETA_START\nOBJECT_NAME = ISS\nOBJECT_ID = 1998-067-A\nMETA_STOP\nMETA_START\nOBJECT_ID = 25544\nMETA_STOP\nMETA_START\nOBJECT_ID = 2021-001B\n');
 const result=await host.invoke({methodId:'describe_coverage',inputs:[input('resource',{format:'ccsds-oem-kvn'}),input('body',body)]});
 assert.equal(result.statusCode,0,result.errorMessage);
 const bytes=result.outputs.find(o=>o.portId==='catalog').payload;
 assert.equal(new DataView(bytes.buffer,bytes.byteOffset).getUint32(0,true)+4,bytes.length);
 const record=CAT.getSizePrefixedRootAsCAT(new ByteBuffer(bytes));
 assert.equal(record.OBJECT_ID(),'1998-067A');assert.equal(record.NORAD_CAT_ID(),0);assert.equal(record.OBJECT_NAME(),'ISS');
});

test('rebuilds coverage from a bounded, hash-verified archive page without fetching the provider',async t=>{
 const {nativeFixture,output}=await import('./harness.mjs');
 const host=await createBrowserModuleHarness({wasmSource:wasm,manifest,surface:'direct'});t.after(()=>host.destroy());
 const body=Buffer.from('CCSDS_OEM_VERS = 2.0\nMETA_START\nOBJECT_NAME = ISS\nOBJECT_ID = 1998-067-A\nMETA_STOP\n');
 const resource={source_id:'iss',url:'https://nasa-public-data.s3.amazonaws.com/iss-coords/current/ISS_OEM/ISS.OEM_J2K_EPH.txt',resource_id:'ISS.OEM_J2K_EPH.txt',format:'ccsds-oem-kvn'};
 const descriptor=await host.invoke({methodId:'describe_artifact',inputs:[input('resource',resource),input('receipt',{cid:'bafkreifixture'}),input('body',body)]});assert.equal(descriptor.statusCode,0,descriptor.errorMessage);
 const ncd=descriptor.outputs.find(o=>o.portId==='descriptor').payload;let corrupt=false,stored=0;
 const adapter=await nativeFixture((op,p)=>{
  if(op==='ipfs.cat'){assert.equal(p.cid,'bafkreifixture');return {data:corrupt?Buffer.from('corrupt'):body};}
  if(op==='storage.ingest_with_source'){assert.equal(p.schema,'CAT.fbs');assert.equal(p.provider_id,'ephemeris-provider:iss');assert.equal(p.source_name,'iss');assert.equal(CAT.getSizePrefixedRootAsCAT(new ByteBuffer(p.records)).OBJECT_ID(),'1998-067A');stored++;return {inserted:1};}
  throw Error('Unexpected capability '+op);
 });
 assert.equal(adapter.invoke({methodId:'configure',inputs:[input('request',{ephemeris_source_id:'iss'})]}).statusCode,0);
 let result=adapter.invoke({methodId:'backfill_coverage',inputs:[{...input('descriptors',ncd),typeRef:{schemaName:'NCD.fbs',fileIdentifier:'$NCD',rootTypeName:'NCD'}}]});assert.equal(result.statusCode,0,result.errorMessage);assert.deepEqual(output(result,'status'),{scanned:1,supported_containers:1,next_offset:1,complete:true});assert.equal(stored,1);
 corrupt=true;result=adapter.invoke({methodId:'backfill_coverage',inputs:[{...input('descriptors',ncd),typeRef:{schemaName:'NCD.fbs',fileIdentifier:'$NCD',rootTypeName:'NCD'}}]});assert.notEqual(result.statusCode,0);assert.match(result.errorMessage,/does not match/);assert.equal(stored,1);
 result=adapter.invoke({methodId:'backfill_coverage',inputs:[input('request',{limit:5})]});assert.notEqual(result.statusCode,0);assert.equal(stored,1);
});

test('extracts primary TLE international designators, verifies both checksums, and never uses numeric IDs as identities',async t=>{
 const host=await createBrowserModuleHarness({wasmSource:wasm,manifest,surface:'direct'});t.after(()=>host.destroy());
 const check=line=>{line=line.slice(0,68).padEnd(68);return line+[...line].reduce((sum,c)=>sum+(/\d/.test(c)?Number(c):c==='-'?1:0),0)%10;};
 const first=check('1 60481U 24149P   26252.19802083  .00000000  00000+0  84314-3 0    0'),second=check('2 60481 097.3714 336.1650 0001501 341.8259 059.4190 15.43694059    0');
 const duplicate=check(first.replace('60481','60519')),paired=check(second.replace('60481','60519'));
 const unresolved=check(first.replace('24149P  ','PLANET  '));
 for(const format of ['tle','eumetsat-tle-js']){
  const lines=[first,second,duplicate,paired,unresolved,second,first.slice(0,68)+(Number(first[68])+1)%10,second];
  const body=Buffer.from(format==='tle'?'0 FLOCK 4BE 7\n'+lines.join('\n'):lines.map(line=>'sga1_TLE[i++] = '+JSON.stringify(line)+';').join('\n'));
  const result=await host.invoke({methodId:'describe_coverage',inputs:[input('resource',{format}),input('body',body)]});assert.equal(result.statusCode,0,result.errorMessage);
  const bytes=result.outputs.find(o=>o.portId==='catalog').payload;assert.equal(new DataView(bytes.buffer,bytes.byteOffset).getUint32(0,true)+4,bytes.length);
  const row=CAT.getSizePrefixedRootAsCAT(new ByteBuffer(bytes));assert.equal(row.OBJECT_ID(),'2024-149P');assert.equal(row.NORAD_CAT_ID(),0);
 }
});

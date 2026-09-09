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
 const body=Buffer.from('CCSDS_OEM_VERS = 2.0\nCOMMENT OBJECT_ID = 2020-001A\nMETA_START\nOBJECT_NAME = ISS\nOBJECT_ID = 1998-067A\nMETA_STOP\nMETA_START\nOBJECT_ID = 25544\nMETA_STOP\nMETA_START\nOBJECT_ID = 2021-001B\n');
 const result=await host.invoke({methodId:'describe_coverage',inputs:[input('resource',{format:'ccsds-oem-kvn'}),input('body',body)]});
 assert.equal(result.statusCode,0,result.errorMessage);
 const bytes=result.outputs.find(o=>o.portId==='catalog').payload;
 assert.equal(new DataView(bytes.buffer,bytes.byteOffset).getUint32(0,true)+4,bytes.length);
 const record=CAT.getSizePrefixedRootAsCAT(new ByteBuffer(bytes));
 assert.equal(record.OBJECT_ID(),'1998-067A');assert.equal(record.NORAD_CAT_ID(),0);assert.equal(record.OBJECT_NAME(),'ISS');
});

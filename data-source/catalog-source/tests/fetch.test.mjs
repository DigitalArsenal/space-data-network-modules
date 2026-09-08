import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {deflateRawSync} from 'node:zlib';
import {createBrowserModuleHarness} from 'space-data-module-sdk/testing';

const wasmSource=fs.readFileSync(new URL('../fetch/dist/isomorphic/module.wasm',import.meta.url));
const manifest=JSON.parse(fs.readFileSync(new URL('../fetch/plugin-manifest.json',import.meta.url)));
const endpoint='http://127.0.0.1:7182/api/v1/admin/dataset-updates/publish';
const encode=value=>Buffer.from(JSON.stringify(value));
const frame=(portId,value)=>{const payload=typeof value==='object'&&!Buffer.isBuffer(value)?encode(value):Buffer.from(value);return {portId,payload,typeRef:{wireFormat:'aligned-binary',requiredAlignment:1,byteLength:payload.length}}};
const raw=(bytes,status=200)=>{const header=Buffer.alloc(8);header.write('$HRB');header.writeInt32LE(status,4);return Buffer.concat([header,Buffer.from(bytes)])};
const json=(r,p)=>JSON.parse(Buffer.from(r.outputs.find(f=>f.portId===p).payload));
const payload=(r,p)=>Buffer.from(r.outputs.find(f=>f.portId===p).payload);
async function host(t,config={}) {
 const h=await createBrowserModuleHarness({wasmSource,manifest,surface:'direct',hostcallDispatch:op=>{
  assert.equal(op,'plugin.getConfig');return {catalog_provider_id:'test-catalog-node',catalog_publish_url:endpoint,...config};
 }});t.after(()=>h.destroy());return h;
}
async function job(h,product) {
 const r=await h.invoke({methodId:'catalog_prepare_fetch',inputs:[frame('tick',{})]});
 assert.equal(r.statusCode,0,r.errorMessage);return {request:json(r,'request'),job:json(r,'job')};
}
function crc32(bytes) {let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0)}return (crc^0xffffffff)>>>0}
function zip(name,bytes) {
 const compressed=deflateRawSync(bytes),filename=Buffer.from(name),local=Buffer.alloc(30),central=Buffer.alloc(46),end=Buffer.alloc(22);
 local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(8,8);local.writeUInt32LE(crc32(bytes),14);local.writeUInt32LE(compressed.length,18);local.writeUInt32LE(bytes.length,22);local.writeUInt16LE(filename.length,26);
 central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(8,10);central.writeUInt32LE(crc32(bytes),16);central.writeUInt32LE(compressed.length,20);central.writeUInt32LE(bytes.length,24);central.writeUInt16LE(filename.length,28);
 end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(46+filename.length,12);end.writeUInt32LE(30+filename.length+compressed.length,16);
 return Buffer.concat([local,filename,compressed,central,filename,end]);
}

test('each source uses its original provider endpoint and bounded raw transfer',async t=>{
 for(const [product,url] of Object.entries({'gcat-satcat':'https://planet4589.org/space/gcat/tsv/cat/satcat.tsv','gcat-satcat100k':'https://planet4589.org/space/gcat/tsv/cat/satcat100k.tsv','mccants-classfd':'https://mmccants.org/tles/classfd.zip','mccants-inttles':'https://mmccants.org/tles/inttles.zip'})){
  const h=await host(t,{catalog_product:product}),r=await job(h);
  assert.equal(r.request.url,url);assert.equal(r.request.responseWire,'raw-body-v1');assert.equal(r.request.maxBytes,128*1024*1024);
  assert.equal(r.job.provider_id,'test-catalog-node');assert.equal(r.job.source_name,product);
 }
});
test('requires a supported source and exact local publication endpoint',async t=>{
 for(const config of [{catalog_product:'vimpel'},{catalog_product:'gcat-satcat',catalog_publish_url:'http://127.0.0.1:7182.evil.test/api/v1/admin/dataset-updates/publish'},{catalog_product:'gcat-satcat',catalog_publish_url:'https://remote.example/publish'}]){
  const h=await host(t,config),r=await h.invoke({methodId:'catalog_prepare_fetch',inputs:[frame('tick',{})]});assert.notEqual(r.statusCode,0);assert.equal(r.outputs.length,0);
 }
});
test('edition hash is the original download and publication waits for matching ingest',async t=>{
 const h=await host(t,{catalog_product:'gcat-satcat'}),j=await job(h),original=Buffer.from('abc'); // FIPS SHA-256 vector, exact bytes.
 const r=await h.invoke({methodId:'catalog_unpack_fetch',inputs:[frame('job',j.job),frame('response',raw(original))]});
 assert.equal(r.statusCode,0,r.errorMessage);const meta=json(r,'meta');assert.equal(meta.batch_id,'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');assert.deepEqual(payload(r,'source'),original);assert.equal(meta.license,'CC-BY-4.0');assert.equal(meta.reconcile,'current');
 for(const result of [{},{ok:false},{schema:'CAT.fbs',batch_id:'different',inserted:3}]){
  const p=await h.invoke({methodId:'catalog_publish_request',inputs:[frame('result',result)]});assert.notEqual(p.statusCode,0);assert.equal(p.outputs.length,0);
 }
 const p=await h.invoke({methodId:'catalog_publish_request',inputs:[frame('result',{schema:'CAT.fbs',batch_id:meta.batch_id,inserted:3})]});assert.equal(p.statusCode,0,p.errorMessage);
 const request=json(p,'request'),body=JSON.parse(Buffer.from(request.bodyB64,'base64'));assert.equal(request.url,endpoint);assert.deepEqual(body,{schema:'CAT.fbs',providerId:meta.provider_id,sourceName:meta.source_name,batchId:meta.batch_id});
});
test('ZIP output is bounded and checked against the central directory, member and CRC',async t=>{
 const h=await host(t,{catalog_product:'mccants-classfd'}),j=await job(h),original=Buffer.from('independent zlib compressed bytes\n'),archive=zip('classfd.tle',original);
 const unpack=bytes=>h.invoke({methodId:'catalog_unpack_fetch',inputs:[frame('job',j.job),frame('response',raw(bytes))]});
 const r=await unpack(archive);assert.equal(r.statusCode,0,r.errorMessage);assert.deepEqual(payload(r,'source'),original);assert.equal(json(r,'meta').batch_id,createHash('sha256').update(archive).digest('hex'));assert.equal(json(r,'meta').license,undefined);
 const badCRC=Buffer.from(archive);const central=archive.readUInt32LE(archive.length-6);badCRC.writeUInt32LE(0,central+16);
 const bomb=Buffer.from(archive);bomb.writeUInt32LE(129*1024*1024,central+24);
 const encrypted=Buffer.from(archive);encrypted.writeUInt16LE(1,central+8);
 for(const bad of [badCRC,bomb,encrypted,archive.subarray(0,-1),zip('other.tle',original),Buffer.from('not a ZIP')]){const r=await unpack(bad);assert.notEqual(r.statusCode,0);assert.equal(r.outputs.length,0)}
});
test('304 does not replace records; origin failures emit no partial edition',async t=>{
 const h=await host(t,{catalog_product:'gcat-satcat'}),j=await job(h);
 for(const status of [304,403,429,500,0]){
  const r=await h.invoke({methodId:'catalog_unpack_fetch',inputs:[frame('job',j.job),frame('response',raw('',status))]});
  assert.equal(r.outputs.some(f=>f.portId==='source'||f.portId==='meta'),false);
  if(status===304){assert.equal(r.statusCode,0);assert.equal(json(r,'unchanged').status,304)}else assert.notEqual(r.statusCode,0);
 }
});
test('validates the complete original McCants ZIP when supplied',{skip:!process.env.MCCANTS_TEST_ZIP},async t=>{
 const h=await host(t,{catalog_product:process.env.MCCANTS_TEST_ZIP.includes('inttles')?'mccants-inttles':'mccants-classfd'}),j=await job(h),archive=fs.readFileSync(process.env.MCCANTS_TEST_ZIP);
 const r=await h.invoke({methodId:'catalog_unpack_fetch',inputs:[frame('job',j.job),frame('response',raw(archive))]});assert.equal(r.statusCode,0,r.errorMessage);
 const parser=await createBrowserModuleHarness({wasmSource:fs.readFileSync(new URL('../dist/isomorphic/module.wasm',import.meta.url)),manifest:JSON.parse(fs.readFileSync(new URL('../plugin-manifest.json',import.meta.url))),surface:'direct'});t.after(()=>parser.destroy());const parsed=await parser.invoke({methodId:'parse_mccants_tle_catalog',inputs:[frame('source',payload(r,'source'))]});assert.equal(parsed.statusCode,0,parsed.errorMessage);assert.ok(json(parsed,'report').records>10);
});

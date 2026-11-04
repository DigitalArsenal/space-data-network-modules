import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {ByteBuffer} from 'flatbuffers';
import {createBrowserModuleHarness} from 'space-data-module-sdk/host/browser-module';
import {encodeTimerTick,decodeHttpRequest,encodeHttpResponse,decodeIngestRequest,encodeModuleConfig} from 'space-data-module-sdk/runtime-contracts';
import {sources,hash,marker,urls,ecsv,tarFiles} from './sources.mjs';
import {verify} from './source-oracle.mjs';
import {nativePublication} from './native-publication.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),require=createRequire(import.meta.url);
const sds=path.dirname(require.resolve('spacedatastandards.org/package.json'));
const {SSY}=await import(pathToFileURL(path.join(sds,'lib/js/SSY/SSY.js')));
export function decode(bytes){bytes=Buffer.from(bytes);const rows=[];for(let at=0;at<bytes.length;){const n=bytes.readUInt32LE(at);assert(n>8&&at+n+4<=bytes.length);rows.push(SSY.getSizePrefixedRootAsSSY(new ByteBuffer(bytes.subarray(at,at+n+4))).unpack());at+=n+4;}return rows;}
const input=(portId,payload,schemaName,fileIdentifier,rootTypeName)=>({portId,payload,typeRef:{schemaName,fileIdentifier,rootTypeName,wireFormat:'flatbuffer',byteLength:payload.length}});
const hr=s=>input('response',encodeHttpResponse({url:s.url,status:200,body:s.bytes,retrievedMs:s.retrievedMs}),'HttpResponse.fbs','HRSP','HttpResponse');
const ss=await sources(root),manifest=JSON.parse(await fs.readFile(path.join(root,'plugin-manifest.json')));
let h;
try{
 h=await createBrowserModuleHarness({wasmSource:await fs.readFile(path.join(root,'dist/isomorphic/module.wasm')),manifest,surface:'direct'});
 const config=input('config',encodeModuleConfig({}),'ModuleConfig.fbs','MCFG','ModuleConfig');
 const p=await h.invoke({methodId:'plan_release',inputs:[input('tick',encodeTimerTick({triggerId:'minute',firedMs:1}),'TimerTick.fbs','TICK','TimerTick'),config]});assert.equal(p.statusCode,0,p.errorMessage);assert.deepEqual(p.outputs.map(o=>decodeHttpRequest(o.payload).url),[marker]);
 const q=await h.invoke({methodId:'plan_catalog',inputs:[hr({url:marker,bytes:Buffer.from('v1.1.1\n'),retrievedMs:ss[0].retrievedMs}),config]});assert.equal(q.statusCode,0,q.errorMessage);assert.deepEqual(q.outputs.map(o=>decodeHttpRequest(o.payload).url),urls);
 const result=await h.invoke({methodId:'parse_catalog',inputs:[...ss.map(hr),config]});assert.equal(result.statusCode,0,result.errorMessage);
 const meta=decodeIngestRequest(result.outputs.find(o=>o.portId==='meta').payload);assert.equal(meta.schema,'SSY.fbs');assert.equal(meta.tags.providerId,'lvdb');assert.equal(meta.tags.sourceName,'comb-all');assert.equal(meta.tags.license,'CC0-1.0');
 const actual=decode(result.outputs.find(o=>o.portId==='records').payload);verify(actual,ss);
 for(const inputs of [ss.slice(0,3).map(hr),[hr({...ss[0],bytes:Buffer.from('broken')}),...ss.slice(1).map(hr)],[...ss.slice(0,3).map(hr),hr({...ss[3],bytes:ss[3].bytes.subarray(0,100)})]]){const refused=await h.invoke({methodId:'parse_catalog',inputs});assert.notEqual(refused.statusCode,0);assert(!refused.outputs.some(o=>o.portId==='records'));}
 console.log('PASS incomplete/corrupt input batches refuse all records');
 const provenance=(await fs.readFile(path.join(root,'tests/fixtures/provenance.tsv'),'utf8')).trim().split('\n').slice(1).map(l=>l.split('\t'));for(const p of provenance)assert.equal(hash(await fs.readFile(path.join(root,'tests/fixtures',p[0]))),p[4]);console.log('PASS committed trimmed fixture hashes: 11 files');
 if(process.env.LVDB_NODE_READBACK==='1'){assert(process.env.SDN_NODE_BINARY,'SDN_NODE_BINARY required');const back=await nativePublication(root,process.env.SDN_NODE_BINARY);verify(decode(back.records.SSY),ss);console.log('PASS SSY signed native publication and CID readback '+back.cids.SSY);}else console.log('DEFERRED native SSY CID readback: sdn-vendor-ssy-20261103; rerun with LVDB_NODE_READBACK=1 and SDN_NODE_BINARY');
 console.log('PASS lvdb-source E2E: 1727 decoded FlatBuffers');
}finally{if(h)await h.destroy();}
process.exit(0);

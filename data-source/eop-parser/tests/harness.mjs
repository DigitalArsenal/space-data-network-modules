// Typed frames for the eop-parser tests (typed contracts 1.0): a raw file is one $FIL on "body", a fetched one an
// HttpResponse (HRSP) on "response"; the meta is an IngestRequest (INGQ). SDS JS (and its flatbuffers) come from the
// spacedatastandards.org checkout (SPACE_DATA_STANDARDS_ROOT, default the sibling checkout).
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {decodeFlowNotice,decodeIngestRequest,encodeHttpResponse} from 'space-data-module-sdk/runtime-contracts';
export const STANDARDS_ROOT=process.env.SPACE_DATA_STANDARDS_ROOT??fileURLToPath(new URL('../../../../spacedatastandards.org/',import.meta.url));
const EOP_LIB=pathToFileURL(path.join(STANDARDS_ROOT,'lib/js/EOP/main.js'));
export const fb=createRequire(EOP_LIB)('flatbuffers');
export const {EOP}=await import(EOP_LIB.href);
export const ICN_LIB=await import(pathToFileURL(path.join(STANDARDS_ROOT,'lib/js/ICN/main.js')).href);
export const root=new URL('../',import.meta.url);
export const TYPE={
 HRSP:{schemaName:'HttpResponse.fbs',fileIdentifier:'HRSP',rootTypeName:'HttpResponse',wireFormat:'flatbuffer'},
 FIL:{schemaName:'FIL.fbs',fileIdentifier:'$FIL',rootTypeName:'FIL',wireFormat:'flatbuffer'},
 TICK:{schemaName:'TimerTick.fbs',fileIdentifier:'TICK',rootTypeName:'TimerTick',wireFormat:'flatbuffer'},
};
// One $FIL (SDS FIL, schema/FIL/main.fbs; no generated JS yet, so its table is written by slot): CONTENT (slot 9) the
// file bytes, MODIFIED_AT_MS (slot 6) when given.
export function encodeFil(content,{modifiedAtMs=0}={}){
 const b=new fb.Builder(content.length+64);
 const c=b.createByteVector(content);
 b.startObject(13);
 b.addFieldOffset(9,c,0);
 if(modifiedAtMs)b.addFieldInt64(6,BigInt(modifiedAtMs),0n);
 b.finish(b.endObject(),'$FIL');
 return b.asUint8Array().slice();
}
export const body=(bytes,opts)=>({portId:'body',typeRef:TYPE.FIL,payload:encodeFil(bytes,opts)});
export const response=r=>({portId:'response',typeRef:TYPE.HRSP,payload:encodeHttpResponse(r)});
export const fixture=name=>fs.readFileSync(new URL(`fixtures/${name}.excerpt.txt`,import.meta.url));
export const bodies={finals2000a:fixture('finals2000A.all'),c04:fixture('eopc04.1962-now'),paris:fixture('eopc04_IAU2000.62-now')};
export const parseRequest=(source,bytes=bodies[source],http=false)=>({methodId:`parse_${source}`,inputs:[http?response({status:200,body:bytes}):body(bytes)]});
export function decodeRecords(r){
 const output=r.outputs.find(x=>x.portId==='records');if(!output)return [];
 const buf=Buffer.from(output.payload),rows=[];
 for(let at=0;at<buf.length;){const n=buf.readUInt32LE(at);at+=4;rows.push(EOP.getRootAsEOP(new fb.ByteBuffer(Uint8Array.from(buf.subarray(at,at+n)))).unpack());at+=n;}
 return rows;
}
export const meta=r=>decodeIngestRequest(r.outputs.find(x=>x.portId==='meta').payload);
export const notice=r=>decodeFlowNotice(r.outputs.find(x=>x.portId==='unchanged').payload);
// The $ICN job in an HttpRequest's CONTEXT (size-prefixed).
export function readJob(context){
 assert(new DataView(context.buffer,context.byteOffset).getUint32(0,true)===context.length-4,'CONTEXT is one size-prefixed record');
 const bb=new fb.ByteBuffer(Uint8Array.from(context.subarray(4)));
 assert(ICN_LIB.ICN.bufferHasIdentifier(bb),'CONTEXT is an $ICN');
 return ICN_LIB.ICN.getRootAsICN(bb).unpack();
}
function assert(ok,message){if(!ok)throw new Error(message);}

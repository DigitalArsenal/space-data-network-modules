// Typed frames for the eop-parser tests (typed contracts 1.0): a raw file is one $FIL on "body", a fetched one an
// HttpResponse (HRSP) on "response"; the meta is an IngestRequest (INGQ). SDS JS (and its flatbuffers) come from the
// spacedatastandards.org checkout (SPACE_DATA_STANDARDS_ROOT, default the sibling checkout).
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {STANDARDS_ROOT,fb,TYPE,encodeFil,body} from './frames.mjs';
export {STANDARDS_ROOT,fb,TYPE,encodeFil,body};
import {decodeFlowNotice,decodeIngestRequest,encodeHttpResponse} from 'space-data-module-sdk/runtime-contracts';
const EOP_LIB=pathToFileURL(path.join(STANDARDS_ROOT,'lib/js/EOP/main.js'));
export const {EOP}=await import(EOP_LIB.href);
export const ICN_LIB=await import(pathToFileURL(path.join(STANDARDS_ROOT,'lib/js/ICN/main.js')).href);
export const root=new URL('../',import.meta.url);
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

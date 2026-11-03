// The $FIL frame an eop-parser method takes on "body" (a raw file), and nothing else: it needs only the standards checkout's
// flatbuffers (SPACE_DATA_STANDARDS_ROOT, default the sibling checkout), not the SDK, so a script can build the frame
// without the test harness (analysis/reference-states/scripts/fetch-reference-products.mjs).
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
export const STANDARDS_ROOT=process.env.SPACE_DATA_STANDARDS_ROOT??fileURLToPath(new URL('../../../../spacedatastandards.org/',import.meta.url));
const EOP_LIB=pathToFileURL(path.join(STANDARDS_ROOT,'lib/js/EOP/main.js'));
export const fb=createRequire(EOP_LIB)('flatbuffers');
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

import fs from 'node:fs';
import * as fb from 'flatbuffers';
import {EOP} from 'spacedatastandards.org/lib/js/EOP/main.js';
export const root=new URL('../',import.meta.url);
export const wire=(portId,value)=>{const payload=value instanceof Uint8Array?value:Buffer.from(JSON.stringify(value));return {portId,payload,typeRef:{wireFormat:'aligned-binary',requiredAlignment:1,byteLength:payload.length}};};
export const fixture=name=>fs.readFileSync(new URL(`fixtures/${name}.excerpt.txt`,import.meta.url));
export const bodies={finals2000a:fixture('finals2000A.all'),c04:fixture('eopc04.1962-now'),paris:fixture('eopc04_IAU2000.62-now')};
export const parseRequest=(source,body=bodies[source],http=false)=>({methodId:`parse_${source}`,inputs:[wire(http?'response':'body',http?{status:200,bodyB64:body.toString('base64')}:body)]});
export function decodeRecords(response){
 const output=response.outputs.find(x=>x.portId==='records');if(!output)return [];
 const buf=Buffer.from(output.payload),rows=[];
 for(let at=0;at<buf.length;){const n=buf.readUInt32LE(at);at+=4;rows.push(EOP.getRootAsEOP(new fb.ByteBuffer(buf.subarray(at,at+n))).unpack());at+=n;}
 return rows;
}
export const meta=r=>JSON.parse(Buffer.from(r.outputs.find(x=>x.portId==='meta').payload));

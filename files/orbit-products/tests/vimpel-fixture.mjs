import { Builder } from 'flatbuffers';
import { createHash } from 'node:crypto';
import { NCD } from 'spacedatastandards.org/lib/js/NCD/NCD.js';
import { ncdContainerFormat } from 'spacedatastandards.org/lib/js/NCD/ncdContainerFormat.js';
export const TYPE={schemaName:'NCD.fbs',fileIdentifier:'$NCD',rootTypeName:'NCD',wireFormat:'aligned-binary',requiredAlignment:8};
export const row='1,010201,01012026,21092026 000000,0,7000,0,0,0,90,37,0.02,15,0.5,10\n';
export function container(text,{format='vimpel-orbits-text',filename='',hash=true}={}) {
 const bytes=Buffer.from(text),b=new Builder(1024);
 const kind=b.createString(format),name=b.createString(filename),sha=b.createString(hash?createHash('sha256').update(bytes).digest('hex'):'0'.repeat(64));
 NCD.startNCD(b);NCD.addFormat(b,ncdContainerFormat.PROVIDER_DEFINED);NCD.addProviderDefinedFormatName(b,kind);NCD.addInternalFileName(b,name);NCD.addSourceSha256(b,sha);NCD.addSourceByteLength(b,BigInt(bytes.length));NCD.finishSizePrefixedNCDBuffer(b,NCD.endNCD(b));
 return new Uint8Array(Buffer.concat([b.asUint8Array(),bytes]));
}
export const request=(text=row,options)=>{const payload=container(text,options);return {methodId:'normalize_vimpel',inputs:[{portId:'container',typeRef:{...TYPE,byteLength:payload.length},payload}]};};

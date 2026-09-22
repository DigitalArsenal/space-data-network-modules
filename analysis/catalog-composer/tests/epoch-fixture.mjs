// Synthetic affine position history; independent closed-form x(t)=x0+v0*t.
// J2000, UTC 2026-09-21T00:00:00Z; km, km/s, 600-second samples.
import { Builder, ByteBuffer } from 'flatbuffers';
import { OPM } from 'spacedatastandards.org/lib/js/OPM/OPM.js';
import { createHash } from 'node:crypto';
import { NCD } from 'spacedatastandards.org/lib/js/NCD/NCD.js';
import { ncdContainerFormat } from 'spacedatastandards.org/lib/js/NCD/ncdContainerFormat.js';
const TYPE={schemaName:'NCD.fbs',fileIdentifier:'$NCD',rootTypeName:'NCD',wireFormat:'aligned-binary',requiredAlignment:8};
function container(text,{format,filename}) {
 const bytes=Buffer.from(text),b=new Builder(1024),kind=b.createString(format),name=b.createString(filename),sha=b.createString(createHash('sha256').update(bytes).digest('hex'));
 NCD.startNCD(b);NCD.addFormat(b,ncdContainerFormat.PROVIDER_DEFINED);NCD.addProviderDefinedFormatName(b,kind);NCD.addInternalFileName(b,name);NCD.addSourceSha256(b,sha);NCD.addSourceByteLength(b,BigInt(bytes.length));NCD.finishSizePrefixedNCDBuffer(b,NCD.endNCD(b));return new Uint8Array(Buffer.concat([b.asUint8Array(),bytes]));
}
export const start='2026-09-21T00:00:00Z';
export const truth=[42000,1000,-500,0,.01,.001];
export const policy={version:1,propagatorId:'test-affine',propagatorArtifactSha256:'a'.repeat(64),forceModel:{centralBody:false},frameTransformationRef:'test-J2000-identity',holdoutStride:4,positionToleranceKm:.0001,positionPerturbationKm:.01,velocityPerturbationKmS:.00001,positionWeightKm:.00001,positionRegularizationKm:1000,velocityRegularizationKmS:1};
export function opm(state,{epoch=start,object='vimpel:10201',frame='J2000'}={}) {
 const b=new Builder(512);const strings=['2.0','','test',object,'','EARTH',frame,'UTC',epoch].map(s=>b.createString(s));
 b.startObject(28);strings.forEach((s,i)=>b.addFieldOffset(i,s,0));state.forEach((v,i)=>b.addFieldFloat64(i+9,v,0));b.finishSizePrefixed(b.endObject(),'$OPM');return b.asUint8Array();
}
export function unpackOpm(bytes){const x=OPM.getSizePrefixedRootAsOPM(new ByteBuffer(bytes));return [x.X(),x.Y(),x.Z(),x.X_DOT(),x.Y_DOT(),x.Z_DOT()];}
export function oemStates(values,{epoch=start,step=600,frame=2}={}) {
 const b=new Builder(8192);b.startVector(8,values.length,8);for(let i=values.length-1;i>=0;i--)b.addFloat64(values[i]);const data=b.endVector();
 b.startObject(1);b.addFieldInt8(0,frame,0);const wrapper=b.endObject();b.startObject(4);b.addFieldInt8(0,1,0);b.addFieldOffset(1,wrapper,0);const rf=b.endObject();const earth=b.createString('EARTH'),time=b.createString(epoch);
 b.startObject(19);b.addFieldOffset(2,earth,0);b.addFieldOffset(3,rf,0);b.addFieldInt8(6,11,0);b.addFieldOffset(7,time,0);b.addFieldFloat64(13,step,0);b.addFieldInt8(14,6,6);b.addFieldOffset(15,data,0);const block=b.endObject();b.startVector(4,1,4);b.addOffset(block);const blocks=b.endVector();b.startObject(5);b.addFieldOffset(4,blocks,0);b.finishSizePrefixed(b.endObject(),'$OEM');return b.asUint8Array();
}
export function affine(state,n=17){return Array.from({length:n},(_,i)=>[...state.slice(0,3).map((x,j)=>x+state[j+3]*i*600),...state.slice(3)]).flat();}
export function reference({heldoutError=0,filename='010201_20260921_000000',states=affine(truth)}={}) {
 const rows=Array.from({length:states.length/6},(_,i)=>`${i},${states[i*6]+(i===3?heldoutError:0)},${states[i*6+1]},${states[i*6+2]}`).join('\n');
 return container(rows,{format:'vimpel-ephemeris-text',filename});
}
const scientific=(portId,code,payload)=>({portId,typeRef:{schemaName:code+'.fbs',fileIdentifier:'$'+code,rootTypeName:code},payload});
export function request(methodId,state,arcs,ref=reference(),recipe=policy) {
 const payload=new TextEncoder().encode(JSON.stringify(recipe));return {methodId,inputs:[{portId:'recipe',typeRef:{wireFormat:'aligned-binary',requiredAlignment:1,byteLength:payload.length},payload},scientific('seed','OPM',opm(state)),{portId:'reference',typeRef:{...TYPE,byteLength:ref.length},payload:ref},...arcs.map(x=>scientific('ephemerides','OEM',x))]};
}
export function perturbed(state){return [state,...state.map((_,j)=>state.map((x,k)=>x+(k===j?(j<3?policy.positionPerturbationKm:policy.velocityPerturbationKmS):0)))].map(s=>oemStates(affine(s)));}

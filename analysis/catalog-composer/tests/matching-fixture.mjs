import { Builder } from 'flatbuffers';
// Independent closed-form circular two-body orbit: r=7000 km, Earth mu
// 398600.4418 km^3/s^2, J2000, UTC 2026-09-21T00:00:00Z. Analytic derivative
// supplies velocity; fourth-order FD should agree within 1e-8 km/s at h=1 s.
export function oem({phase=0,radius=7000,step=1,frame=2,start='2026-09-21T00:00:00Z',badVelocity=false,n=9}={}) {
 const b=new Builder(2048),mu=398600.4418,r=radius,w=Math.sqrt(mu/r**3),values=[];
 for(let k=0;k<n;k++){const a=w*k*step+phase;values.push(r*Math.cos(a),r*Math.sin(a),0,badVelocity?0:-r*w*Math.sin(a),badVelocity?0:r*w*Math.cos(a),0);}
 b.startVector(8,values.length,8);for(let i=values.length-1;i>=0;--i)b.addFloat64(values[i]);const data=b.endVector();
 b.startObject(1);b.addFieldInt8(0,frame,0);const wrapper=b.endObject();
 b.startObject(4);b.addFieldInt8(0,1,0);b.addFieldOffset(1,wrapper,0);const rf=b.endObject();
 const earth=b.createString('EARTH'),epoch=b.createString(start);
 b.startObject(19);b.addFieldOffset(2,earth,0);b.addFieldOffset(3,rf,0);b.addFieldInt8(6,11,0);b.addFieldOffset(7,epoch,0);b.addFieldFloat64(13,step,0);b.addFieldInt8(14,6,6);b.addFieldOffset(15,data,0);const block=b.endObject();
 b.startVector(4,1,4);b.addOffset(block);const blocks=b.endVector();b.startObject(5);b.addFieldOffset(4,blocks,0);b.finishSizePrefixed(b.endObject(),'$OEM');return b.asUint8Array();
}

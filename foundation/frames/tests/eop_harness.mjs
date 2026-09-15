import * as fb from 'flatbuffers';
import {FRM,FRMT,FRMFrameTransformRequestT,frmOperationCode,RFMCoordinateSystemT,RFMOriginT,rfmOriginKind,rfmAxisType} from 'spacedatastandards.org/lib/js/FRM/main.js';
import {EOP,EOPT} from 'spacedatastandards.org/lib/js/EOP/main.js';
export const AS2R=Math.PI/648000;
export const typeRef={schemaName:'EOP.fbs',fileIdentifier:'$EOP',rootTypeName:'EOP'};
export function request(epoch='2007-04-05T12:00:00Z'){
 const system=(name,axis)=>new RFMCoordinateSystemT(name,axis,new RFMOriginT(rfmOriginKind.CELESTIAL_BODY,399),399,epoch,'UTC');
 const r=new FRMFrameTransformRequestT();r.OPERATION=frmOperationCode.FRAME_ROTATION;r.EPOCH=epoch;r.EPOCH_TIME_SYSTEM='UTC';r.SOURCE_COORDINATE_SYSTEM=system('GCRF',rfmAxisType.ICRF);r.TARGET_COORDINATE_SYSTEM=system('ITRF',rfmAxisType.BODY_FIXED);
 const b=new fb.Builder(1024);FRM.finishFRMBuffer(b,new FRMT(r,null).pack(b));return {portId:'request',typeRef:{schemaName:'FRM.fbs',fileIdentifier:'$FRM',rootTypeName:'FRM'},payload:b.asUint8Array()};
}
export function eop({mjd=54195,date='2007-04-05T00:00:00Z',x=.0349282,y=.4833163,dut1=-.072073685,dx=.0001750,dy=-.0002259,lod=0,series=5,convention=3,cid='sofa-example',hp=true,legacyX}={}){
 const r=new EOPT();Object.assign(r,{DATE:date,MJD:mjd,SERIES:series,IAU_CONVENTION:convention,DATA_SET_CID:cid});
 const fields={X_POLE_WANDER_RADIANS:x*AS2R,Y_POLE_WANDER_RADIANS:y*AS2R,UT1_MINUS_UTC_SECONDS:dut1,X_CELESTIAL_POLE_OFFSET_RADIANS:dx*AS2R,Y_CELESTIAL_POLE_OFFSET_RADIANS:dy*AS2R,LENGTH_OF_DAY_CORRECTION_SECONDS:lod};
 Object.assign(r,fields);if(legacyX!==undefined)r.X_POLE_WANDER_RADIANS=legacyX;
 const b=new fb.Builder(1024);if(hp)b.forceDefaults(true);
 if(hp)for(const [key,value]of Object.entries(fields))r[key+'_HP']=value;
 // Only write present string offsets: JS forceDefaults also writes zero offsets,
 // which are not valid FlatBuffer strings. Explicitly encoded HP zeros are scalar.
 const dateOffset=b.createString(r.DATE),cidOffset=b.createString(r.DATA_SET_CID);
 EOP.startEOP(b);EOP.addDate(b,dateOffset);EOP.addDataSetCid(b,cidOffset);
 EOP.addMjd(b,r.MJD);EOP.addSeries(b,r.SERIES);EOP.addIauConvention(b,r.IAU_CONVENTION);
 for(const key of Object.keys(fields)){const suffix=key.toLowerCase().split('_').map(w=>w[0].toUpperCase()+w.slice(1)).join('');EOP['add'+suffix](b,r[key]);if(hp)EOP['add'+suffix+'Hp'](b,r[key+'_HP']);}
 EOP.finishEOPBuffer(b,EOP.endEOP(b));return {portId:'earth_orientation',typeRef,payload:b.asUint8Array()};
}
export function invokeRequest(epoch,rows){return {methodId:'transform_frame_position',inputs:[request(epoch),...rows]};}
export const sofaMatrix=[.973104317697536,.230363826239128,-.000703163481769,-.230363800456036,.973104570632801,.000118545368117,.000711560162594,.000046626402444,.999999745754024];

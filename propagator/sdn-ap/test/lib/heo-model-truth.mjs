// Module-only synthetic state generation, numerical reference and RTN projection.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import * as fb from 'flatbuffers';
import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {OEM,OEMT} from 'spacedatastandards.org/lib/js/OEM/OEM.js';
import {OMM} from 'spacedatastandards.org/lib/js/OMM/OMM.js';
import {CATT} from 'spacedatastandards.org/lib/js/OEM/CAT.js';
import {ephemerisDataBlockT as Block} from 'spacedatastandards.org/lib/js/OEM/ephemerisDataBlock.js';
import {ephemerisDataLineT as Line} from 'spacedatastandards.org/lib/js/OEM/ephemerisDataLine.js';
import {timingStandard} from 'spacedatastandards.org/lib/js/OEM/timingStandard.js';
import {SPW,SPWT} from 'spacedatastandards.org/lib/js/SPW/SPW.js';
import {pcfAtmosphereFamily} from 'spacedatastandards.org/lib/js/PCF/pcfAtmosphereFamily.js';
import {pcfWeatherSource} from 'spacedatastandards.org/lib/js/PCF/pcfWeatherSource.js';
import {pcfOutputFrame} from 'spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js';
import {openModule,wasmPath,THEORY} from './module.mjs';
import {packOem,rfm,jdOf,rotate,FRAME_PROBE} from './frames.mjs';
import {configuration,prior,pcfPriorForm} from './pcf.mjs';
import {requestFor,decodeResult,encodePrw,makeTable,TYPE} from '../../../ffm/tests/lib/prwCodec.mjs';
const epoch='2026-10-29T00:00:00.000',t0=Date.parse(epoch+'Z'),DAY=86400000,FIT=3;
const ffmPath=new URL('../../../ffm/dist/isomorphic/module.wasm',import.meta.url).pathname;
const scratch=process.env.SDN_AP_HEO_CACHE??'/Users/tj/software/terrain-work/body-look/codex-apfix-d9/heo';
const type=n=>({schemaName:n+'.fbs',fileIdentifier:'$'+n,rootTypeName:n});
const iso=ms=>new Date(ms).toISOString().replace('Z','');
function oem(lines,fit=false){
 const b=Object.assign(new Block(),{OBJECT:Object.assign(new CATT(),{NORAD_CAT_ID:99001,OBJECT_NAME:'SYNTHETIC HEO'}),CENTER_NAME:'EARTH',REFERENCE_FRAME:rfm('GCRF'),TIME_SYSTEM:timingStandard.UTC,START_TIME:lines[0].EPOCH,STOP_TIME:lines.at(-1).EPOCH,EPHEMERIS_DATA_LINES:lines});
 if(fit){b.USEABLE_START_TIME=b.START_TIME;b.USEABLE_STOP_TIME=b.STOP_TIME;}
 return packOem(Object.assign(new OEMT(),{EPHEMERIS_DATA_BLOCK:[b]}));
}
export async function runModelTruth(c){
 fs.mkdirSync(scratch,{recursive:true});
 const m=await openModule(),x=m.x,p=x.sdnap_alloc(256),a=(off,n)=>new Float64Array(m.harness.memory.buffer,p+off,n),jd=jdOf(epoch);
 m.init([{epochWhole:jd.whole,epochFrac:jd.frac,meanMotion:c.n,ecc:c.e,inc:c.i,raan:c.raan,argp:c.argp,ma:c.ma,norad:99001,theory:THEORY.SGP4XP}]);
 assert.equal(x.sdnap_mean_elements_at(0,0,p),0);
 const semimajor=a(0,1)[0];
 // State-of-elements takes argument of latitude, so seed at perigee (u=argp).
 a(0,6).set([semimajor,c.e,c.i,c.raan,c.argp,c.argp]);
 assert.equal(x.sdnap_state_of_elements(jd.whole,jd.frac,p,0,p+48),0);
 const initial=rotate(m,jd.whole,jd.frac,Array.from(a(48,6)),FRAME_PROBE.TEME_TO_GCRF);assert.equal(initial.status,0);
 const times=[...Array(145)].map((_,k)=>k/48).concat([4,6,10]);
 const params={epochJD:jd.whole,epochTimeScale:'UTC',targetJD:jd.whole+10,targetTimeScale:'UTC',position:initial.out.slice(0,3),velocity:initial.out.slice(3),frame:'GCRF',sampleEpochsJD:times.map(d=>({jd:jd.whole+d,scale:'UTC'})),forces:{gravityMode:'EGM96',maxDegree:70,maxOrder:70,thirdBody:true,srp:false,drag:c.drag,massKg:1000,areaM2:20,cd:2.2},weather:{epochUTCJD:jd.whole,F107:150,F107a:150,Ap:15,Kp:3},integrator:{tolerance:1e-12,minStep:.01,maxStep:300}};
 const key=createHash('sha256').update(fs.readFileSync(ffmPath)).update(JSON.stringify(params)).digest('hex');
 const file=path.join(scratch,key+'.json');let truth;
 if(fs.existsSync(file))truth=JSON.parse(fs.readFileSync(file));else{
  const h=await createStandaloneHarness('browser',ffmPath,{surface:'command'});
  const req=requestFor('propagate',params);
  req.inputs.push({portId:'earth_orientation',typeRef:TYPE,payload:encodePrw('EARTH_ORIENTATION',makeTable('PRWEarthOrientation',{ROWS:Array.from({length:14},(_,k)=>makeTable('EOP',{DATE:iso(t0+(k-1)*DAY)+'Z',MJD:jd.whole-2400000.5+k-1,TAI_MINUS_UTC_SECONDS:37}))}))});
  const r=await h.invoke(req);assert.equal(r.statusCode,0,`${r.errorCode}: ${r.errorMessage}`);
  truth=decodeResult(r).samples;assert.equal(truth.length,times.length);fs.writeFileSync(file,JSON.stringify(truth));await h.close?.();
 }
 const lines=truth.map((s,k)=>Object.assign(new Line(),{EPOCH:iso(t0+times[k]*DAY),X:s.position[0],Y:s.position[1],Z:s.position[2],X_DOT:s.velocity[0],Y_DOT:s.velocity[1],Z_DOT:s.velocity[2]}));
 const rows=JSON.parse(fs.readFileSync(process.env.FFM_SPW_FIXTURE??'/Users/tj/software/terrain-work/ffm-spw-fixture/spw-constant-20261029.json'));
 const weather=Buffer.concat((Array.isArray(rows)?rows:rows.rows).map(row=>{const b=new fb.Builder(256);SPW.finishSizePrefixedSPWBuffer(b,Object.assign(new SPWT(),row).pack(b));return b.asUint8Array();}));
 const cfg=configuration({theory:'SGP4XP',forces:{EPHEMERIS_SOURCE:'',HAS_MAXIMUM_TESSERAL_DEGREE:true,MAXIMUM_TESSERAL_DEGREE:31,HAS_MAXIMUM_DEGREE:true,MAXIMUM_DEGREE:20,ENABLE_DRAG:c.drag,ATMOSPHERE_MODEL:pcfAtmosphereFamily.NRLMSISE00,WEATHER_SOURCE:pcfWeatherSource.RECORDS},fit:{DRAG_PRIOR:prior(c.drag?.044:0,c.drag?.1:1e-10),DRAG_PRIOR_FORM:pcfPriorForm.GAUSSIAN_SIGNED,SRP_PRIOR:prior(0,1e-10)},output:{OUTPUT_FRAME:pcfOutputFrame.GCRF}});
 const h=await createStandaloneHarness('browser',wasmPath,{surface:'command'});
 const call=async(methodId,inputs)=>{const r=await h.invoke({methodId,inputs:[cfg,{portId:'space_weather',typeRef:type('SPW'),payload:weather},...inputs]});assert.equal(r.statusCode,0,`${r.errorCode}: ${r.errorMessage}`);return r.outputs;};
 const fit=await call('fit',[{portId:'ephemeris',typeRef:type('OEM'),payload:oem(lines.slice(0,145),true)}]);
 const omm=fit.find(v=>v.portId==='elements').payload;
 const out=await call('propagate',[{portId:'omm',typeRef:type('OMM'),payload:omm},{portId:'grid',typeRef:type('OEM'),payload:oem(lines.slice(145))}]);
 const flown=OEM.getRootAsOEM(new fb.ByteBuffer(out.find(v=>v.portId==='ephemeris').payload)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES;
 const result={name:c.name,n:c.n,e:c.e,perigeeKm:semimajor*(1-c.e)-6378.135,fitHours:72,days:{},ffmSha256:createHash('sha256').update(fs.readFileSync(ffmPath)).digest('hex')};
 for(let k=0;k<3;k++){
  const ref=truth[145+k],f=flown[k],err=[f.X-ref.position[0],f.Y-ref.position[1],f.Z-ref.position[2]];
  a(0,3).set(ref.position);a(24,3).set(ref.velocity);a(48,3).set(err);x.sdnap_frame_to_uvw(p,p+24,p+48,p+72);
  const rtn=Array.from(a(72,3),v=>v*1000);result.days[[1,3,7][k]]={e:Math.hypot(...err)*1000,r:rtn[0],t:rtn[1],n:rtn[2]};
 }
 x.sdnap_free(p);m.destroy();await h.close?.();return result;
}

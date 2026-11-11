// Model truth for one synthetic orbit: FFM (EGM96 to the given degree and order, Sun and Moon from DE440 when asked) from
// an AP-consistent state, AP fitted over 72 h through `fit`, then flown hourly for 7 days; errors per hour and their
// daily RMS in the reference's RTN axes. Module-only state generation and projection; derived from heo-model-truth.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import * as fb from 'flatbuffers';
import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {OEM,OEMT} from 'spacedatastandards.org/lib/js/OEM/OEM.js';
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
import {seedOcm,rowsThrough,spwStream,fittedOf,flight,legacyBuild,T as OCM_TYPE} from './ocm.mjs';
import {requestFor,decodeResult,encodePrw,makeTable,TYPE} from '../../../ffm/tests/lib/prwCodec.mjs';
import {sharedRoot,writeWhole} from './scratch.mjs';
import {spwFixtureRows} from './spw-constant.mjs';
const epoch='2026-10-29T00:00:00.000',t0=Date.parse(epoch+'Z'),DAY=86400000,FIT=3;
import {ffmPath,checkTruth} from './ffm-truth.mjs';
const scratch=path.join(sharedRoot,'synthetic-truth');
const type=n=>({schemaName:n+'.fbs',fileIdentifier:'$'+n,rootTypeName:n});
const iso=ms=>new Date(ms).toISOString().replace('Z','');
function oem(lines,fit=false){
 const b=Object.assign(new Block(),{OBJECT:Object.assign(new CATT(),{NORAD_CAT_ID:99001,OBJECT_NAME:'SYNTHETIC HEO'}),CENTER_NAME:'EARTH',REFERENCE_FRAME:rfm('GCRF'),TIME_SYSTEM:timingStandard.UTC,START_TIME:lines[0].EPOCH,STOP_TIME:lines.at(-1).EPOCH,EPHEMERIS_DATA_LINES:lines});
 if(fit){b.USEABLE_START_TIME=b.START_TIME;b.USEABLE_STOP_TIME=b.STOP_TIME;}
 return packOem(Object.assign(new OEMT(),{EPHEMERIS_DATA_BLOCK:[b]}));
}
export async function runSyntheticTruth(c){
 // a 0.4 build is driven as it was (synthetic-truth-0.4.mjs)
 if(c.modulePath&&legacyBuild(c.modulePath))return(await import('./synthetic-truth-0.4.mjs')).runSyntheticTruth(c);
 fs.mkdirSync(scratch,{recursive:true});
 const m=await openModule(),x=m.x,p=x.sdnap_alloc(256),a=(off,n)=>new Float64Array(m.harness.memory.buffer,p+off,n),jd=jdOf(epoch);
 const rows=spwFixtureRows();
 const rowList=rowsThrough(Array.isArray(rows)?rows:rows.rows),weather=spwStream(rowList);
 // fit runs under the forces the record then states: the caps, NRLMSISE-00 (c.drag) or Jacchia 1970, both on the rows
 const tess=c.tesseral??31,zon=c.zonal??20;
 const cfg=configuration({forces:{EPHEMERIS_SOURCE:'',HAS_MAXIMUM_TESSERAL_DEGREE:true,MAXIMUM_TESSERAL_DEGREE:tess,HAS_MAXIMUM_DEGREE:true,MAXIMUM_DEGREE:zon,ATMOSPHERE_MODEL:c.drag?pcfAtmosphereFamily.NRLMSISE00:pcfAtmosphereFamily.JACCHIA70,WEATHER_SOURCE:pcfWeatherSource.RECORDS},fit:{DRAG_PRIOR:prior(c.drag?(c.bterm??.044):0,c.drag?(c.dragSigma??.1):1e-10),DRAG_PRIOR_FORM:pcfPriorForm.GAUSSIAN_SIGNED,SRP_PRIOR:prior(0,1e-10)}});
 const h=await createStandaloneHarness('browser',c.modulePath??wasmPath,{surface:'command'});
 const call=async(methodId,inputs)=>{const r=await h.invoke({methodId,inputs:methodId==='fit'?[cfg,{portId:'space_weather',typeRef:type('SPW'),payload:weather},...inputs]:inputs});assert.equal(r.statusCode,0,`${r.errorCode}: ${r.errorMessage}`);return r.outputs;};
 const fly=(set,lines)=>call('propagate',flight([set],{output:{EPOCHS:lines.map(L=>L.EPOCH),FRAME:pcfOutputFrame.GCRF}}));
 m.init([{epochWhole:jd.whole,epochFrac:jd.frac,meanMotion:c.n,ecc:c.e,inc:c.i,raan:c.raan,argp:c.argp,ma:c.ma,norad:99001,theory:THEORY.SGP4XP}]);
 assert.equal(x.sdnap_mean_elements_at(0,0,p),0);
 const semimajor=a(0,1)[0];
 // State-of-elements takes argument of latitude, so seed at perigee (u=argp).
 a(0,6).set([semimajor,c.e,c.i,c.raan,c.argp,c.argp]);
 assert.equal(x.sdnap_state_of_elements(jd.whole,jd.frac,p,0,p+48),0);
 let initial=rotate(m,jd.whole,jd.frac,Array.from(a(48,6)),FRAME_PROBE.TEME_TO_GCRF);assert.equal(initial.status,0);
 let seed;
 if(c.mode==='seed'){
  seed=seedOcm({epoch,n:c.n,e:c.e,i:c.i,raan:c.raan,argp:c.argp,ma:c.ma,bterm:c.drag?(c.bterm??.044):0,norad:99001,msis:c.drag,records:true,tesseral:tess,zonal:zon,rows:rowList});
  const out=await fly(seed,[{EPOCH:epoch}]);
  const v=OEM.getRootAsOEM(new fb.ByteBuffer(out.find(v=>v.portId==='ephemeris').payload)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES[0];
  initial={status:0,out:[v.X,v.Y,v.Z,v.X_DOT,v.Y_DOT,v.Z_DOT]};
 }
 const times=[...Array(145)].map((_,k)=>k/48).concat([...Array(168)].map((_,k)=>3+(k+1)/24));
 const first=145;
 const params={epochJD:jd.whole,epochTimeScale:'UTC',targetJD:jd.whole+times.at(-1),targetTimeScale:'UTC',position:initial.out.slice(0,3),velocity:initial.out.slice(3),frame:'GCRF',sampleEpochsJD:times.map(d=>({jd:jd.whole+d,scale:'UTC'})),forces:{gravityMode:'EGM96',maxDegree:c.maxDegree??70,maxOrder:c.maxOrder??70,thirdBody:c.thirdBody??true,srp:false,drag:c.drag,massKg:1000,areaM2:(c.bterm??.044)*1000/2.2,cd:2.2},weather:{epochUTCJD:jd.whole,F107:150,F107a:150,Ap:15,Kp:3},integrator:{tolerance:c.referenceTolerance??1e-12,minStep:.01,maxStep:c.referenceMaxStep??300}};
 params.ephemerisSource='JPL_SPK';
 const kernel=fs.readFileSync(new URL('../../../../files/orbit-products/tests/fixtures/de440/de440-2026.bsp',import.meta.url));
 checkTruth();
 const req=requestFor('propagate',params,kernel);
 req.inputs.push({portId:'earth_orientation',typeRef:TYPE,payload:encodePrw('EARTH_ORIENTATION',makeTable('PRWEarthOrientation',{ROWS:Array.from({length:14},(_,k)=>makeTable('EOP',{DATE:iso(t0+(k-1)*DAY)+'Z',MJD:jd.whole-2400000.5+k-1,TAI_MINUS_UTC_SECONDS:37}))}))});
 // the cache name is the SHA-256 of FFM's build and every byte of the request, so clones share it (scratch.mjs)
 const hash=createHash('sha256').update(fs.readFileSync(ffmPath));for(const i of req.inputs)hash.update(i.portId).update(Buffer.from(i.payload));
 const file=path.join(scratch,hash.digest('hex')+'.json');let truth;
 if(fs.existsSync(file))truth=JSON.parse(fs.readFileSync(file));else{
  const h=await createStandaloneHarness('browser',ffmPath,{surface:'command'});
  const r=await h.invoke(req);assert.equal(r.statusCode,0,`${r.errorCode}: ${r.errorMessage}`);
  truth=decodeResult(r).samples;assert.equal(truth.length,times.length);writeWhole(file,JSON.stringify(truth));await h.close?.();
 }
 assert.ok(Math.hypot(...truth[0].position.map((v,k)=>v-initial.out[k]))<1e-9,'FFM shares the module initial position');
 const lines=truth.map((s,k)=>Object.assign(new Line(),{EPOCH:iso(t0+times[k]*DAY),X:s.position[0],Y:s.position[1],Z:s.position[2],X_DOT:s.velocity[0],Y_DOT:s.velocity[1],Z_DOT:s.velocity[2]}));
 const fit=seed?null:await call('fit',[{portId:'ephemeris',typeRef:type('OEM'),payload:oem(lines.slice(0,145),true)}]);
 const omm=seed??fit.find(v=>v.portId==='elements').payload;
 const out=await fly(omm,lines.slice(first));
 const flown=OEM.getRootAsOEM(new fb.ByteBuffer(out.find(v=>v.portId==='ephemeris').payload)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES;
 const parsed=fittedOf(omm);
 const classDiagnostics=[];
 if(c.probePath){
  const ph=await createStandaloneHarness('browser',c.probePath,{surface:'direct'});
  const loaded=await ph.invoke({methodId:'load_epochs',inputs:[{portId:'ocm',typeRef:OCM_TYPE('OCM'),payload:omm}]});
  assert.equal(loaded.statusCode,0,loaded.errorMessage);
  const px=ph.instance.exports,pp=px.sdnap_alloc(72),fitEpoch=Date.parse(parsed.epoch+'Z');
  for(const day of [0,1,3,7]){const minutes=(t0+((c.mode==='seed'?0:FIT)+day)*DAY-fitEpoch)/60000;assert.equal(px.sdnap_test_class_probe(minutes,pp),0);classDiagnostics.push({day,values:Array.from(new Float64Array(ph.memory.buffer,pp,9))});}
  px.sdnap_free(pp);await ph.close?.();
 }
 const result={name:c.name,fitted:{epoch:parsed.epoch,n:parsed.n,e:parsed.e,bterm:parsed.bterm},classDiagnostics,classProbeSha256:c.probePath?createHash('sha256').update(fs.readFileSync(c.probePath)).digest('hex'):undefined,fixture:{...c,initialization:c.mode==='seed'?'AP mean-element epoch state':'osculating perigee (argument of latitude equals argument of perigee)',initialGcrfKm:initial.out,fitEnd:iso(t0+(c.mode==='seed'?0:FIT)*DAY),referenceIntegrator:params.integrator},referenceStates:truth.slice(first),apSha256:createHash('sha256').update(fs.readFileSync(c.modulePath??wasmPath)).digest('hex'),epoch,reference:'FFM EGM96 70x70, Sun/Moon DE440, zero EOP, constant F10.7 150/Ap 15',kernelSha256:createHash('sha256').update(kernel).digest('hex'),n:c.n,e:c.e,perigeeKm:semimajor*(1-c.e)-6378.135,fitHours:c.mode==='seed'?0:72,days:{},ffmSha256:createHash('sha256').update(fs.readFileSync(ffmPath)).digest('hex')};
 result.profile=[];
 for(let k=0;k<flown.length;k++){
  const ref=truth[first+k],f=flown[k],err=[f.X-ref.position[0],f.Y-ref.position[1],f.Z-ref.position[2]];
  a(0,3).set(ref.position);a(24,3).set(ref.velocity);a(48,3).set(err);x.sdnap_frame_to_uvw(p,p+24,p+48,p+72);
  const rtn=Array.from(a(72,3),v=>v*1000);result.profile.push({h:k+1,e:Math.hypot(...err)*1000,r:rtn[0],t:rtn[1],n:rtn[2]});
 }
 for(const d of [1,3,7]){const pr=result.profile.filter(q=>q.h>(d-1)*24&&q.h<=d*24);result.days[d]=Object.fromEntries(['e','r','t','n'].map(k=>[k,Math.sqrt(pr.reduce((s,q)=>s+q[k]**2,0)/pr.length)]));}
 x.sdnap_free(p);m.destroy();await h.close?.();return result;
}

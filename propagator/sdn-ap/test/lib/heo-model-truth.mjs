// Module-only synthetic state generation, numerical reference and RTN projection.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import * as fb from 'flatbuffers';
import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {OEM,OEMT} from 'spacedatastandards.org/lib/js/OEM/OEM.js';
import {OMM,OMMT} from 'spacedatastandards.org/lib/js/OMM/OMM.js';
import {OBD} from 'spacedatastandards.org/lib/js/OBD/OBD.js';
import {OMMUserDefinedParameterT} from 'spacedatastandards.org/lib/js/OMM/OMMUserDefinedParameter.js';
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
const epoch='2026-10-29T00:00:00.000',t0=Date.parse(epoch+'Z'),DAY=86400000;
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
 // c.fitUseable false: the fit's $OEM states no USEABLE_START_TIME / STOP_TIME (the fitter's span policy chooses the arc)
 // c.agomPrior [mean, sigma]: FIT.SRP_PRIOR with c.fitPolicy (otherwise the call's default; the truth has no SRP)
 // c.fitStartDays (S): the fit's arc starts S days after the truth's start (the truth carries its start state first)
 const FIT=c.fitDays??3,NF=FIT*48+1,S=c.fitStartDays??0,lead=S>0?1:0;
 fs.mkdirSync(scratch,{recursive:true});
 const m=await openModule(),x=m.x,p=x.sdnap_alloc(256),a=(off,n)=>new Float64Array(m.harness.memory.buffer,p+off,n),jd=jdOf(epoch);
 const rows=JSON.parse(fs.readFileSync(process.env.FFM_SPW_FIXTURE??'/Users/tj/software/terrain-work/ffm-spw-fixture/spw-constant-20261029.json'));
 const weather=Buffer.concat((Array.isArray(rows)?rows:rows.rows).map(row=>{const b=new fb.Builder(256);SPW.finishSizePrefixedSPWBuffer(b,Object.assign(new SPWT(),row).pack(b));return b.asUint8Array();}));
 const cfg=configuration({theory:'SGP4XP',forces:{EPHEMERIS_SOURCE:'',HAS_MAXIMUM_TESSERAL_DEGREE:true,MAXIMUM_TESSERAL_DEGREE:c.forces?.[0]??31,HAS_MAXIMUM_DEGREE:true,MAXIMUM_DEGREE:c.forces?.[1]??20,ENABLE_DRAG:c.drag,ATMOSPHERE_MODEL:pcfAtmosphereFamily.NRLMSISE00,WEATHER_SOURCE:pcfWeatherSource.RECORDS},...(c.fitPolicy==='default'?(c.agomPrior?{fit:{SRP_PRIOR:prior(...c.agomPrior)}}:{}):{fit:c.fitPolicy?{DRAG_PRIOR:prior(c.fitPolicy.mean,c.fitPolicy.sigma),DRAG_PRIOR_FORM:pcfPriorForm[c.fitPolicy.form],...(c.agomPrior?{SRP_PRIOR:prior(...c.agomPrior)}:{})}:{DRAG_PRIOR:prior(c.drag?(c.bterm??.044):0,c.drag?(c.dragSigma??.1):1e-10),DRAG_PRIOR_FORM:pcfPriorForm.GAUSSIAN_SIGNED,SRP_PRIOR:prior(0,1e-10)}}),output:{OUTPUT_FRAME:pcfOutputFrame.GCRF}});
 const h=await createStandaloneHarness('browser',c.modulePath??wasmPath,{surface:'command'});
 const call=async(methodId,inputs)=>{const r=await h.invoke({methodId,inputs:[cfg,{portId:'space_weather',typeRef:type('SPW'),payload:weather},...inputs]});assert.equal(r.statusCode,0,`${r.errorCode}: ${r.errorMessage}`);return r.outputs;};
 m.init([{epochWhole:jd.whole,epochFrac:jd.frac,meanMotion:c.n,ecc:c.e,inc:c.i,raan:c.raan,argp:c.argp,ma:c.ma,norad:99001,theory:THEORY.SGP4XP}]);
 assert.equal(x.sdnap_mean_elements_at(0,0,p),0);
 const semimajor=a(0,1)[0];
 // State-of-elements takes argument of latitude, so seed at perigee (u=argp).
 a(0,6).set([semimajor,c.e,c.i,c.raan,c.argp,c.argp]);
 assert.equal(x.sdnap_state_of_elements(jd.whole,jd.frac,p,0,p+48),0);
 let initial=rotate(m,jd.whole,jd.frac,Array.from(a(48,6)),FRAME_PROBE.TEME_TO_GCRF);assert.equal(initial.status,0);
 let seed;
 if(c.mode==='seed'){
  const obj=Object.assign(new OMMT(),{EPOCH:epoch,MEAN_ELEMENT_THEORY:1,MEAN_MOTION:c.n,ECCENTRICITY:c.e,INCLINATION:c.i,RA_OF_ASC_NODE:c.raan,ARG_OF_PERICENTER:c.argp,MEAN_ANOMALY:c.ma,BSTAR:c.drag?(c.bterm??.044):0,MEAN_MOTION_DDOT:0,NORAD_CAT_ID:99001,USER_DEFINED_PARAMETERS:[Object.assign(new OMMUserDefinedParameterT(),{PARAM_NAME:'SDNAP_GRAVITY_TERMS',PARAM_VALUE:'31,20'}),...(c.drag?[Object.assign(new OMMUserDefinedParameterT(),{PARAM_NAME:'SDNAP_ATMOSPHERE_MODEL',PARAM_VALUE:'NRLMSISE00'})]:[])]});
  const b=new fb.Builder(1024);OMM.finishOMMBuffer(b,obj.pack(b));seed=b.asUint8Array().slice();
  const out=await call('propagate',[{portId:'omm',typeRef:type('OMM'),payload:seed},{portId:'grid',typeRef:type('OEM'),payload:oem([Object.assign(new Line(),{EPOCH:epoch})])}]);
  const v=OEM.getRootAsOEM(new fb.ByteBuffer(out.find(v=>v.portId==='ephemeris').payload)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES[0];
  initial={status:0,out:[v.X,v.Y,v.Z,v.X_DOT,v.Y_DOT,v.Z_DOT]};
 }
 // c.costGridMinutes (seed mode): the wall time (ms) of one propagate of the seeded set over 7 days on that grid, and nothing else
 if(c.costGridMinutes){
  const grid=oem([...Array(Math.round(7*1440/c.costGridMinutes))].map((_,k)=>Object.assign(new Line(),{EPOCH:iso(t0+(k+1)*c.costGridMinutes*60000)})));
  const start=performance.now();
  const out=await call('propagate',[{portId:'omm',typeRef:type('OMM'),payload:seed},{portId:'grid',typeRef:type('OEM'),payload:grid}]);
  const ms=performance.now()-start;
  // c.costFlown: the flown positions (km) as well
  const flown=c.costFlown?OEM.getRootAsOEM(new fb.ByteBuffer(out.find(v=>v.portId==='ephemeris').payload)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES.map(f=>[f.X,f.Y,f.Z]):undefined;
  x.sdnap_free(p);m.destroy();await h.close?.();return{costMs:ms,flown};
 }
 // c.hourly: every c.gridMinutes (60) of the 7 days after the fit (whole-day RMS), days 1, 3 and 7 among them
 const gm=c.hourly?(c.gridMinutes??60):0;
 const times=c.mode==='seed'?(c.seedGridMin?[...Array(Math.round((c.seedDays??7)*1440/c.seedGridMin)+1)].map((_,k)=>k*c.seedGridMin/1440):[0,1,3,7]):(S>0?[0]:[]).concat([...Array(NF)].map((_,k)=>S+k/48)).concat(c.hourly?[...Array(Math.round((c.forecastDays??7)*1440/gm))].map((_,k)=>S+FIT+(k+1)*gm/1440):[4,6,10].map(d=>S+d));
 const first=c.mode==='seed'?1:NF+lead;
 const params={epochJD:jd.whole,epochTimeScale:'UTC',targetJD:jd.whole+times.at(-1),targetTimeScale:'UTC',position:initial.out.slice(0,3),velocity:initial.out.slice(3),frame:'GCRF',sampleEpochsJD:times.map(d=>({jd:jd.whole+d,scale:'UTC'})),forces:{gravityMode:'EGM96',maxDegree:c.field?.[0]??70,maxOrder:c.field?.[1]??70,thirdBody:c.thirdBody??true,srp:false,drag:c.drag,massKg:1000,areaM2:(c.bterm??.044)*1000/2.2,cd:2.2},weather:{epochUTCJD:jd.whole,F107:150,F107a:150,Ap:15,Kp:3},integrator:{tolerance:c.referenceTolerance??1e-12,minStep:.01,maxStep:c.referenceMaxStep??300}};
 params.ephemerisSource='JPL_SPK';
 const kernel=fs.readFileSync(new URL('../../../../files/orbit-products/tests/fixtures/de440/de440-2026.bsp',import.meta.url));
 const key=createHash('sha256').update(fs.readFileSync(ffmPath)).update(JSON.stringify(params)).update(kernel).digest('hex');
 const file=path.join(scratch,key+'.json');let truth;
 if(fs.existsSync(file))truth=JSON.parse(fs.readFileSync(file));else{
  const h=await createStandaloneHarness('browser',ffmPath,{surface:'command'});
  const req=requestFor('propagate',params,kernel);
  req.inputs.push({portId:'earth_orientation',typeRef:TYPE,payload:encodePrw('EARTH_ORIENTATION',makeTable('PRWEarthOrientation',{ROWS:Array.from({length:Math.max(14,Math.ceil(times.at(-1))+3)},(_,k)=>makeTable('EOP',{DATE:iso(t0+(k-1)*DAY)+'Z',MJD:jd.whole-2400000.5+k-1,TAI_MINUS_UTC_SECONDS:37}))}))});
  const r=await h.invoke(req);assert.equal(r.statusCode,0,`${r.errorCode}: ${r.errorMessage}`);
  truth=decodeResult(r).samples;assert.equal(truth.length,times.length);fs.writeFileSync(file,JSON.stringify(truth));await h.close?.();
 }
 assert.ok(Math.hypot(...truth[0].position.map((v,k)=>v-initial.out[k]))<1e-9,'FFM shares the module initial position');
 const lines=truth.map((s,k)=>Object.assign(new Line(),{EPOCH:iso(t0+times[k]*DAY),X:s.position[0],Y:s.position[1],Z:s.position[2],X_DOT:s.velocity[0],Y_DOT:s.velocity[1],Z_DOT:s.velocity[2]}));
 // c.fitInput: return the fit's $OEM, $PCF and $SPW frames instead of fitting (a caller's own fit call, SPEC 12.8); c.omm: fly
 // that set instead of fitting
 if(c.fitInput){m.destroy();await h.close?.();return{ephemeris:{portId:'ephemeris',typeRef:type('OEM'),payload:oem(lines.slice(lead,lead+NF),c.fitUseable!==false)},configuration:cfg,spaceWeather:{portId:'space_weather',typeRef:type('SPW'),payload:weather}};}
 const fit=seed||c.omm?null:await call('fit',[{portId:'ephemeris',typeRef:type('OEM'),payload:oem(lines.slice(lead,lead+NF),c.fitUseable!==false)}]);
 const omm=c.omm??seed??fit.find(v=>v.portId==='elements').payload;
 const obd=fit?.find(v=>v.portId==='determination');
 const obdT=obd?OBD.getRootAsOBD(new fb.ByteBuffer(obd.payload)).unpack():null,bModel=obdT?obdT.BALLISTIC_COEFF_MODEL:null,wrms=obdT?obdT.WRMS:null;
 const out=await call('propagate',[{portId:'omm',typeRef:type('OMM'),payload:omm},{portId:'grid',typeRef:type('OEM'),payload:oem(lines.slice(first))}]);
 const flown=OEM.getRootAsOEM(new fb.ByteBuffer(out.find(v=>v.portId==='ephemeris').payload)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES;
 const parsed=OMM.getRootAsOMM(new fb.ByteBuffer(omm)).unpack();
 const classDiagnostics=[];
 if(c.probePath){
  const ph=await createStandaloneHarness('browser',c.probePath,{surface:'direct'});
  const loaded=await ph.invoke({methodId:'load_epochs',inputs:[cfg,{portId:'space_weather',typeRef:type('SPW'),payload:weather},{portId:'omm',typeRef:type('OMM'),payload:omm}]});
  assert.equal(loaded.statusCode,0,loaded.errorMessage);
  const px=ph.instance.exports,pp=px.sdnap_alloc(72),fitEpoch=Date.parse(parsed.EPOCH+'Z');
  for(const day of [0,1,3,7]){const minutes=(t0+((c.mode==='seed'?0:FIT)+day)*DAY-fitEpoch)/60000;assert.equal(px.sdnap_test_class_probe(minutes,pp),0);classDiagnostics.push({day,values:Array.from(new Float64Array(ph.memory.buffer,pp,9))});}
  px.sdnap_free(pp);await ph.close?.();
 }
 // c.dragCheck (Simpson points per pass): the drag's averaged rates against the module's independent integral over one orbit
 // (sdnap_drag_orbit_check, SPEC 16.12) at the forecast's days 0, 1, 3 and 7, each element's change over the period in meters
 const dragCheck=[];
 if(c.dragCheck){
  const ph=await createStandaloneHarness('browser',c.modulePath??wasmPath,{surface:'direct'});
  const loaded=await ph.invoke({methodId:'load_epochs',inputs:[cfg,{portId:'space_weather',typeRef:type('SPW'),payload:weather},{portId:'omm',typeRef:type('OMM'),payload:omm}]});
  assert.equal(loaded.statusCode,0,loaded.errorMessage);
  const px=ph.instance.exports,pp=px.sdnap_alloc(96),fitEpoch=Date.parse(parsed.EPOCH+'Z');
  for(const day of [0,1,3,7]){const minutes=(t0+((c.mode==='seed'?0:S+FIT)+day)*DAY-fitEpoch)/60000;assert.equal(px.sdnap_drag_orbit_check(0,minutes,c.dragCheck,pp),0);const v=Array.from(new Float64Array(ph.memory.buffer,pp,12));dragCheck.push({day,theory:v.slice(0,6),check:v.slice(6)});}
  px.sdnap_free(pp);await ph.close?.();
 }
 const result={dragCheck,name:c.name,fitted:{epoch:parsed.EPOCH,n:parsed.MEAN_MOTION,e:parsed.ECCENTRICITY,bterm:parsed.BSTAR,bModel,wrms},classDiagnostics,classProbeSha256:c.probePath?createHash('sha256').update(fs.readFileSync(c.probePath)).digest('hex'):undefined,fixture:{...c,initialization:c.mode==='seed'?'AP mean-element epoch state':'osculating perigee (argument of latitude equals argument of perigee)',initialGcrfKm:initial.out,fitEnd:iso(t0+(c.mode==='seed'?0:S+FIT)*DAY),referenceIntegrator:params.integrator},referenceStates:truth.slice(first),apSha256:createHash('sha256').update(fs.readFileSync(c.modulePath??wasmPath)).digest('hex'),epoch,reference:'FFM EGM96 70x70, Sun/Moon DE440, zero EOP, constant F10.7 150/Ap 15',kernelSha256:createHash('sha256').update(kernel).digest('hex'),n:c.n,e:c.e,perigeeKm:semimajor*(1-c.e)-6378.135,fitHours:c.mode==='seed'?0:FIT*24,days:{},ffmSha256:createHash('sha256').update(fs.readFileSync(ffmPath)).digest('hex')};
 const hours=c.seedGridMin?flown.map((_,k)=>(k+1)*c.seedGridMin/60):c.hourly?flown.map((_,k)=>(k+1)*gm/60):[24,72,168],profile=[];
 for(let k=0;k<flown.length;k++){
  const ref=truth[first+k],f=flown[k],err=[f.X-ref.position[0],f.Y-ref.position[1],f.Z-ref.position[2]];
  a(0,3).set(ref.position);a(24,3).set(ref.velocity);a(48,3).set(err);x.sdnap_frame_to_uvw(p,p+24,p+48,p+72);
  const rtn=Array.from(a(72,3),v=>v*1000);profile.push({h:hours[k],e:Math.hypot(...err)*1000,r:rtn[0],t:rtn[1],n:rtn[2]});
 }
 for(const q of profile)if(q.h===24||q.h===72||q.h===168)result.days[q.h/24]={e:q.e,r:q.r,t:q.t,n:q.n};
 if(c.hourly)result.wholeDay=Object.fromEntries([1,2,3,4,5,6,7].filter(d=>d<=(c.forecastDays??7)).map(d=>{const pr=profile.filter(q=>q.h>(d-1)*24&&q.h<=d*24);return[d,Object.fromEntries(['e','r','t','n'].map(k=>[k,Math.sqrt(pr.reduce((s,q)=>s+q[k]**2,0)/pr.length)]))];}));
 result.profile=profile;result.omm=Buffer.from(omm).toString('base64');result.flown=flown.map(f=>[f.X,f.Y,f.Z,f.X_DOT,f.Y_DOT,f.Z_DOT]);x.sdnap_free(p);m.destroy();await h.close?.();return result;
}

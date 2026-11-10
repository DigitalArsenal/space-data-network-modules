// Module-only synthetic state generation, numerical reference and RTN projection.
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
import {scratchRoot} from './scratch.mjs';
import {spwFixtureRows} from './spw-constant.mjs';
const epoch='2026-10-29T00:00:00.000',t0=Date.parse(epoch+'Z'),DAY=86400000;
import {ffmPath,checkTruth} from './ffm-truth.mjs';
const scratch=path.join(scratchRoot,'heo');
const type=n=>({schemaName:n+'.fbs',fileIdentifier:'$'+n,rootTypeName:n});
const iso=ms=>new Date(ms).toISOString().replace('Z','');
function oem(lines,fit=false,useableStop=null){
 const b=Object.assign(new Block(),{OBJECT:Object.assign(new CATT(),{NORAD_CAT_ID:99001,OBJECT_NAME:'SYNTHETIC HEO'}),CENTER_NAME:'EARTH',REFERENCE_FRAME:rfm('GCRF'),TIME_SYSTEM:timingStandard.UTC,START_TIME:lines[0].EPOCH,STOP_TIME:lines.at(-1).EPOCH,EPHEMERIS_DATA_LINES:lines});
 if(fit){b.USEABLE_START_TIME=b.START_TIME;b.USEABLE_STOP_TIME=useableStop??b.STOP_TIME;}
 return packOem(Object.assign(new OEMT(),{EPHEMERIS_DATA_BLOCK:[b]}));
}
// a 0.4 build (ocm.mjs legacyBuild) is driven as it was, through heo-model-truth-0.4.mjs
export async function runModelTruth(c){
 if(c.modulePath&&legacyBuild(c.modulePath))return(await import('./heo-model-truth-0.4.mjs')).runModelTruth(c);
 // c.fitUseable false: the fit's $OEM states no USEABLE_START_TIME / STOP_TIME (the fitter's span policy chooses the arc)
 // c.agomPrior [mean, sigma]: FIT.SRP_PRIOR with c.fitPolicy (otherwise the call's default; the truth has no SRP)
 // c.fitStartDays (S): the fit's arc starts S days after the truth's start (the truth carries its start state first)
 const FIT=c.fitDays??3,NF=FIT*48+1,S=c.fitStartDays??0,lead=S>0?1:0;
 fs.mkdirSync(scratch,{recursive:true});
 const m=await openModule(),x=m.x,p=x.sdnap_alloc(256),a=(off,n)=>new Float64Array(m.harness.memory.buffer,p+off,n),jd=jdOf(epoch);
 const rows=spwFixtureRows();
 const rowList=rowsThrough(Array.isArray(rows)?rows:rows.rows),weather=spwStream(rowList);
 // fit runs under the forces the record then states: the caps, NRLMSISE-00 (c.drag) or Jacchia 1970, both on the rows
 const tess=c.forces?.[0]??31,zon=c.forces?.[1]??20;
 const cfg=configuration({forces:{EPHEMERIS_SOURCE:'',HAS_MAXIMUM_TESSERAL_DEGREE:true,MAXIMUM_TESSERAL_DEGREE:tess,HAS_MAXIMUM_DEGREE:true,MAXIMUM_DEGREE:zon,ATMOSPHERE_MODEL:c.drag?pcfAtmosphereFamily.NRLMSISE00:pcfAtmosphereFamily.JACCHIA70,WEATHER_SOURCE:pcfWeatherSource.RECORDS},...(c.fitPolicy==='default'?(c.agomPrior?{fit:{SRP_PRIOR:prior(...c.agomPrior)}}:{}):{fit:c.fitPolicy?{DRAG_PRIOR:prior(c.fitPolicy.mean,c.fitPolicy.sigma),DRAG_PRIOR_FORM:pcfPriorForm[c.fitPolicy.form],...(c.agomPrior?{SRP_PRIOR:prior(...c.agomPrior)}:{})}:{DRAG_PRIOR:prior(c.drag?(c.bterm??.044):0,c.drag?(c.dragSigma??.1):1e-10),DRAG_PRIOR_FORM:pcfPriorForm.GAUSSIAN_SIGNED,SRP_PRIOR:prior(0,1e-10)}})});
 const h=await createStandaloneHarness('browser',c.modulePath??wasmPath,{surface:'command'});
 const call=async(methodId,inputs)=>{const r=await h.invoke({methodId,inputs:methodId==='fit'?[cfg,{portId:'space_weather',typeRef:type('SPW'),payload:weather},...inputs]:inputs});assert.equal(r.statusCode,0,`${r.errorCode}: ${r.errorMessage}`);return r.outputs;};
 // a flight: the set alone, its output times the lines' epochs in GCRF
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
 // c.costGridMinutes (seed mode): the wall time (ms) of one propagate of the seeded set over 7 days on that grid, and nothing else
 if(c.costGridMinutes){
  const grid=oem([...Array(Math.round(7*1440/c.costGridMinutes))].map((_,k)=>Object.assign(new Line(),{EPOCH:iso(t0+(k+1)*c.costGridMinutes*60000)})));
  const start=performance.now();
  await fly(seed,OEM.getRootAsOEM(new fb.ByteBuffer(grid)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES);
  const ms=performance.now()-start;x.sdnap_free(p);m.destroy();await h.close?.();return{costMs:ms};
 }
 // c.hourly: every c.gridMinutes (60) of the 7 days after the fit (whole-day RMS), days 1, 3 and 7 among them
 const gm=c.hourly?(c.gridMinutes??60):0;
 const times=c.mode==='seed'?(c.seedGridMin?[...Array(Math.round((c.seedDays??7)*1440/c.seedGridMin)+1)].map((_,k)=>k*c.seedGridMin/1440):[0,1,3,7]):(S>0?[0]:[]).concat([...Array(NF)].map((_,k)=>S+k/48)).concat(c.hourly?[...Array(Math.round((c.forecastDays??7)*1440/gm))].map((_,k)=>S+FIT+(k+1)*gm/1440):[4,6,10].map(d=>S+d));
 const first=c.mode==='seed'?1:NF+lead;
 const params={epochJD:jd.whole,epochTimeScale:'UTC',targetJD:jd.whole+times.at(-1),targetTimeScale:'UTC',position:initial.out.slice(0,3),velocity:initial.out.slice(3),frame:'GCRF',sampleEpochsJD:times.map(d=>({jd:jd.whole+d,scale:'UTC'})),forces:{gravityMode:'EGM96',maxDegree:c.field?.[0]??70,maxOrder:c.field?.[1]??70,thirdBody:c.thirdBody??true,srp:false,drag:c.drag,massKg:1000,areaM2:(c.bterm??.044)*1000/2.2,cd:2.2},weather:{epochUTCJD:jd.whole,F107:150,F107a:150,Ap:15,Kp:3},integrator:{tolerance:c.referenceTolerance??1e-12,minStep:.01,maxStep:c.referenceMaxStep??300}};
 params.ephemerisSource='JPL_SPK';
 // c.maneuvers: FFM impulses in the truth ([{days, deltaV km/s, frame}], days from the truth's start)
 if(c.maneuvers)params.maneuvers=c.maneuvers.map(q=>({epochJD:jd.whole+jd.frac+q.days,epochTimeScale:'UTC',deltaV:q.deltaV,frame:q.frame}));
 const kernel=fs.readFileSync(new URL('../../../../files/orbit-products/tests/fixtures/de440/de440-2026.bsp',import.meta.url));
 const truthOf=async(params)=>{
  checkTruth();
  const key=createHash('sha256').update(fs.readFileSync(ffmPath)).update(JSON.stringify(params)).update(kernel).digest('hex');
  const file=path.join(scratch,key+'.json');
  if(fs.existsSync(file))return JSON.parse(fs.readFileSync(file));
  const h=await createStandaloneHarness('browser',ffmPath,{surface:'command'});
  const req=requestFor('propagate',params,kernel);
  req.inputs.push({portId:'earth_orientation',typeRef:TYPE,payload:encodePrw('EARTH_ORIENTATION',makeTable('PRWEarthOrientation',{ROWS:Array.from({length:Math.max(14,Math.ceil(times.at(-1))+3)},(_,k)=>makeTable('EOP',{DATE:iso(t0+(k-1)*DAY)+'Z',MJD:jd.whole-2400000.5+k-1,TAI_MINUS_UTC_SECONDS:37}))}))});
  const r=await h.invoke(req);assert.equal(r.statusCode,0,`${r.errorCode}: ${r.errorMessage}`);
  const samples=decodeResult(r).samples;assert.equal(samples.length,times.length);fs.writeFileSync(file,JSON.stringify(samples));await h.close?.();
  return samples;
 };
 const truth=await truthOf(params);
 // c.tailManeuvers: the held-out tail (c.fitTailStates) and the forecast's truth come from a second FFM run with these
 // impulses, the fit's arc from the first (a step after the arc leaves the arc's states bit-identical)
 const tailTruth=c.tailManeuvers?await truthOf({...params,maneuvers:c.tailManeuvers.map(q=>({epochJD:jd.whole+jd.frac+q.days,epochTimeScale:'UTC',deltaV:q.deltaV,frame:q.frame}))}):truth;
 assert.ok(Math.hypot(...truth[0].position.map((v,k)=>v-initial.out[k]))<1e-9,'FFM shares the module initial position');
 const lineOf=(s,k)=>Object.assign(new Line(),{EPOCH:iso(t0+times[k]*DAY),X:s.position[0],Y:s.position[1],Z:s.position[2],X_DOT:s.velocity[0],Y_DOT:s.velocity[1],Z_DOT:s.velocity[2]});
 const lines=truth.map(lineOf),tailLines=tailTruth.map(lineOf);
 // c.fitInput: return the fit's $OEM, $PCF and $SPW frames instead of fitting (a caller's own fit call, SPEC 12.8); c.omm: fly
 // that set instead of fitting
 if(c.fitInput){m.destroy();await h.close?.();return{ephemeris:{portId:'ephemeris',typeRef:type('OEM'),payload:oem(lines.slice(lead,lead+NF),c.fitUseable!==false)},configuration:cfg,spaceWeather:{portId:'space_weather',typeRef:type('SPW'),payload:weather}};}
 // c.fitTailStates: that many states after the arc ride in the fit's $OEM after its USEABLE_STOP_TIME (held out)
 // c.fitNoise {meters, seed}: independent Gaussian noise of that size on each coordinate of the fit's states (a perturbed
 // copy of the arc; a fixed seed), the scored truth unchanged
 const noisy=ls=>{if(!c.fitNoise)return ls;let s=c.fitNoise.seed>>>0;const u=()=>((s=(Math.imul(s,1664525)+1013904223)>>>0)+.5)/4294967296;const g=()=>Math.sqrt(-2*Math.log(u()))*Math.cos(2*Math.PI*u());const k=c.fitNoise.meters/1000;return ls.map(L=>Object.assign(new Line(),{...L,X:L.X+k*g(),Y:L.Y+k*g(),Z:L.Z+k*g()}));};
 const fit=seed||c.omm?null:await call('fit',[{portId:'ephemeris',typeRef:type('OEM'),payload:c.fitTailStates?oem(lines.slice(lead,lead+NF).concat(tailLines.slice(first,first+c.fitTailStates)),true,lines[lead+NF-1].EPOCH):oem(noisy(lines.slice(lead,lead+NF)),c.fitUseable!==false)}]);
 const omm=c.omm??seed??fit.find(v=>v.portId==='elements').payload;
 const out=await fly(omm,lines.slice(first));
 const flown=OEM.getRootAsOEM(new fb.ByteBuffer(out.find(v=>v.portId==='ephemeris').payload)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES;
 const parsed=fittedOf(omm);
 const logNormal=c.fitPolicy==='default'||c.fitPolicy?.form==='LOG_NORMAL';
 const classDiagnostics=[];
 if(c.probePath){
  const ph=await createStandaloneHarness('browser',c.probePath,{surface:'direct'});
  const loaded=await ph.invoke({methodId:'load_epochs',inputs:[{portId:'ocm',typeRef:OCM_TYPE('OCM'),payload:omm}]});
  assert.equal(loaded.statusCode,0,loaded.errorMessage);
  const px=ph.instance.exports,pp=px.sdnap_alloc(72),fitEpoch=Date.parse(parsed.epoch+'Z');
  for(const day of [0,1,3,7]){const minutes=(t0+((c.mode==='seed'?0:FIT)+day)*DAY-fitEpoch)/60000;assert.equal(px.sdnap_test_class_probe(minutes,pp),0);classDiagnostics.push({day,values:Array.from(new Float64Array(ph.memory.buffer,pp,9))});}
  px.sdnap_free(pp);await ph.close?.();
 }
 // c.dragCheck (Simpson points per pass): the drag's averaged rates against the module's independent integral over one orbit
 // (sdnap_drag_orbit_check, SPEC 16.12) at the forecast's days 0, 1, 3 and 7, each element's change over the period in meters
 const dragCheck=[];
 if(c.dragCheck){
  const ph=await createStandaloneHarness('browser',c.modulePath??wasmPath,{surface:'direct'});
  const loaded=await ph.invoke({methodId:'load_epochs',inputs:[{portId:'ocm',typeRef:OCM_TYPE('OCM'),payload:omm}]});
  assert.equal(loaded.statusCode,0,loaded.errorMessage);
  const px=ph.instance.exports,pp=px.sdnap_alloc(96),fitEpoch=Date.parse(parsed.epoch+'Z');
  for(const day of [0,1,3,7]){const minutes=(t0+((c.mode==='seed'?0:S+FIT)+day)*DAY-fitEpoch)/60000;assert.equal(px.sdnap_drag_orbit_check(0,minutes,c.dragCheck,pp),0);const v=Array.from(new Float64Array(ph.memory.buffer,pp,12));dragCheck.push({day,theory:v.slice(0,6),check:v.slice(6)});}
  px.sdnap_free(pp);await ph.close?.();
 }
 const result={dragCheck,name:c.name,fitted:{epoch:parsed.epoch,n:parsed.n,e:parsed.e,bterm:parsed.bterm,agom:parsed.agom,comment:parsed.comment,sigmaLog:parsed.sigmaLog,wrms:fit?parsed.wrms:null,accepted:fit?parsed.accepted:null,
  // the posterior in the words the 0.4 $OBD's BALLISTIC_COEFF_MODEL gave it, from the record's covariance (sigma_B, and sigma_B / B under LOG_NORMAL), so
  // an E2E reads a 0.4 baseline and this build alike; the drag-prior path is the record's OD COMMENT
  bModel:fit?(logNormal?`posterior sigma of the log ${parsed.sigmaLog}; posterior median ${parsed.bterm} m^2/kg`:`posterior ${parsed.bterm} +- ${parsed.sigmaLog*Math.abs(parsed.bterm)} m^2/kg`)+(/drag prior: [^;]*/.exec(parsed.comment)?`; ${/drag prior: [^;]*/.exec(parsed.comment)[0]}; arc`:''):null},classDiagnostics,classProbeSha256:c.probePath?createHash('sha256').update(fs.readFileSync(c.probePath)).digest('hex'):undefined,fixture:{...c,initialization:c.mode==='seed'?'AP mean-element epoch state':'osculating perigee (argument of latitude equals argument of perigee)',initialGcrfKm:initial.out,fitEnd:iso(t0+(c.mode==='seed'?0:S+FIT)*DAY),referenceIntegrator:params.integrator},referenceStates:tailTruth.slice(first),apSha256:createHash('sha256').update(fs.readFileSync(c.modulePath??wasmPath)).digest('hex'),epoch,reference:'FFM EGM96 70x70, Sun/Moon DE440, zero EOP, constant F10.7 150/Ap 15',kernelSha256:createHash('sha256').update(kernel).digest('hex'),n:c.n,e:c.e,perigeeKm:semimajor*(1-c.e)-6378.135,fitHours:c.mode==='seed'?0:FIT*24,days:{},ffmSha256:createHash('sha256').update(fs.readFileSync(ffmPath)).digest('hex')};
 const hours=c.seedGridMin?flown.map((_,k)=>(k+1)*c.seedGridMin/60):c.hourly?flown.map((_,k)=>(k+1)*gm/60):[24,72,168],profile=[];
 for(let k=0;k<flown.length;k++){
  const ref=tailTruth[first+k],f=flown[k],err=[f.X-ref.position[0],f.Y-ref.position[1],f.Z-ref.position[2]];
  a(0,3).set(ref.position);a(24,3).set(ref.velocity);a(48,3).set(err);x.sdnap_frame_to_uvw(p,p+24,p+48,p+72);
  const rtn=Array.from(a(72,3),v=>v*1000);profile.push({h:hours[k],e:Math.hypot(...err)*1000,r:rtn[0],t:rtn[1],n:rtn[2]});
 }
 for(const q of profile)if(q.h===24||q.h===72||q.h===168)result.days[q.h/24]={e:q.e,r:q.r,t:q.t,n:q.n};
 if(c.hourly)result.wholeDay=Object.fromEntries([1,2,3,4,5,6,7].filter(d=>d<=(c.forecastDays??7)).map(d=>{const pr=profile.filter(q=>q.h>(d-1)*24&&q.h<=d*24);return[d,Object.fromEntries(['e','r','t','n'].map(k=>[k,Math.sqrt(pr.reduce((s,q)=>s+q[k]**2,0)/pr.length)]))];}));
 result.profile=profile;result.omm=Buffer.from(omm).toString('base64');result.flown=flown.map(f=>[f.X,f.Y,f.Z,f.X_DOT,f.Y_DOT,f.Z_DOT]);x.sdnap_free(p);m.destroy();await h.close?.();return result;
}

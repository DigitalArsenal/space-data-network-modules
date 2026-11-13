// stack #595 model truth: the stated zonal field, DE440 Sun and Moon, solid Earth tide and relativity;
// no drag or radiation. GCRF km and km/s, UTC, every 300 s from cutoff -72 h through +120 h.
// The start is the fixed 0.6.48 AP state, so changing the tested module cannot change its truth.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import * as fb from 'flatbuffers';
import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {OEM, OEMT} from 'spacedatastandards.org/lib/js/OEM/OEM.js';
import {CATT} from 'spacedatastandards.org/lib/js/OEM/CAT.js';
import {ephemerisDataBlockT as Block} from 'spacedatastandards.org/lib/js/OEM/ephemerisDataBlock.js';
import {ephemerisDataLineT as Line} from 'spacedatastandards.org/lib/js/OEM/ephemerisDataLine.js';
import {timingStandard} from 'spacedatastandards.org/lib/js/OEM/timingStandard.js';
import {pcfOutputFrame} from 'spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js';
import {pcfWeatherSource} from 'spacedatastandards.org/lib/js/PCF/pcfWeatherSource.js';
import {seedOcm,flight,fittedOf,T} from './ocm.mjs';
import {configuration,prior,pcfPriorForm,pcfAtmosphereFamily} from './pcf.mjs';
import {packOem,rfm} from './frames.mjs';
import {ffmPath,checkTruth} from './ffm-truth.mjs';
import {sharedDir,scratchDir,writeWhole} from './scratch.mjs';
import {requestFor,decodeResult,decodePrw,encodePrw,makeTable,TYPE,sds} from '../../../ffm/tests/lib/prwCodec.mjs';

const DAY=86400000, STEP=300000, MU=398600.4418;
const sha=b=>createHash('sha256').update(b).digest('hex');
const iso=t=>new Date(t).toISOString().replace('Z','');
const linesOf=r=>OEM.getRootAsOEM(new fb.ByteBuffer(r.outputs.find(v=>v.portId==='ephemeris').payload)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES;
async function call(h,methodId,inputs){const r=await h.invoke({methodId,inputs});assert.equal(r.statusCode,0,`${methodId}: ${r.errorCode}: ${r.errorMessage}`);return r;}
export const CASES=[
 {id:'grid-hp400-e0.05-i55',n:14.4053115722,e:0.05,i:55,raan:68.2,argp:322,ma:284,cutoff:'2026-03-30'},
 {id:'grid-hp300-e0.01-i55',n:15.6701288499,e:0.01,i:55,raan:140,argp:292,ma:309.6,cutoff:'2026-06-22'},
];
export function baselinePath(){
 const root=fileURLToPath(new URL('../../../../',import.meta.url));
 const bytes=execFileSync('git',['-C',root,'show','01c5fc32a5c2ea8f67784f0fdbccb2b718f2b6eb:propagator/sdn-ap/dist/isomorphic/module.wasm'],{maxBuffer:1<<26});
 assert.equal(sha(bytes),'7abf32de5eadbf21fd6b2992b0eb8e113ed20b3cf6efe7a56d2f2f9ee6565e39');
 const file=path.join(scratchDir('zonal-long-period'),'baseline.wasm');writeWhole(file,bytes);return file;
}
export async function zonalTruth(c,{degree=70,order=0}={}){
 checkTruth();
 const start=Date.parse(c.cutoff+'T00:00:00Z')-3*DAY, epoch=iso(start), jd=start/DAY+2440587.5;
 const times=Array.from({length:8*DAY/STEP+1},(_,k)=>start+k*STEP);
 const seed=seedOcm({...c,epoch,norad:99498,tesseral:31,zonal:20});
 const base=await createStandaloneHarness('browser',baselinePath(),{surface:'direct'});
 const initial=linesOf(await call(base,'propagate',flight([seed],{output:{EPOCHS:[epoch],FRAME:pcfOutputFrame.GCRF}})))[0];
 await base.close?.();
 const kernel=fs.readFileSync(new URL('../../../../files/orbit-products/tests/fixtures/de440/de440-2026.bsp',import.meta.url));
 const params={epochJD:jd,epochTimeScale:'UTC',targetJD:jd+8,targetTimeScale:'UTC',
  position:[initial.X,initial.Y,initial.Z],velocity:[initial.X_DOT,initial.Y_DOT,initial.Z_DOT],frame:'GCRF',
  sampleEpochsJD:times.map(t=>({jd:t/DAY+2440587.5,scale:'UTC'})),
  forces:{gravityMode:'EGM2008',maxDegree:degree,maxOrder:order,thirdBody:true,srp:false,drag:false},
  integrator:{tolerance:1e-13,minStep:1e-4,maxStep:120},ephemerisSource:'JPL_SPK'};
 const req=requestFor('propagate',params,kernel);
 const execution=decodePrw(req.inputs[0].payload).EXECUTION_REQUEST;
 execution.FORCES.SOLID_TIDES=sds.pcfSolidTideModel.IERS_2010;
 execution.FORCES.RELATIVITY=sds.pcfRelativityTerms.IERS_2010;
 req.inputs[0].payload=encodePrw('EXECUTION_REQUEST',execution);
 req.inputs.push({portId:'earth_orientation',typeRef:TYPE,payload:encodePrw('EARTH_ORIENTATION',makeTable('PRWEarthOrientation',{
  ROWS:Array.from({length:13},(_,k)=>makeTable('EOP',{DATE:iso(start+(k-2)*DAY)+'Z',MJD:jd-2400000.5+k-2,TAI_MINUS_UTC_SECONDS:37}))}))});
 const hash=createHash('sha256').update(fs.readFileSync(ffmPath));for(const input of req.inputs)hash.update(input.portId).update(input.payload);
 const file=path.join(sharedDir('zonal-long-period'),hash.digest('hex')+'.json');
 let samples;
 if(fs.existsSync(file))samples=JSON.parse(fs.readFileSync(file));else{
  const ffm=await createStandaloneHarness('browser',ffmPath,{surface:'direct'});
  const r=await ffm.invoke(req);assert.equal(r.statusCode,0,r.errorMessage);
  samples=decodeResult(r).samples;assert.equal(samples.length,times.length);writeWhole(file,JSON.stringify(samples));await ffm.close?.();
 }
 const lines=samples.map((s,k)=>Object.assign(new Line(),{EPOCH:iso(times[k]),X:s.position[0],Y:s.position[1],Z:s.position[2],X_DOT:s.velocity[0],Y_DOT:s.velocity[1],Z_DOT:s.velocity[2]})).slice(3*DAY/STEP);
 const block=Object.assign(new Block(),{OBJECT:Object.assign(new CATT(),{NORAD_CAT_ID:99498,OBJECT_NAME:'SYNTHETIC'}),CENTER_NAME:'EARTH',REFERENCE_FRAME:rfm('GCRF'),TIME_SYSTEM:timingStandard.UTC,
  START_TIME:lines[0].EPOCH,STOP_TIME:lines.at(-1).EPOCH,USEABLE_START_TIME:lines[0].EPOCH,USEABLE_STOP_TIME:lines.at(-1).EPOCH,EPHEMERIS_DATA_LINES:lines});
 return {lines,ephemeris:{portId:'ephemeris',typeRef:T('OEM'),payload:packOem(Object.assign(new OEMT(),{EPHEMERIS_DATA_BLOCK:[block]}))},cache:file};
}
const unit=a=>{const n=Math.hypot(...a);return a.map(v=>v/n);};
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
function leastSquares(points){
 const A=Array.from({length:4},()=>Array(5).fill(0));
 for(const p of points){const x=[1,p.h,Math.cos(p.M),Math.sin(p.M)];for(let i=0;i<4;i++){for(let j=0;j<4;j++)A[i][j]+=x[i]*x[j];A[i][4]+=x[i]*p.T;}}
 for(let k=0;k<4;k++){let pivot=k;for(let i=k+1;i<4;i++)if(Math.abs(A[i][k])>Math.abs(A[pivot][k]))pivot=i;[A[k],A[pivot]]=[A[pivot],A[k]];
  assert.ok(Math.abs(A[k][k])>1e-12);for(let i=k+1;i<4;i++){const q=A[i][k]/A[k][k];for(let j=k;j<=4;j++)A[i][j]-=q*A[k][j];}}
 const x=Array(4);for(let i=3;i>=0;i--){let y=A[i][4];for(let j=i+1;j<4;j++)y-=A[i][j]*x[j];x[i]=y/A[i][i];}return x;
}
export async function fitZonalTruth(modulePath,truth,{zonal=70,tesseral=0,residuals=false}={}){
 const h=await createStandaloneHarness('browser',modulePath,{surface:'direct'});
 const config=configuration({theory:'AP',forces:{EPHEMERIS_SOURCE:'',HAS_MAXIMUM_TESSERAL_DEGREE:true,MAXIMUM_TESSERAL_DEGREE:tesseral,HAS_MAXIMUM_DEGREE:true,MAXIMUM_DEGREE:zonal,
  SOLID_TIDES:1,ATMOSPHERE_MODEL:pcfAtmosphereFamily.JACCHIA70,WEATHER_SOURCE:pcfWeatherSource.THEORY_FLUX_MODEL},
  fit:{DRAG_PRIOR:prior(0,1e-12),DRAG_PRIOR_FORM:pcfPriorForm.GAUSSIAN_SIGNED,SRP_PRIOR:prior(0,1e-12),SRP_PRIOR_FORM:pcfPriorForm.GAUSSIAN_SIGNED}});
 const started=performance.now();const fit=await call(h,'fit',[config,truth.ephemeris]);const fitS=(performance.now()-started)/1000;
 const set=fit.outputs.find(v=>v.portId==='elements').payload;
 const flown=linesOf(await call(h,'propagate',flight([set],{output:{EPOCHS:truth.lines.map(l=>l.EPOCH),FRAME:pcfOutputFrame.GCRF}})));
 assert.equal(flown.length,truth.lines.length);
 const profile=flown.map((s,k)=>{const q=truth.lines[k],r=[q.X,q.Y,q.Z],v=[q.X_DOT,q.Y_DOT,q.Z_DOT],d=[s.X-q.X,s.Y-q.Y,s.Z-q.Z],along=cross(unit(cross(r,v)),unit(r));
  const rr=Math.hypot(...r),v2=v.reduce((s,x)=>s+x*x,0),a=1/(2/rr-v2/MU),rv=r.reduce((s,x,j)=>s+x*v[j],0),e=Math.hypot(...r.map((x,j)=>((v2-MU/rr)*x-rv*v[j])/MU));
  const E=Math.atan2(rv/Math.sqrt(MU*a),1-rr/a);return {h:k/12,D:1000*Math.hypot(...d),T:1000*d.reduce((s,x,j)=>s+x*along[j],0),M:E-e*Math.sin(E)};});
 const oncePerRev=[1,2,3,4,5].map(day=>{const points=profile.filter(p=>p.h>=24*(day-1)&&(day===5?p.h<=120:p.h<24*day));const x=leastSquares(points);return Math.hypot(x[2],x[3]);});
 const result={D:Math.max(...profile.map(p=>p.D)),oncePerRev,fitS,fitRmsM:fittedOf(set).wrms*1000,sha256:sha(fs.readFileSync(modulePath))};
 if(residuals)result.residuals=flown.map((s,k)=>[s.X-truth.lines[k].X,s.Y-truth.lines[k].Y,s.Z-truth.lines[k].Z].map(v=>1000*v));
 await h.close?.();return result;
}

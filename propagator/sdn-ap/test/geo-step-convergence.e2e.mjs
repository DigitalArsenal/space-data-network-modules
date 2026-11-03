#!/usr/bin/env node
// Registered before generating results: unfitted AP GEO and inclined GEO,
// epoch 2026-10-29, n=1.0027 rev/day, e=.0002, i=.1/15 deg,
// RAAN=40, argument of perigee=30, M=20 deg, B=AGOM=0, FORCES=(31,20).
// Compare days 1/3/7 with 95/16-minute RK3; select the longest of
// 47.5, 38, 95/3 minutes meeting <5 m at day 7 for both fixtures.
// Cost: median of 9 alternating cold propagation calls, 5 days at 30-min
// cadence (241 states), after 2 warm-ups; same input and module interface.
// AP6 windows were all read by the gap study. Confirmation must use new
// cutoff windows absent from those stores, before the holds; no read window
// can be called confirmation. Report every admitted window and both arms.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import * as fb from 'flatbuffers';
import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {OMM,OMMT} from 'spacedatastandards.org/lib/js/OMM/OMM.js';
import {OMMUserDefinedParameterT as U} from 'spacedatastandards.org/lib/js/OMM/OMMUserDefinedParameter.js';
import {OEM,OEMT} from 'spacedatastandards.org/lib/js/OEM/OEM.js';
import {ephemerisDataBlockT as Block} from 'spacedatastandards.org/lib/js/OEM/ephemerisDataBlock.js';
import {ephemerisDataLineT as Line} from 'spacedatastandards.org/lib/js/OEM/ephemerisDataLine.js';
import {timingStandard} from 'spacedatastandards.org/lib/js/OEM/timingStandard.js';
import {configuration} from './lib/pcf.mjs';
import {packOem,rfm} from './lib/frames.mjs';
import {wasmPath} from './lib/module.mjs';
import {confirmWindows} from './lib/geo-window-confirmation.mjs';
import {buildDiagnostic} from './lib/ap-diagnostic.mjs';
const epoch='2026-10-29T00:00:00.000',t0=Date.parse(epoch+'Z');
const type=n=>({schemaName:n+'.fbs',fileIdentifier:'$'+n,rootTypeName:n});
function seed(i){const b=new fb.Builder(1024);OMM.finishOMMBuffer(b,Object.assign(new OMMT(),{EPOCH:epoch,MEAN_ELEMENT_THEORY:1,MEAN_MOTION:1.0027,ECCENTRICITY:.0002,INCLINATION:i,RA_OF_ASC_NODE:40,ARG_OF_PERICENTER:30,MEAN_ANOMALY:20,NORAD_CAT_ID:99004,BSTAR:0,MEAN_MOTION_DDOT:0,USER_DEFINED_PARAMETERS:[Object.assign(new U(),{PARAM_NAME:'SDNAP_GRAVITY_TERMS',PARAM_VALUE:'31,20'})]}).pack(b));return b.asUint8Array().slice();}
function grid(days){const lines=days.map(d=>Object.assign(new Line(),{EPOCH:new Date(t0+d*86400000).toISOString().replace('Z','')}));return packOem(Object.assign(new OEMT(),{EPHEMERIS_DATA_BLOCK:[Object.assign(new Block(),{CENTER_NAME:'EARTH',REFERENCE_FRAME:rfm('GCRF'),TIME_SYSTEM:timingStandard.UTC,START_TIME:lines[0].EPOCH,STOP_TIME:lines.at(-1).EPOCH,EPHEMERIS_DATA_LINES:lines})]}));}
const cfg=configuration({theory:'SGP4XP',forces:{EPHEMERIS_SOURCE:'',HAS_MAXIMUM_TESSERAL_DEGREE:true,MAXIMUM_TESSERAL_DEGREE:31,HAS_MAXIMUM_DEGREE:true,MAXIMUM_DEGREE:20,ENABLE_DRAG:false}});
async function open(file){const h=await createStandaloneHarness('browser',file,{surface:'command'});return{h,async fly(i,days){const req={methodId:'propagate',inputs:[cfg,{portId:'omm',typeRef:type('OMM'),payload:seed(i)},{portId:'grid',typeRef:type('OEM'),payload:grid(days)}]};const start=performance.now(),r=await h.invoke(req),ms=performance.now()-start;assert.equal(r.statusCode,0,r.errorMessage);const states=OEM.getRootAsOEM(new fb.ByteBuffer(r.outputs.find(v=>v.portId==='ephemeris').payload)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES.map(v=>[v.X,v.Y,v.Z]);return{ms,states};}};}
function variant(step){return buildDiagnostic('geo-step-'+String(step).replace('.','_'),' ',s=>{let v=s.replace(/constexpr double kLongPeriodStep = 95\.0;/,`constexpr double kLongPeriodStep = ${step};`);v=v.replace(/return ctx\.ap_frame && ctx\.resonance == 1 \? [^;]+ : kLongPeriodStep;/,'return kLongPeriodStep;');return v;});}
const baselinePath=variant(95),baseline=await open(baselinePath),reference=await open(variant(95/16));
const pilot=process.argv.includes('--pilot'),steps=pilot?[47.5,38,95/3]:['production'];
const report={registered:{epoch,n:1.0027,e:.0002,inclinations:[.1,15],raan:40,argp:30,ma:20,forces:[31,20],referenceStepMinutes:95/16},candidates:[]};
for(const step of steps){const candidate=await open(step==='production'?wasmPath:variant(step));const item={step,fixtures:[]};
 for(const i of [.1,15]){const days=[1,3,7],a=await baseline.fly(i,days),b=await candidate.fly(i,days),r=await reference.fly(i,days);const distance=(x,y)=>Math.hypot(...x.map((v,k)=>v-y[k]))*1000;item.fixtures.push({inclination:i,days:days.map((day,k)=>({day,baselineMeters:distance(a.states[k],r.states[k]),candidateMeters:distance(b.states[k],r.states[k])}))});}
 const dense=Array.from({length:241},(_,k)=>k/48),old=[],now=[];
 for(let k=0;k<11;k++){let a,b;if(k%2){b=await candidate.fly(.1,dense);a=await baseline.fly(.1,dense);}else{a=await baseline.fly(.1,dense);b=await candidate.fly(.1,dense);}if(k>=2){old.push(a.ms);now.push(b.ms);}}
 const median=x=>x.toSorted((a,b)=>a-b)[Math.floor(x.length/2)];item.cost={baselineMilliseconds:median(old),candidateMilliseconds:median(now),ratio:median(now)/median(old),baselineSamples:old,candidateSamples:now};
 report.candidates.push(item);console.log(JSON.stringify(item));await candidate.h.close?.();
 if(!pilot){for(const f of item.fixtures)assert.ok(f.days.at(-1).candidateMeters<5,'day-7 difference under 5 m');assert.ok(item.cost.ratio<2,'flight cost under twice baseline');}
}
await baseline.h.close?.();await reference.h.close?.();
if(!pilot)report.confirmation=await confirmWindows(baselinePath,wasmPath);
if(process.env.SDN_AP_GEO_REPORT)fs.writeFileSync(process.env.SDN_AP_GEO_REPORT,JSON.stringify(report,null,2)+'\n');
if(!pilot){execFileSync(process.execPath,[new URL('./conformance.e2e.mjs',import.meta.url).pathname,'--reproduce',new URL('./results/conformance.json',import.meta.url).pathname],{stdio:'inherit',env:{...process.env,SDN_AP_ORACLE_ROOT:process.env.SDN_AP_ORACLE_ROOT??'/Users/tj/software/spacedatanetwork-stack/repos/main-packages/space-data-network-closed-modules/packages/sgp4-xp-oracle'}});console.log('GEO step convergence E2E: PASS');}

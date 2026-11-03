#!/usr/bin/env node
// Registered before model-truth generation: modules-sdn-ap-heo-half-day-20261103.
// Synthetic GCRF/UTC states from module conversions; FFM EGM96 70x70, Sun/Moon,
// DE440, zero EOP, no SRP, NRLMSISE00 only on Molniya. Constant synthetic F10.7=150, Ap=15.
// Fit the first 72 h, then measure forward RTN errors at leads 1,3,7 days.
// The originally registered sidereal half-day, e=.72 case: its day-7 sample, re-recorded at 0.4.11 (201.97 m, 1 h after
// a perigee), within 0.5 m; the fixtures' whole-day RMS is judged in third-body-short-period-eccentric.e2e.mjs.
// Retain the literal 12 h, 55-degree diagnostic plus Molniya and GTO as reported bounds.
// No JavaScript orbital dynamics. Default-FORCES XP must retain its digest.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {runModelTruth} from './lib/heo-model-truth.mjs';
const cases=[
 {name:'half-day-critical',n:2.0059,e:.72,i:63.4,raan:300,argp:270,ma:10,drag:false},
 {name:'Molniya',n:2,e:.74,i:63.4,raan:300,argp:270,ma:10,drag:true},
 {name:'GTO',n:2.40,e:.72,i:27,raan:40,argp:270,ma:10,drag:false},
 {name:'12-hour-55deg',n:2,e:.72,i:55,raan:300,argp:270,ma:10,drag:false},
];
// Diagnostic registration: a mean-element AP set seeds FFM at its epoch;
// no fit, same forces and the same 1/3/7-day forward thresholds. This checks
// whether the review's "synthetic set" comparison used a shared epoch state.
if(process.argv.includes('--seed-diagnostic')){const c={...cases[0],mode:'seed'};cases.splice(0,cases.length,c);}
// Registered literal 12-hour diagnostic (2 rev/day); retain the sidereal case.
if(process.argv.includes('--exact-12h-diagnostic')){const c={...cases[0],name:'12-hour',n:2};cases.splice(0,cases.length,c);}
// Registered reference-convergence check: same initial state, tenfold tighter
// RK78 tolerance and half the maximum step; report the change at each lead.
if(process.argv.includes('--reference-convergence')){
 const refined=process.argv.includes('--refined');
 const a=await runModelTruth({...cases[0],...(refined?{referenceTolerance:1e-13,referenceMaxStep:150}:{})}),b=await runModelTruth({...cases[0],referenceTolerance:refined?1e-14:1e-13,referenceMaxStep:refined?75:150});
 const differences=a.referenceStates.map((v,k)=>({day:[1,3,7][k],meters:1000*Math.hypot(...v.position.map((x,j)=>x-b.referenceStates[k].position[j]))}));
 console.log(JSON.stringify({referenceConvergence:differences,standard:a,tight:b}));
 assert.ok(differences.every(v=>v.meters<.1),'FFM reference convergence below 0.1 m');
 process.exit(0);
}
const results=[];
for(const c of cases){const result=await runModelTruth(c);results.push(result);console.log(JSON.stringify(result));}
if(process.env.SDN_AP_HEO_REPORT)fs.writeFileSync(process.env.SDN_AP_HEO_REPORT,JSON.stringify(results,null,2)+'\n');
for(const result of results)for(const day of [1,3,7])assert.ok(Number.isFinite(result.days[day].e),'finite forward error');
execFileSync(process.execPath,[new URL('./conformance.e2e.mjs',import.meta.url).pathname,'--reproduce',new URL('./results/conformance.json',import.meta.url).pathname],{stdio:'inherit',env:{...process.env,SDN_AP_ORACLE_ROOT:process.env.SDN_AP_ORACLE_ROOT??'/Users/tj/software/spacedatanetwork-stack/repos/main-packages/space-data-network-closed-modules/packages/sgp4-xp-oracle'}});
assert.ok(Math.abs(results[0].days[7].e-60.10)<=.5,`half-day day 7: ${results[0].days[7].e} m, 0.4.15 60.10 m (0.4.11 to 0.4.14: 201.97 m; SPEC 16.11)`);
console.log('HEO model truth E2E: PASS');

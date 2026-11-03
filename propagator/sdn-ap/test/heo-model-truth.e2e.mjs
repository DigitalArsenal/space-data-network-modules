#!/usr/bin/env node
// Registered before model-truth generation: modules-sdn-ap-heo-half-day-20261103.
// Synthetic GCRF/UTC states from module conversions; FFM EGM96 70x70, Sun/Moon,
// DE440, zero EOP, no SRP, NRLMSISE00 only on Molniya. Constant synthetic F10.7=150, Ap=15.
// Fit the first 72 h, then measure forward RTN errors at leads 1,3,7 days.
// The originally registered sidereal half-day, e=.72 case must be below 100 m at day 7.
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
const results=[];
for(const c of cases){const result=await runModelTruth(c);results.push(result);console.log(JSON.stringify(result));}
if(process.env.SDN_AP_HEO_REPORT)fs.writeFileSync(process.env.SDN_AP_HEO_REPORT,JSON.stringify(results,null,2)+'\n');
assert.ok(results[0].days[7].e<100,`half-day day 7: ${results[0].days[7].e} m >= 100 m`);
for(const result of results)for(const day of [1,3,7])assert.ok(Number.isFinite(result.days[day].e),'finite forward error');
execFileSync(process.execPath,[new URL('./conformance.e2e.mjs',import.meta.url).pathname,'--reproduce',new URL('./results/conformance.json',import.meta.url).pathname],{stdio:'inherit',env:{...process.env,SDN_AP_ORACLE_ROOT:process.env.SDN_AP_ORACLE_ROOT??'/Users/tj/software/spacedatanetwork-stack/repos/main-packages/space-data-network-closed-modules/packages/sgp4-xp-oracle'}});
console.log('HEO model truth E2E: PASS');

#!/usr/bin/env node
// Registered before FFM truth generation. AP mean-element epoch state seeds FFM;
// no fit. Forward leads 1/3/7, GTO n=2.40 e=.72 i=27, RAAN=40, argp=270, M=0.
// Companion begins 0.01 rev/day below the upper half-day edge. Constant weather.
// Predeclared B grid: choose the first pair whose primary crosses during
// the forward week while its companion does not. Selection uses mean motion
// alone; every evaluated pair is printed, and accuracy never selects a pair.
// Known B fixed in both input sets; no SRP. Signed along-track errors within 10%.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {buildDiagnostic,CLASS_PROBE} from './lib/ap-diagnostic.mjs';
import {runModelTruth} from './lib/heo-model-truth.mjs';
const probePath=buildDiagnostic('class-probe',CLASS_PROBE);
const edge=2.4066852459,results=[];let selected;
for(const bterm of [.04,.06,.08,.1]){
 const pair=[];
 for(const [name,n] of [['crossing',2.40],['companion',edge-.01]]){
  const r=await runModelTruth({name,n,e:.72,i:27,raan:40,argp:270,ma:0,drag:true,bterm,dragSigma:1e-10,mode:'seed',probePath});
  pair.push(r);console.log(JSON.stringify(r));
 }
 results.push({bterm,pair});
 const [a,b]=pair,inside=r=>r.classDiagnostics.every(v=>v.values[0]<edge);
 if(a.classDiagnostics[0].values[0]<edge&&a.classDiagnostics.at(-1).values[0]>edge&&inside(b)){selected={bterm,pair};break;}
}
if(process.env.SDN_AP_CLASS_REPORT)fs.writeFileSync(process.env.SDN_AP_CLASS_REPORT,JSON.stringify({edge,results,selected},null,2)+'\n');
assert.ok(selected,'registered B grid contains a crossing primary and noncrossing companion');
const [a,b]=selected.pair,ratio=a.days[7].t/b.days[7].t;
console.log(JSON.stringify({bterm:selected.bterm,day7AlongTrackMeters:[a.days[7].t,b.days[7].t],ratio,allowed:[.9,1.1],termLongitudeAmplitudesMeters:a.classDiagnostics[0].values.slice(5)}));
if(!process.argv.includes('--baseline')){
 assert.ok(Math.abs(ratio-1)<=.1,'crossing signed along-track error within 10% of companion');
 for(const r of selected.pair)for(const d of r.classDiagnostics){assert.equal(d.values[2],2,'epoch half-day class retained');assert.equal(d.values[3],2,'both (2,2) terms remain in integrated output');assert.equal(d.values[4],0,'no duplicate short-period terms');}
 execFileSync(process.execPath,[new URL('./conformance.e2e.mjs',import.meta.url).pathname,'--reproduce',new URL('./results/conformance.json',import.meta.url).pathname],{stdio:'inherit',env:{...process.env,SDN_AP_ORACLE_ROOT:process.env.SDN_AP_ORACLE_ROOT??'/Users/tj/software/spacedatanetwork-stack/repos/main-packages/space-data-network-closed-modules/packages/sgp4-xp-oracle'}});
 console.log('Class crossing E2E: PASS');
}

#!/usr/bin/env node
// Registered before FFM truth generation. AP mean-element epoch state seeds FFM;
// no fit. Forward leads 1/3/7, GTO n=2.40 e=.72 i=27, RAAN=40, argp=270, M=0.
// Companion begins 0.01 rev/day below the upper half-day edge. Constant weather.
// Predeclared B grid: choose the first pair whose primary crosses during
// the forward week while its companion does not. Selection uses mean motion
// alone; every evaluated pair is printed, and accuracy never selects a pair.
// Known B fixed in both input sets; no SRP. Signed along-track errors within 25%.
import assert from 'node:assert/strict';
import {requireTruth} from './lib/ffm-truth.mjs';
requireTruth('a9133120775291c4dfbf9151d0617850be560934943a178419fdd8e3fed765e4'); // the model truth: FFM 2.2.1 (modules 9cb02c8e)
import fs from 'node:fs';
import {reproduceConformance} from './lib/conformance-step.mjs';
import {buildDiagnostic,CLASS_PROBE} from './lib/ap-diagnostic.mjs';
import {runModelTruth} from './lib/heo-model-truth.mjs';
const probePath=process.env.SDN_AP_CLASS_PROBE??buildDiagnostic('class-probe',CLASS_PROBE);
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
assert.ok(selected,'registered B grid contains a crossing primary and noncrossing companion');
const [a,b]=selected.pair,ratio=a.days[7].t/b.days[7].t;
const holdPath=buildDiagnostic('class-hold-reference',CLASS_PROBE,s=>{
 const changed=s.replace(/inline int ap_resonance_class\(const RateContext& ctx, double n\) \{[\s\S]*?\n\}/,'inline int ap_resonance_class(const RateContext& ctx, double n) {\n  (void)n;\n  return ctx.resonance;\n}');
 assert.notEqual(changed,s,'epoch-hold diagnostic transformation applied');return changed;
});
const epochHold=await runModelTruth({...a.fixture,name:'epoch-hold',modulePath:holdPath,probePath:holdPath});
console.log(JSON.stringify({epochHold}));
if(process.env.SDN_AP_CLASS_REPORT)fs.writeFileSync(process.env.SDN_AP_CLASS_REPORT,JSON.stringify({edge,results,selected,epochHold},null,2)+'\n');
console.log(JSON.stringify({bterm:selected.bterm,day7AlongTrackMeters:[a.days[7].t,b.days[7].t],ratio,allowed:[.75,1.25],epochHoldDay7AlongTrackMeters:epochHold.days[7].t,termLongitudeAmplitudesMeters:a.classDiagnostics[0].values.slice(5,7),termPerigeeAlongTrackAmplitudesMeters:a.classDiagnostics[0].values.slice(7,9)}));
if(!process.argv.includes('--baseline')){
 for(const r of selected.pair)for(const d of r.classDiagnostics){const crossed=d.values[0]>edge;assert.equal(d.values[2],crossed?3:2,'current class has matching tables');assert.equal(d.values[3],crossed?0:2,'rates contain only the current class');assert.equal(d.values[4],crossed?2:0,'both old terms move to output without duplication');}
 reproduceConformance();
 assert.ok(Math.abs(ratio-1)<=.25,'crossing signed along-track error within 25% of companion');
 assert.ok(Math.abs(a.days[7].t)<Math.abs(epochHold.days[7].t),'rebuild has smaller absolute along-track error than epoch hold');
 for(const amplitude of a.classDiagnostics[0].values.slice(7,9))assert.ok(amplitude>500&&amplitude<650,'both sampled perigee term amplitudes remain in the measured range');
 console.log('Class crossing E2E: PASS');
}

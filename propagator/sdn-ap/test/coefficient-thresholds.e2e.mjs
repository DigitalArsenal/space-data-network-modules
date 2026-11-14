#!/usr/bin/env node
// Synthetic threshold neighborhoods, UTC fixture epochs, TEME meters, 300 s
// samples to 120 h. The 0.063 m switch bound separates approximation changes
// from the physical difference of the two element sets using state-exact
// evaluation of each side. The prior measured maximum is 0.016281170 m.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {records,buildForms} from './lib/coefficient-forms.mjs';
import {repackOcm} from './lib/ocm.mjs';
import {coefficientHarness,positionM} from './lib/coefficient-harness.mjs';
const builds=process.env.COEFFICIENT_BUILDS?JSON.parse(fs.readFileSync(process.env.COEFFICIENT_BUILDS)):buildForms();
const gates=[
 {
  "kind": "hp",
  "value": 350,
  "epsilon": 1e-08,
  "fixture": 15,
  "forms": [
   1,
   4
  ]
 },
 {
  "kind": "hp",
  "value": 600,
  "epsilon": 1e-08,
  "fixture": 4,
  "forms": [
   3,
   2
  ]
 },
 {
  "kind": "hp",
  "value": 1000,
  "epsilon": 1e-08,
  "fixture": 6,
  "forms": [
   2,
   0
  ]
 },
 {
  "kind": "hp",
  "value": 1000,
  "epsilon": 1e-08,
  "fixture": 15,
  "forms": [
   4,
   0
  ]
 },
 {
  "kind": "hp",
  "value": 1000,
  "epsilon": 1e-08,
  "fixture": 14,
  "forms": [
   1,
   0
  ]
 },
 {
  "kind": "hp",
  "value": 600,
  "epsilon": 1e-08,
  "zeroDrag": true,
  "fixture": 4,
  "forms": [
   1,
   2
  ]
 },
 {
  "kind": "e",
  "value": 0.02,
  "epsilon": 1e-10,
  "hp": 300,
  "fixture": 15,
  "forms": [
   3,
   1
  ]
 },
 {
  "kind": "e",
  "value": 0.02,
  "epsilon": 1e-10,
  "hp": 500,
  "fixture": 15,
  "forms": [
   3,
   4
  ]
 },
 {
  "kind": "e",
  "value": 0.02,
  "epsilon": 1e-10,
  "hp": 800,
  "fixture": 15,
  "forms": [
   2,
   4
  ]
 },
 {
  "kind": "e",
  "value": 0.2,
  "epsilon": 1e-10,
  "hp": 500,
  "fixture": 15,
  "forms": [
   4,
   1
  ]
 },
 {
  "kind": "e",
  "value": 0.2,
  "epsilon": 1e-10,
  "hp": 800,
  "fixture": 15,
  "forms": [
   4,
   1
  ]
 },
 {
  "kind": "bterm",
  "value": 0,
  "epsilon": 1e-12,
  "fixture": 1,
  "forms": [
   1,
   3
  ]
 },
 {
  "kind": "bterm",
  "value": 0,
  "epsilon": 1e-12,
  "fixture": 4,
  "forms": [
   1,
   3
  ]
 },
 {
  "kind": "hp",
  "value": 30000,
  "epsilon": 1e-08,
  "fixture": 8,
  "forms": [
   0,
   2
  ]
 },
 {
  "kind": "e",
  "value": 0.02,
  "epsilon": 1e-10,
  "hp": 35786,
  "fixture": 8,
  "forms": [
   2,
   0
  ]
 }
];
const fixtures=records();
for(const gate of gates){
 const seed=fixtures[gate.fixture],modules=[];
 for(const side of [-1,1]){
  const bytes=repackOcm(seed.bytes,t=>{t.COVARIANCE_DATA=[];t.COV_SIZE=0;const m=t.MEAN_ELEMENTS;if(gate.zeroDrag)m.BTERM=0;
   if(gate.kind==='hp'){const a=(1+(gate.value+side*gate.epsilon)/6378.1363)/(1-m.ECCENTRICITY);m.MEAN_MOTION=.074366859954178854/a**1.5*1440/(2*Math.PI);}
   else if(gate.kind==='e'){m.ECCENTRICITY=gate.value+side*gate.epsilon;const a=(1+gate.hp/6378.1363)/(1-m.ECCENTRICITY);m.MEAN_MOTION=.074366859954178854/a**1.5*1440/(2*Math.PI);}
   else m.BTERM=side<0?0:gate.epsilon;
  });
  modules.push(await coefficientHarness(builds.probe,[{...seed,bytes}]),await coefficientHarness(builds.exact,[{...seed,bytes}]));
 }
 let common=0,maxSwitchResidualM=0,maxExactM=0;
 for(let t=0;t<=432000;t+=300){
  const s=modules.map(m=>m.state(t));if(s.some(v=>v[0]!==0))continue;common++;
  assert.equal(modules[0].x.sdnap_test_form(),gate.forms[0]);assert.equal(modules[2].x.sdnap_test_form(),gate.forms[1]);
  const d=s[0].map((v,k)=>(v-s[1][k])-(s[2][k]-s[3][k]));
  maxSwitchResidualM=Math.max(maxSwitchResidualM,1000*Math.hypot(...d.slice(1,4)));
  maxExactM=Math.max(maxExactM,positionM(s[0],s[1]),positionM(s[2],s[3]));
 }
 assert(common>0);assert(maxSwitchResidualM<=.063,JSON.stringify({gate,maxSwitchResidualM}));assert(maxExactM<1);
 console.log(JSON.stringify({gate,common,maxSwitchResidualM,maxExactM}));await Promise.all(modules.map(m=>m.close()));
}
process.exit(0);

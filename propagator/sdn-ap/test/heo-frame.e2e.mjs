#!/usr/bin/env node
// Registration: replay only AP6's seven already-read TESS 72-hour windows.
// Exploratory acceptance: median paired AP-XP day-3 difference below 50 m
// (two-sided within 50 m until 0.4.8; one-sided since AP sets keep full precision). Re-run all four registered FFM HEO fixtures from task 2: each
// printed day 1/3/7 3D error unchanged within 1 m. Default XP digest bit-exact.
// Unread-window confirmation belongs to a subsequent coordinator task.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {reproduceConformance} from './lib/conformance-step.mjs';
import {tessWindows} from './lib/tess-frame-windows.mjs';
import {runModelTruth} from './lib/heo-model-truth.mjs';
import {wasmPath} from './lib/module.mjs';
const tess=await tessWindows(wasmPath),fixtures=[];
const registered=JSON.parse(fs.readFileSync(new URL('./results/heo-model-truth.json',import.meta.url))).current;
for(const old of registered){const f=old.fixture;const actual=await runModelTruth({name:old.name,n:f.n,e:f.e,i:f.i,raan:f.raan,argp:f.argp,ma:f.ma,drag:f.drag});const differences=[1,3,7].map(day=>({day,beforeMeters:old.days[day].e,afterMeters:actual.days[day].e,changeMeters:actual.days[day].e-old.days[day].e}));fixtures.push({name:old.name,days:differences});console.log(JSON.stringify({heoFixture:fixtures.at(-1)}));for(const d of differences)assert.ok(Math.abs(d.changeMeters)<1,'HEO fixture unchanged within 1 m');}
console.log(JSON.stringify({historicalPairedDay3DifferenceMeters:tess.historicalPairedDay3DifferenceMeters,pairedDay3DifferenceMeters:tess.pairedDay3DifferenceMeters,limitMeters:50}));
if(process.env.SDN_AP_HEO_FRAME_REPORT)fs.writeFileSync(process.env.SDN_AP_HEO_FRAME_REPORT,JSON.stringify({tess,fixtures},null,2)+'\n');
if(!process.argv.includes('--measure')){assert.ok(tess.pairedDay3DifferenceMeters<50,'exploratory AP no more than 50 m behind XP at day 3 (from 0.4.9 AP sets keep full precision, XP sets the two-line lattice: SPEC 16.9)');reproduceConformance();console.log('HEO frame E2E: PASS');}

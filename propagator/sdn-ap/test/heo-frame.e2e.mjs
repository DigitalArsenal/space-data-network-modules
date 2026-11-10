#!/usr/bin/env node
// Its TESS replay is scored on the module's own GCRF output since 2026-11-10 (#386). The old path (TEME through the
// pinned foundation/frames 0.2.0, whose TEME is not the standard one, #389) is printed beside it, and XP on it still
// reproduces the archived AP6 scores within 1 mm. The truth's EME2000 to GCRF stays with foundation/frames (the frame bias,
// not its TEME). The TEME output through this checkout's foundation/frames 0.3.0 lands within 1 mm of the module's GCRF
// output. Its HEO model-truth fixtures rotate with the module's own frames.
// Registration: replay only AP6's seven already-read TESS 72-hour windows.
// Exploratory acceptance: median paired AP-XP day-3 difference below 50 m
// (two-sided within 50 m until 0.4.8; one-sided since AP sets keep full precision). Re-run all four registered FFM HEO fixtures from task 2: each
// printed day 1/3/7 3D error unchanged within 1 m. Default XP digest bit-exact.
// Unread-window confirmation belongs to a subsequent coordinator task.
import assert from 'node:assert/strict';
import {requireTruth} from './lib/ffm-truth.mjs';
requireTruth('ea4576901f9e8dc21af2c24feb7887645706ef934488cb9756a0b5c21ab47934'); // the model truth: FFM 2.3.0 (modules 48a00fd6), 2.2.1's truth bit for bit
import fs from 'node:fs';
import {reproduceConformance} from './lib/conformance-step.mjs';
import {tessWindows} from './lib/tess-frame-windows.mjs';
import {runModelTruth} from './lib/heo-model-truth.mjs';
import {wasmPath} from './lib/module.mjs';
const tess=await tessWindows(wasmPath),fixtures=[];
const registered=JSON.parse(fs.readFileSync(new URL('./results/heo-model-truth.json',import.meta.url))).current;
for(const old of registered){const f=old.fixture;const actual=await runModelTruth({name:old.name,n:f.n,e:f.e,i:f.i,raan:f.raan,argp:f.argp,ma:f.ma,drag:f.drag});const differences=[1,3,7].map(day=>({day,beforeMeters:old.days[day].e,afterMeters:actual.days[day].e,changeMeters:actual.days[day].e-old.days[day].e}));fixtures.push({name:old.name,days:differences});console.log(JSON.stringify({heoFixture:fixtures.at(-1)}));for(const d of differences)assert.ok(Math.abs(d.changeMeters)<1,'HEO fixture unchanged within 1 m');}
console.log(JSON.stringify({historicalPairedDay3DifferenceMeters:tess.historicalPairedDay3DifferenceMeters,pairedDay3DifferenceMeters:tess.pairedDay3DifferenceMeters,pairedDay3DifferenceMetersOldPath:tess.pairedDay3DifferenceMetersOld,limitMeters:50,frames030Meters:tess.frames030Meters}));
assert.ok(tess.frames030Meters<=1e-3,`foundation/frames 0.3.0 on the TEME output within ${tess.frames030Meters} m of the module's GCRF output (1 mm)`);
if(process.env.SDN_AP_HEO_FRAME_REPORT)fs.writeFileSync(process.env.SDN_AP_HEO_FRAME_REPORT,JSON.stringify({tess,fixtures},null,2)+'\n');
if(!process.argv.includes('--measure')){assert.ok(tess.pairedDay3DifferenceMeters<50,'exploratory AP no more than 50 m behind XP at day 3 (from 0.4.9 AP sets keep full precision, XP sets the two-line lattice: SPEC 16.9)');reproduceConformance();console.log('HEO frame E2E: PASS');}

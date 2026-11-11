#!/usr/bin/env node
// Its TESS replay is scored on the module's own GCRF output since 2026-11-10 (#386). The old path (TEME through the
// pinned foundation/frames 0.2.0, whose TEME is not the standard one, #389) is printed beside it, and the comparisons with
// the archived AP6 arms are made on it. The truth's EME2000 to GCRF stays with foundation/frames (the frame bias,
// not its TEME). The TEME output through this checkout's foundation/frames 0.3.0 lands within 1 mm of the module's GCRF
// output (26 µm at TESS's radius). On 0.6.14 the median paired day-3 AP minus XP is -137.5 m on the new path, -137.0 m on
// the old. Its HEO model-truth fixtures rotate with the module's own frames.
// Registration: replay only AP6's seven already-read TESS 72-hour windows.
// Exploratory acceptance: median paired AP-XP day-3 difference below 50 m
// (two-sided within 50 m until 0.4.8; one-sided since AP sets keep full precision). Re-run all four registered FFM HEO fixtures from task 2: each
// printed day 1/3/7 3D error unchanged within 1 m. Default XP digest bit-exact.
// Unread-window confirmation belongs to a subsequent coordinator task.
// Amended 2026-11-10 (sdn-ap 0.6.13, stack issue 324): XP reproduced the archived AP6 scoring within 1 mm through 0.6.12
// (harness fidelity). TESS is above the drag, where a set is now fitted at the data's own sigma (SPEC 12.1), so both
// theories' fits move; restated against the truth: each theory's median error over the seven windows at days 1, 3 and 7
// no higher than the archived arm's (XP's archive is 0.6.11's flight). Measured, 0.6.11 > 0.6.13, medians in m: AP
// 622.8 / 1393.9 / 6604.9 > 620.2 / 1378.9 / 6513.8 (no window worse); XP 660.4 / 1385.6 / 6540.7 > 639.0 / 1372.5 /
// 6402.8 (2026-08-24 day 1 907.3 > 914.9, every other window and day lower or the same); 2026-07-27 unchanged for both.
// Amended 2026-11-11 (stack #479, comment 6808033865): in the TESS kernels only the records at minutes 0 mod 10 are
// solution states, and the 300 s reading took every second state from the straight-line fill between them. The replay now
// fits and scores on the 10-minute states alone (tess-frame-windows.mjs reader `nodes`, 600 s), the truth the experiments'
// table has used since c8e5bedf, and the AP-XP day-3 limit is read there. The comparison with the archived AP6 arms stays on
// the reading those arms were scored on (reader `archive`, 300 s), so it compares like with like. Both are printed.
import assert from 'node:assert/strict';
import {requireTruth} from './lib/ffm-truth.mjs';
requireTruth('ea4576901f9e8dc21af2c24feb7887645706ef934488cb9756a0b5c21ab47934'); // the model truth: FFM 2.3.0 (modules 48a00fd6), 2.2.1's truth bit for bit
import fs from 'node:fs';
import {reproduceConformance} from './lib/conformance-step.mjs';
import {tessWindows} from './lib/tess-frame-windows.mjs';
import {runModelTruth} from './lib/heo-model-truth.mjs';
import {wasmPath} from './lib/module.mjs';
const tess=await tessWindows(wasmPath),archive=await tessWindows(wasmPath,{reader:'archive'}),fixtures=[];
const registered=JSON.parse(fs.readFileSync(new URL('./results/heo-model-truth.json',import.meta.url))).current;
for(const old of registered){const f=old.fixture;const actual=await runModelTruth({name:old.name,n:f.n,e:f.e,i:f.i,raan:f.raan,argp:f.argp,ma:f.ma,drag:f.drag});const differences=[1,3,7].map(day=>({day,beforeMeters:old.days[day].e,afterMeters:actual.days[day].e,changeMeters:actual.days[day].e-old.days[day].e}));fixtures.push({name:old.name,days:differences});console.log(JSON.stringify({heoFixture:fixtures.at(-1)}));for(const d of differences)assert.ok(Math.abs(d.changeMeters)<1,'HEO fixture unchanged within 1 m');}
const frames030Meters=Math.max(tess.frames030Meters,archive.frames030Meters);
console.log(JSON.stringify({historicalPairedDay3DifferenceMeters:tess.historicalPairedDay3DifferenceMeters,pairedDay3DifferenceMeters:tess.pairedDay3DifferenceMeters,pairedDay3DifferenceMetersOldPath:tess.pairedDay3DifferenceMetersOld,archiveReaderPairedDay3DifferenceMeters:archive.pairedDay3DifferenceMeters,limitMeters:50,frames030Meters}));
assert.ok(frames030Meters<=1e-3,`foundation/frames 0.3.0 on the TEME output within ${frames030Meters} m of the module's GCRF output (1 mm)`);
const med=(a)=>{const v=a.toSorted((x,y)=>x-y),i=v.length>>1;return v.length%2?v[i]:(v[i-1]+v[i])/2;};
// the comparison with the archive: each theory's median error by day beside the archived arm's (km in the archive), on the
// reading and the path (the old one) the archive was scored on; the module's own GCRF figure printed beside
const truthMedians={};for(const [theory,archived] of [['AP','archivedAP'],['XP','archivedXP']])for(const day of [1,3,7])truthMedians[`${theory} day ${day}`]={meters:med(archive.rows.map(r=>r[theory+'Old'][day])),archivedMeters:med(archive.rows.map(r=>1000*r[archived][day].e)),ownGcrfMeters:med(archive.rows.map(r=>r[theory][day]))};
// against the kernels' 10-minute states: each theory's median error by day on both paths
const nodeTruthMedians={};for(const theory of ['AP','XP'])for(const day of [1,3,7])nodeTruthMedians[`${theory} day ${day}`]={ownGcrfMeters:med(tess.rows.map(r=>r[theory][day])),oldPathMeters:med(tess.rows.map(r=>r[theory+'Old'][day]))};
console.log(JSON.stringify({truthMedians,nodeTruthMedians}));
if(process.env.SDN_AP_HEO_FRAME_REPORT)fs.writeFileSync(process.env.SDN_AP_HEO_FRAME_REPORT,JSON.stringify({tess,archive,fixtures},null,2)+'\n');
if(!process.argv.includes('--measure')){for(const [k,t] of Object.entries(truthMedians))assert.ok(t.meters<=t.archivedMeters,`${k}: median error ${t.meters} m above the archived ${t.archivedMeters} m`);assert.ok(tess.pairedDay3DifferenceMeters<50,'exploratory AP no more than 50 m behind XP at day 3 (from 0.4.9 AP sets keep full precision, XP sets the two-line lattice: SPEC 16.9)');reproduceConformance();console.log('HEO frame E2E: PASS');}

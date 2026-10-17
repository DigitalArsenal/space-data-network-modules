#!/usr/bin/env node
// Current composition/clock diagnostics. Historical defect measurements live
// only under before-after.json.before, never reconstructed from deleted code.
import fs from 'node:fs';
import path from 'node:path';
import {build,here} from './frame-diagnostics.mjs';
const work=fs.mkdtempSync(path.join(here,'.diagnose-'));
try{
 const measure=await build(work),d=measure();
 d.about='Current FFM force-clock and classical-frame comparisons with pinned independent ERFA/SPICE records. Rotations in mas with radius times angle in meters; UTC sample labels, exact two-part TT/UT1 evaluation.';
 const classical=path.join(here,'classical-frames-10k.json');if(fs.existsSync(classical))d.velocityRates=JSON.parse(fs.readFileSync(classical,'utf8')).rows;
 fs.writeFileSync(path.join(here,'diagnosis.json'),JSON.stringify(d,null,1)+'\n');
 console.log(`Reduced ${d.epochs} ERFA/SPICE epochs in C++.`);
}finally{fs.rmSync(work,{recursive:true,force:true});}

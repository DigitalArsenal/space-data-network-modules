#!/usr/bin/env node
// Offline evidence generation. C++ evaluates HPOP at its exact force instant;
// independent pyerfa/SPICE evaluate the references. JS only moves data/processes.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {parseArgs} from 'node:util';
import {buildHpopFrames,eopStream,HPOP,REPO} from './hpop-frames-native.mjs';
import {here} from './frame-diagnostics.mjs';
const {values:o}=parseArgs({options:{flatbuffers:{type:'string',default:'/Users/tj/software/main-packages/flatbuffers/include'},python:{type:'string',default:process.env.XVAL_PYTHON??'/Users/tj/software/tools/xval/erfa-spice/bin/python'},naif:{type:'string',default:process.env.XVAL_NAIF??'/Users/tj/software/tools/xval/naif-kernels'}}});
const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const casesPath=path.join(here,'../cases/hpop-reference-cases.json'),cases=JSON.parse(fs.readFileSync(casesPath,'utf8'));
const kernel=path.join(REPO,cases.models.ephemeris.path);
if(hash(kernel)!==cases.models.ephemeris.sha256)throw new Error('DE440 hash differs from case export');
const work=fs.mkdtempSync(path.join(here,'.run-erfa-spice-'));
try{
 const frames=await buildHpopFrames(work,o.flatbuffers),epochs=[];
 const sets=new Map();for(const c of cases.cases)if(!sets.has(c.earthOrientation))sets.set(c.earthOrientation,c.sampleEpochsUtc);
 for(const[id,utcs]of sets)for(const e of frames.at(eopStream(work,cases,id),utcs,kernel))epochs.push({earthOrientation:id,...e});
 const sources=['propagator/hpop/src/cpp/include/hpop/prw_environment.h','propagator/hpop/src/cpp/include/hpop/prw_codec.h','propagator/hpop/lib/time_convert.cpp','propagator/hpop/lib/time_types.h','propagator/hpop/lib/coords.cpp','propagator/hpop/lib/coords.h','propagator/hpop/lib/force_models.cpp','propagator/hpop/lib/ephemeris.cpp','foundation/frames/src/axis_engine.hpp','foundation/frames/src/eop_series.hpp'];
 const hpopFile=path.join(here,'hpop-frames.json');
 fs.writeFileSync(hpopFile,JSON.stringify({about:'Source-built HPOP force APIs at exact PRW two-part TT; native DE440 reads at Instant.tdb().secondsSinceJ2000(). Single-JD values label outputs only. Matrices row-major; states km and km/s in ICRF relative to Earth.',module:{version:JSON.parse(fs.readFileSync(path.join(HPOP,'package.json'),'utf8')).version,sha256:hash(path.join(HPOP,'dist/isomorphic/module.wasm'))},sources:Object.fromEntries(sources.map(f=>[f,hash(path.join(REPO,f))])),erfaSourceFiles:frames.erfaFileCount,epochs},null,1)+'\n');
 const reference=JSON.parse(execFileSync(o.python,['-I',path.join(here,'reference.py'),casesPath,hpopFile,o.naif,kernel],{encoding:'utf8',maxBuffer:64<<20,env:{...process.env,TMPDIR:work,TMP:work,TEMP:work}}));
 fs.writeFileSync(path.join(here,'reference.json'),JSON.stringify({about:'Independent pyerfa/SPICE references at the same exact TT and TDB instants; reference.py.',...reference},null,1)+'\n');
 console.log(`Generated ${epochs.length} exact-instant HPOP and independent ERFA/SPICE records.`);
}finally{fs.rmSync(work,{recursive:true,force:true});}
execFileSync(process.execPath,[path.join(here,'diagnose-frames.mjs')],{stdio:'inherit'});
execFileSync(process.execPath,[path.join(here,'summarize-erfa-spice.mjs')],{stdio:'inherit'});

#!/usr/bin/env node
// Offline evidence generation. C++ evaluates FFM at its exact force instant;
// independent pyerfa/SPICE evaluate the references. JS only moves data/processes.
// --stored-reference keeps reference.json and runs no pyerfa/SPICE: the FFM
// records are rebuilt and must carry the exact instants the reference was
// evaluated at (those of the committed ffm-frames.json).
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {parseArgs} from 'node:util';
import {buildFfmFrames,eopStream,FFM,REPO} from './ffm-frames-native.mjs';
import {here} from './frame-diagnostics.mjs';
import {outsidePath,recordedJson,requireOptions,rootDir} from '../paths.mjs';
const {values:o}=parseArgs({options:{flatbuffers:{type:'string'},python:{type:'string'},naif:{type:'string'},'stored-reference':{type:'boolean',default:false}}});
// Outside folders come from the environment (docs/cross-validation.md, Outside inputs), never from a path here.
o.flatbuffers??=rootDir('flatbuffers include')??undefined;o.python??=process.env.XVAL_PYTHON??outsidePath('xval','erfa-spice/bin/python');o.naif??=process.env.XVAL_NAIF??outsidePath('xval','naif-kernels');
requireOptions(o,[['flatbuffers','set XVAL_FLATBUFFERS to the include/ folder of a flatbuffers checkout'],...(o['stored-reference']?[]:[['python','set XVAL_PYTHON to the erfa-spice Python, or FFM_XVAL_TOOLS'],['naif','set XVAL_NAIF to the NAIF kernel folder, or FFM_XVAL_TOOLS']])]);
const instants=epochs=>JSON.stringify(epochs.map(({utc,earthOrientation,tt1,tt2,ut11,ut12,etTdb})=>[utc,earthOrientation,tt1,tt2,ut11,ut12,etTdb]));
const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const casesPath=path.join(here,'../cases/ffm-reference-cases.json'),cases=JSON.parse(fs.readFileSync(casesPath,'utf8'));
const kernel=path.join(REPO,cases.models.ephemeris.path);
if(hash(kernel)!==cases.models.ephemeris.sha256)throw new Error('DE440 hash differs from case export');
const work=fs.mkdtempSync(path.join(here,'.run-erfa-spice-'));
try{
 const frames=await buildFfmFrames(work,o.flatbuffers),epochs=[];
 const sets=new Map();for(const c of cases.cases)if(!sets.has(c.earthOrientation))sets.set(c.earthOrientation,c.sampleEpochsUtc);
 for(const[id,utcs]of sets)for(const e of frames.at(eopStream(work,cases,id),utcs,kernel))epochs.push({earthOrientation:id,...e});
 const sources=['propagator/ffm/src/cpp/include/ffm/prw_environment.h','propagator/ffm/src/cpp/include/ffm/prw_codec.h','propagator/ffm/lib/time_convert.cpp','propagator/ffm/lib/time_types.h','propagator/ffm/lib/coords.cpp','propagator/ffm/lib/coords.h','propagator/ffm/lib/force_models.cpp','propagator/ffm/lib/ephemeris.cpp','foundation/frames/src/axis_engine.hpp','foundation/frames/src/eop_series.hpp'];
 const ffmFile=path.join(here,'ffm-frames.json');
 if(o['stored-reference']&&instants(JSON.parse(fs.readFileSync(ffmFile,'utf8')).epochs)!==instants(epochs))throw new Error('FFM instants differ from those of the stored reference; run without --stored-reference');
 fs.writeFileSync(ffmFile,JSON.stringify({about:'Source-built FFM force APIs at exact PRW two-part TT; native DE440 reads at Instant.tdb().secondsSinceJ2000(). Single-JD values label outputs only. Matrices row-major; states km and km/s in ICRF relative to Earth.',module:{version:JSON.parse(fs.readFileSync(path.join(FFM,'package.json'),'utf8')).version,sha256:hash(path.join(FFM,'dist/isomorphic/module.wasm'))},sources:Object.fromEntries(sources.map(f=>[f,hash(path.join(REPO,f))])),erfaSourceFiles:frames.erfaFileCount,epochs},null,1)+'\n');
 if(!o['stored-reference']){
  const reference=JSON.parse(execFileSync(o.python,['-I','-B',path.join(here,'reference.py'),casesPath,ffmFile,o.naif,kernel],{encoding:'utf8',maxBuffer:64<<20,env:{...process.env,TMPDIR:work,TMP:work,TEMP:work}}));
  fs.writeFileSync(path.join(here,'reference.json'),JSON.stringify({about:'Independent pyerfa/SPICE references at the same exact TT and TDB instants; reference.py.',...reference},null,1)+'\n');
 }
 console.log(`Generated ${epochs.length} exact-instant FFM records; ${o['stored-reference']?'stored':'independent'} ERFA/SPICE references.`);
}finally{fs.rmSync(work,{recursive:true,force:true});}
execFileSync(process.execPath,[path.join(here,'diagnose-frames.mjs')],{stdio:'inherit'});
execFileSync(process.execPath,[path.join(here,'summarize-erfa-spice.mjs')],{stdio:'inherit'});

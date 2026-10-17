#!/usr/bin/env node
// Offline C3/C5 independent Orekit frames. JS only moves files and invokes
// native reference/reduction processes; no rotation/date/physics arithmetic.
// node tests/evidence/erfa-spice/run-orekit-frames.mjs [--baseline]
// Environment overrides: OREKIT_JARS, OREKIT_DATA, FLATBUFFERS_INCLUDE.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { composeErfaTranslationUnit } from '../../../../../foundation/frames/erfa-amalgamation.mjs';
import { buildHpopFrames, eopStream, HPOP, REPO } from './hpop-frames-native.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const work=path.join(here,'../.run-work/orekit-frames');fs.mkdirSync(work,{recursive:true});
const jars=process.env.OREKIT_JARS??'/Users/tj/software/gmat09-authority/jars';
const data=process.env.OREKIT_DATA??'/Users/tj/software/gmat09-authority/orekit-data/orekit-data-main';
const sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const read=f=>JSON.parse(fs.readFileSync(path.join(here,f),'utf8'));
const erfa=await composeErfaTranslationUnit();const unit=path.join(work,'orekit-erfa.cpp');fs.writeFileSync(unit,erfa.source);
const bin=path.join(work,'orekit-frames-reduce');
execFileSync('c++',['-std=c++17','-O2','-I',path.join(REPO,'higherpop/third_party/erfa'),path.join(here,'orekit-frames-reduce.cpp'),unit,'-o',bin],{stdio:'inherit'});
if(process.argv.includes('--trajectories-only')) {
  const before=read('orekit-trajectory-before.json');
  const current=JSON.parse(fs.readFileSync(path.join(here,'../orekit/summary.json'),'utf8'));
  const after=new Map(current.cases.map(c=>[c.id,c]));
  const input=before.cases.flatMap(b=>['suite','steps30','finest'].map(s=>[s,b.orbit,b.forces,b[s].worstM,after.get(b.id)[s].worstM].join(' '))).join('\n')+'\n';
  let output,failed=false;
  try {output=execFileSync(bin,['--trajectories'],{input,encoding:'utf8'});} catch(e) {if(!e.stdout)throw e;output=e.stdout;failed=true;}
  const scores=JSON.parse(output);
  const evidence={beforeModule:before.module,afterModule:current.module,sourceSha256:sha(path.join(here,'orekit-frames-reduce.cpp')),...scores};
  fs.writeFileSync(path.join(here,'orekit-trajectory-before-after.json'),JSON.stringify(evidence,null,1)+'\n');
  for(const r of scores.rows.filter(r=>r.setting==='suite'))console.log(`${r.orbit} ${r.forces}: ${r.beforeWorstM} -> ${r.afterWorstM} m (${r.met?'met':'MISSED'})`);
  console.log(`All LEO/SSO settings: ${scores.total} rows, ${scores.missed} exceed the allowed 0.0001 m increase.`);
  process.exit(failed?1:0);
}
const before=read('orekit-hpop-before.json');
const javaSource=path.join(here,'OrekitFrames.java');
const nutationResource='assets/org/orekit/IERS-conventions/1996/nutation-arguments.txt';
const nutationResourceBytes=execFileSync('unzip',['-p',path.join(jars,'orekit-13.1.jar'),nutationResource]);
execFileSync('javac',['-cp',path.join(jars,'*'),'-d',work,javaSource],{stdio:'inherit'});
const output=execFileSync('java',['-cp',`${work}:${path.join(jars,'*')}`,'OrekitFrames',data],{input:before.epochs.map(e=>e.utc).join('\n')+'\n',encoding:'utf8',maxBuffer:32<<20});
const oracle={about:'Orekit 13.1 exact UTC samples. Classical matrices start in EME2000 (the bias-free J2000 origin called GCRF by HPOP coords), IERS 1996, no EOP corrections. ITRF starts in GCRF, IERS 2010, simpleEOP=true, minimum supported EOP interpolation degree 3 (degrees must be 4k-1). Frame providers evaluated without transform interpolation.',
  tools:{java:execFileSync('java',['--version'],{encoding:'utf8'}).trim(),jars:Object.fromEntries(fs.readdirSync(jars).filter(f=>/^orekit-13\.1\.jar$|^hipparchus-.*-4\.0\.1\.jar$/.test(f)).map(f=>[f,sha(path.join(jars,f))]))},
  source:{path:path.relative(REPO,javaSource),sha256:sha(javaSource)},nutationArguments:{resource:nutationResource,sha256:createHash('sha256').update(nutationResourceBytes).digest('hex'),note:'The bundled resource explicitly documents its IERS 1996 fundamental arguments differing from SOFA IAU 1980.'},finals2000A:{sha256:sha(path.join(data,'Earth-Orientation-Parameters/IAU-2000/finals2000A.all'))},
  epochs:output.trim().split('\n').map(JSON.parse)};
fs.writeFileSync(path.join(here,'orekit-frames.json'),JSON.stringify(oracle,null,1)+'\n');
let after=before;
if(!process.argv.includes('--baseline')) {
  const cases=JSON.parse(fs.readFileSync(path.join(here,'../cases/hpop-reference-cases.json')));
  const native=await buildHpopFrames(work,process.env.FLATBUFFERS_INCLUDE??'/Users/tj/software/main-packages/flatbuffers/include');
  const sets=new Map();for(const c of cases.cases)if(!sets.has(c.earthOrientation))sets.set(c.earthOrientation,c.sampleEpochsUtc);
  const epochs=[];for(const[id,utcs]of sets)epochs.push(...native.at(eopStream(work,cases,id),utcs).map(e=>({earthOrientation:id,...e})));
  const sources=['lib/coords.cpp','lib/time_convert.cpp','lib/time_types.h','lib/force_models.cpp','src/cpp/include/hpop/prw_environment.h','tests/evidence/erfa-spice/hpop_frames_native.cpp'];
  after={sources:Object.fromEntries(sources.map(f=>[f,sha(path.join(HPOP,f))])),epochs};
  fs.writeFileSync(path.join(here,'orekit-hpop-after.json'),JSON.stringify(after,null,1)+'\n');
}
const index=rows=>new Map(rows.map(e=>[e.utc,e]));const a=index(after.epochs),o=index(oracle.epochs),r=index(read('reference.json').epochs);
const input=before.epochs.map(b=>{
  const c=a.get(b.utc),j=o.get(b.utc),e=r.get(b.utc);
  return[b.utc,b.earthOrientation,...['coordsPrecession','coordsNutation','coordsGcrfToTeme','c2t'].flatMap(k=>b[k]),...['coordsPrecession','coordsNutation','coordsGcrfToTeme','c2t'].flatMap(k=>c[k]),...['mod','tod','teme','itrf'].flatMap(k=>j[k]),...e.c2tErfa,j.dut1,j.xp,j.yp,j.dx,j.dy].join(' ');
}).join('\n')+'\n';
const reduced=JSON.parse(execFileSync(bin,[],{input,encoding:'utf8'}));
const summary={about:'C++ reduction against independent Orekit frames; 1 mm target at LEO/GEO, no tolerance widened. Before: untouched 1.3.1 native. After: current native (baseline mode repeats before).',
  units:'Rotation angle mas; worst-direction displacement mm at LEO=6778137 m and GEO=42164170 m.',
  notes:{classical:'Orekit MODProvider composes the IERS 1996 psi_A/omega_A/chi_A cubic precession polynomials; ERFA pmat76 uses the IAU 1976 zeta/z/theta cubic parameterization. Their finite polynomial representations differ beyond their retained order. Orekit IERS 1996 nutation arguments also differ from ERFA IAU 1980 (documented in the pinned jar resource); measured ERFA/Orekit rows isolate that model spread.',itrf:'Orekit minimum degree-3 EOP interpolation differs from HPOP linear interpolation; same-EOP and interpolation-spread rows isolate it. Midnight rows land exactly on EOP records.',clock:'LEO400 F3 samples are the August 25-epoch set. AlignedEop rows are explicitly diagnostic: R_ERFA(linear case EOP) * transpose(R_ERFA(Orekit cubic EOP)) * R_Orekit removes only the independently measured EOP interpolation effect. Raw Orekit rows are retained with the unchanged 1 mm target.'},
  sources:{java:oracle.source,reduce:sha(path.join(here,'orekit-frames-reduce.cpp')),oracle:sha(path.join(here,'orekit-frames.json')),before:sha(path.join(here,'orekit-hpop-before.json')),after:after.sources??null},...reduced};
fs.writeFileSync(path.join(here,process.argv.includes('--baseline')?'orekit-frames-before-summary.json':'orekit-frames-summary.json'),JSON.stringify(summary,null,1)+'\n');
for(const s of summary.rows)console.log(`${s.id}: before ${s.before.mas} mas (${s.before.leoMm} mm LEO, ${s.before.geoMm} mm GEO); after ${s.after.mas} mas (${s.after.leoMm} mm LEO, ${s.after.geoMm} mm GEO)`);

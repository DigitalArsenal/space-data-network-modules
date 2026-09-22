// Opt-in integration evidence. Uses already acquired local files; no network,
// credentials or publication. This is a test driver, not a provider ingest host.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { ByteBuffer } from 'flatbuffers';
import { OPM } from 'spacedatastandards.org/lib/js/OPM/OPM.js';
import { runtime,createPropagator } from './hpop-epoch-runner.mjs';
import { request as normalizeRequest,container } from '../../../files/orbit-products/tests/vimpel-fixture.mjs';
import { request as fitRequest,policy,unpackOpm } from './epoch-fixture.mjs';
const [elementsPath,archivePath]=process.argv.slice(2);if(!elementsPath||!archivePath)throw new Error('Usage: node tests/vimpel-live.mjs ELEMENTS_FILE EPHEMERIS_RAR');
const lines=fs.readFileSync(elementsPath,'utf8').trim().split(/\r?\n/);
const names=execFileSync('bsdtar',['-tf',archivePath],{encoding:'utf8'}).split('\n').filter(n=>/^ephem\.\d{8}\/\d+_\d{8}_\d{6}$/.test(n));
const key=name=>{const [id,date,time]=name.split('/').at(-1).split('_');return `${BigInt(id)}_${date}_${time}`;};
const entries=new Map(names.map(name=>[key(name),name]));
const rows=lines.map(line=>{const f=line.split(',').map(x=>x.trim()),e=f[3];return {line,key:`${BigInt(f[1])}_${e.slice(4,8)}${e.slice(2,4)}${e.slice(0,2)}_${e.slice(9)}`,eccentricity:Number(f[8])};}).filter(r=>entries.has(r.key));
const selected=[rows.find(r=>r.key.startsWith('141817_')),...rows.filter(r=>r.eccentricity<.93).sort((a,b)=>b.eccentricity-a.eccentricity).slice(0,2)].filter(Boolean);
const normalizer=await runtime('files/orbit-products'),catalog=await runtime('analysis/catalog-composer'),propagator=await createPropagator();
const parseReport=out=>JSON.parse(new TextDecoder().decode(out.outputs.find(x=>x.portId==='report').payload));
async function checked(h,request){const out=await h.invoke(request);if(out.statusCode!==0)throw new Error(`${out.errorCode}: ${out.errorMessage}`);return out;}
const results=[];
try {
 for(const selectedRow of selected) {
  const normalized=await checked(normalizer.h,normalizeRequest(selectedRow.line+'\n'));
  let seedBytes=normalized.outputs.find(x=>x.portId==='states').payload;
  const seedRecord=OPM.getSizePrefixedRootAsOPM(new ByteBuffer(seedBytes));const epoch=seedRecord.EPOCH(),name=seedRecord.OBJECT_NAME();
  const member=entries.get(selectedRow.key),native=execFileSync('bsdtar',['-xOf',archivePath,member],{maxBuffer:4*1024*1024});
  const ref=container(native,{format:'vimpel-ephemeris-text',filename:member});
  const recipe={...policy,...propagator.policy,positionToleranceKm:1,positionWeightKm:.05,positionRegularizationKm:200,velocityRegularizationKmS:.1};
  const makeRequest=(method,arcs)=>{const q=fitRequest(method,unpackOpm(seedBytes),arcs,ref,recipe);q.inputs[1].payload=seedBytes;return q;};
  let first,final,iterations=0;const history=[];
  for(let iteration=0;iteration<=5;iteration++) {
   const values=unpackOpm(seedBytes),nominal=await propagator.propagate(values,epoch,25);
   const report=parseReport(await checked(catalog.h,makeRequest('validate_epoch',[nominal.oem])));first??=report;final=report;history.push({trainingRmsKm:report.trainingRmsKm,holdoutRmsKm:report.holdoutRmsKm,maximumHoldoutResidualKm:report.maximumHoldoutResidualKm});
   if(report.status==='rejected-holdout-regression')throw new Error('Fitted candidate worsened held-out agreement');
   if(report.status==='validated'||iteration===5)break;
   recipe.maximumHoldoutRmsKm=report.holdoutRmsKm;
   const arcs=[nominal.oem];for(let j=0;j<6;j++){const perturbed=values.slice();perturbed[j]+=j<3?recipe.positionPerturbationKm:recipe.velocityPerturbationKmS;arcs.push((await propagator.propagate(perturbed,epoch,25)).oem);}
   const fit=await checked(catalog.h,makeRequest('fit_epoch_step',arcs));seedBytes=fit.outputs.find(x=>x.portId==='candidate').payload;iterations++;
  }
  // Analytic velocity versus derivatives on the generated trajectory, h=1,.5 s.
  // This is a diagnostic convergence comparison, never an identity gate.
  const values=unpackOpm(seedBytes),derivatives=[];
  for(const step of [1,.5]) {const trajectory=(await propagator.propagate(values,epoch,5,step)).values;let sum=0;
   for(let j=0;j<3;j++){const fd=[-25,48,-36,16,-3].reduce((x,w,k)=>x+w*(trajectory[6*k+j]-trajectory[j]),0)/(12*step);sum+=(fd-values[j+3])**2;}derivatives.push(Math.sqrt(sum));}
  results.push({eccentricity:selectedRow.eccentricity,iterations,status:final.status,initialTrainingRmsKm:first.trainingRmsKm,initialHoldoutRmsKm:first.holdoutRmsKm,finalTrainingRmsKm:final.trainingRmsKm,finalHoldoutRmsKm:final.holdoutRmsKm,maximumHoldoutResidualKm:final.maximumHoldoutResidualKm,history,derivativeDiagnosticKmS:{h1:derivatives[0],hHalf:derivatives[1]},referenceSha256:final.referenceSha256});
  process.stderr.write(`Completed ${results.length}/${selected.length}: ${final.status}\n`);
 }
 console.log(JSON.stringify({scope:'Offline real-provider module integration; no deployment, covariance or conjunction claim',normalizerSha256:normalizer.sha,catalogSha256:catalog.sha,model:propagator.policy,arcSeconds:14400,holdoutStride:4,positionToleranceKm:1,results},null,2));
}finally{await normalizer.h.destroy();await catalog.h.destroy();await propagator.destroy();}

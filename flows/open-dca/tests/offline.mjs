import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {modules,load} from './inputs.mjs';
import {energyOracle,decodeDcl,dclFrame} from './energy-oracle.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
export async function readInputs(dir){return Promise.all(JSON.parse(await fs.readFile(path.join(dir,'fit-frames.json'))).map(async({file,...f})=>({...f,payload:await fs.readFile(path.join(dir,file))})));}
export async function offline(dir){
 const inputs=await readInputs(dir),wasm=await fs.readFile(path.join(modules,'analysis/density-calibration/dist/isomorphic/module.wasm'));
 const key=hash(Buffer.concat([wasm,...inputs.map(f=>f.payload)])),file=path.join(dir,`offline-${key}.json`);
 try{return JSON.parse(await fs.readFile(file));}catch(e){if(e.code!=='ENOENT')throw e;}
 const oracle=await energyOracle(inputs),density=await load('analysis/density-calibration');
 const result={key,artifactSha256:hash(wasm),inputSha256:inputs.map(f=>hash(f.payload)),arcs:[],maxRelativeB:0,maxRelativeSigma:0,started:new Date().toISOString()};
 const env=inputs.filter(f=>f.portId!=='request');
 try{
  for(const [seriesIndex,f]of inputs.filter(f=>f.portId==='request').entries()){
   if(process.env.OPEN_DCA_DEBUG_SERIES&&seriesIndex+1!==Number(process.env.OPEN_DCA_DEBUG_SERIES))continue;
   const d=decodeDcl(f),lines=d.STATES.EPHEMERIS.EPHEMERIS_DATA_LINES;
   const states=lines.map(s=>({ms:Date.parse(s.EPOCH+'Z'),state:[s.X,s.Y,s.Z,s.X_DOT,s.Y_DOT,s.Z_DOT].map(v=>v*1000)}));
   if(!states.some((s,i)=>i>0&&(s.ms-states[i-1].ms)/3600000>=20&&(s.ms-states[i-1].ms)/3600000<=28))continue;
   const actual=decodeDcl((await density.call('fit_energy_arcs',[f,...env])).outputs[0]).OBJECTS;
   let B=d.BALLISTIC_COEFFICIENT_M2_KG,index=0;
   for(let j=1;j<states.length;j++){
    const a=states[j-1],b=states[j],hours=(b.ms-a.ms)/3600000;if(hours<20||hours>28)continue;
    const e=await oracle.energyArc(a,b,{b0:B,cr:0.0135,sigma:{posRtnM:[4,10,2],velRtnMmS:[10,3,2.5]},tolerance:1e-3,maxIterations:6});
    const got=actual[index++];assert(got,'Missing accepted-duration arc');assert.equal(Number(got.FIRST_MS),a.ms,'Arc start identity');assert.equal(Number(got.LAST_MS),b.ms,'Arc end identity');const accepted=e.B>0&&Math.abs(e.B/e.B0-1)<1e-3&&e.sigmaB/e.B<=0.5;
    assert.equal(got.OK,accepted,'Frozen energy estimator acceptance');
    if(accepted){
     const delta=Math.abs(got.BALLISTIC_COEFFICIENT_M2_KG/e.B-1),sigmaDelta=Math.abs(got.LN_B_SIGMA/(e.sigmaB/e.B)-1);
     result.maxRelativeB=Math.max(result.maxRelativeB,delta);result.maxRelativeSigma=Math.max(result.maxRelativeSigma,sigmaDelta);
     // Independent paths use identical FFM and energy methods. 1e-9 allows
     // only floating-point covariance/matrix ordering, far below arc sigma.
     assert(delta<1e-9&&sigmaDelta<1e-9,`Energy reference mismatch series=${seriesIndex+1} pair=${j} B=${delta} sigma=${sigmaDelta}; iterations WASM=${got.FIT.ITERATIONS} E13=${e.iterations}; epoch=${a.ms}; seed=${B}; actual=${got.BALLISTIC_COEFFICIENT_M2_KG}; expected=${e.B}`);
     result.arcs.push({dove:d.ID,startMs:a.ms,endMs:b.ms,y:Math.log(e.B),B:e.B,sigma:e.sigmaB/e.B});B=e.B;
    }
   }
   assert.equal(index,actual.length,'All and only the 20–28 hour arcs are compared');
   console.log(`Offline E13 ${seriesIndex+1}/${inputs.length-env.length}: ${result.arcs.length} accepted arcs; max relative B ${result.maxRelativeB}`);
  }
  result.completed=new Date().toISOString();if(process.env.OPEN_DCA_DEBUG_SERIES)return result;await fs.writeFile(file,JSON.stringify(result));await fs.writeFile(path.join(dir,'offline-receipt-path.txt'),file);return result;
 }finally{await oracle.destroy();await density.destroy();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await offline(process.argv[2]);

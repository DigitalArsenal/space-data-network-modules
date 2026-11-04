// Registered replay for modules-sdn-ap-covariance-noise-ap-20261103.
// UTC/TEME km, reference axes carried by the registered foundation/frames module. Refit the registered AP5/AP6 arcs under LOG_NORMAL and FORCES
// 31,20. Signed errors and covariance must share epochs: stored daily RTN RMS
// cannot substitute for signed errors. No held-out or operator source is opened.
// Score days 1,2,3,7 on a 30-minute grid, matching covariance-realism sampling.
// Each window supplies P0 and four noise bases from the module. Fit nonnegative
// squared noise sizes by Gaussian likelihood; report SPEC 12.7 unchanged.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Worker, isMainThread, workerData } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { createStandaloneHarness } from 'space-data-module-sdk/testing/isomorphic';
import * as fb from 'flatbuffers';
import { OMM } from 'spacedatastandards.org/lib/js/OMM/OMM.js';
import { OEM } from 'spacedatastandards.org/lib/js/OEM/OEM.js';
import { wasmPath } from './module.mjs';
import { openApOcm, noiseOf, withNoise, flight } from './ocm.mjs';
import { experiments as external } from './experiments.mjs';
const DAY=86400000, HOUR=3600000, UNIT=1e-6;
const ms=s=>Date.parse(s.endsWith('Z')?s:s+'Z');
const archive=process.env.SDN_ARCHIVE??'/opt/data/sdn-archive';
const scratch=process.env.SDN_AP_CALIBRATION_CACHE??'/Users/tj/software/terrain-work/body-look/codex-apfix-d9/replay';
process.env.SDN_MODULES_ROOT ??= path.resolve(new URL('../../../../', import.meta.url).pathname);
const imp=p=>import(path.join(external,'experiments',p));
const readRows=dir=>fs.readdirSync(dir).filter(f=>/^rows-\d+\.jsonl$/.test(f)).sort().flatMap(f=>fs.readFileSync(path.join(dir,f),'utf8').split('\n').filter(Boolean).map(JSON.parse));
const checksum=createHash('sha256').update(fs.readFileSync(wasmPath)).digest('hex');
const filename=w=>path.join(scratch,createHash('sha256').update(checksum+"lead-bins-30min-teme-v2"+w.key+w.arm).digest('hex')+'.json.gz');
function windows(){
 const base=path.join(archive,'operator-theory/ap/b040');
 const ap=new Map(readRows(path.join(base,'truth2')).map(r=>[r.key,r]));
 const rows=readRows(path.join(base,'compare-truth2')).map(r=>({...r,arms:ap.get(r.key)?.arms??{}})).concat(readRows(path.join(base,'regimes')));
 const held=new Set([43567,37847,41862,41174,43055,41175]);
 const out=new Map();
 for(const r of rows){
  if(held.has(r.norad)) throw Error('held Galileo in calibration inventory');
  if(['P','S1','GN'].includes(r.group)&&r.cutoff>='2026-06-01') throw Error('held cutoff');
  for(const arm of ['AP24','AP72']) if(r.arms?.[arm]?.ok) out.set(r.key+arm,{...r,arm,stored:r.arms[arm],arms:undefined});
 }
 return [...out.values()];
}
async function replay(list){
 const S=await imp('xp-atmosphere-merit/lib/sds.mjs');
 const T=await imp('xp-atmosphere-merit/lib/truth.mjs');
 const W=await imp('xp-atmosphere-merit/lib/weather.mjs');
 const XM=await imp('xp-atmosphere-merit/common.mjs');
 const SRC=await imp('sdn-gp-starlink-ffm-match/lib/sources.mjs');
 const {STATIC,TESS,HX}=await imp('operator-theory/lib/regimes.mjs');
 const h=await createStandaloneHarness('browser',wasmPath,{surface:'direct'}),A=await openApOcm(wasmPath);
 const {openAxes}=await imp('operator-theory/lib/host.mjs');
 const referenceAxes=await openAxes();
 const objects=new Map();
 let weather6=null;
 async function lines(w){
  const cutoff=ms(w.cutoff),hours=Number(w.arm.slice(2));
  if(['P','S1','GN'].includes(w.group)){
   const o=XM.config.groups[w.group].objects.find(o=>o.norad===w.norad);
   if(!o)throw Error('unregistered object');
   return T.series(o,cutoff-hours*HOUR,cutoff+7*DAY).lines;
  }
  if(!objects.has(w.norad)){
   let s;
   if(['LS','DO','GD'].includes(w.group)){
    const clean=s=>s.toLowerCase().replace(/[^a-z0-9]/g,'');
    const o=STATIC.find(o=>o.group===w.group&&clean(o.name)===clean(w.name))??STATIC.find(o=>{
     if(o.group!==w.group)return false;
     const file=o.files()[0];return file&&SRC.readReference(file).norad===w.norad;
    });
    if(!o)throw Error('static object mapping: '+w.name);
    s=SRC.chain(o.files()).lines;
   }else if(['IG','GE'].includes(w.group)){
    const root=path.join(archive,'e14-covariance-realism/reference');
    const files=Array.from({length:20},(_,i)=>path.join(root,`GFZ0MGXRAP_2025${274+i}0000_01D_05M_ORB`,`${w.norad}.oem`)).filter(f=>fs.existsSync(f));
    s=SRC.chain(files).lines;
   }else{
    const {spkObjectSeries}=await imp('sdn-gp-starlink-ffm-match/lib/spk-sources.mjs');
    const {openAxes}=await imp('operator-theory/lib/host.mjs');
    const o=w.group==='HE'?TESS:HX.find(o=>o.norad===w.norad);
    if(!o)throw Error('unregistered kernel');
    const files=w.group==='HE'?fs.readdirSync(o.dir).filter(f=>/^TESS_EPH_DEF_.*\.bsp$/.test(f)).sort().map(f=>path.join(o.dir,f)):[o.file];
    const raw=await spkObjectSeries(process.env.SDN_MODULES_ROOT,{files,source:'ap6-heo',id:w.group==='HE'?'TESS (-95)':o.id,name:o.name,norad:o.norad,fromUtc:o.from,toUtc:o.to,stride:1});
    const first=Math.round(ms(raw.lines[0].epoch)/1000)*1000;
    const thin=raw.lines.filter(l=>(Math.round(ms(l.epoch)/1000)*1000-first)%300000===0).map(l=>({...l,epoch:new Date(Math.round(ms(l.epoch)/1000)*1000).toISOString()}));
    const axes=await openAxes(); s=await axes.convert(thin,'EME2000','GCRF'); await axes.close();
   }
   objects.set(w.norad,s);
  }
  return objects.get(w.norad).filter(l=>ms(l.epoch)>=cutoff-hours*HOUR&&ms(l.epoch)<=cutoff+7*DAY);
 }
 for(const w of list){
  const file=filename(w);
  const cached=fs.existsSync(file)?JSON.parse(zlib.gunzipSync(fs.readFileSync(file))):null;
  if(cached?.noise)continue;
  try{
   const cutoff=ms(w.cutoff),all=await lines(w),thin=T.thinned(all.filter(l=>ms(l.epoch)<=cutoff)).chosen;
   if(thin.length<8)throw Error('too few fit states');
   const after=all.filter(l=>ms(l.epoch)>cutoff);
   const gridMs=Math.max(300000,Math.ceil((ms(after[1].epoch)-ms(after[0].epoch))/300000)*300000);
   // The original lead-day bins, sampled every 30 minutes as the existing
   // covariance-realism harness does. No interpolation or JS orbit physics.
   const sampleMs=Math.max(1800000,Math.ceil(1800000/gridMs)*gridMs);
   const scored=after.filter(l=>(ms(l.epoch)-ms(after[0].epoch))%sampleMs===0&&w.stored.days[Math.ceil((ms(l.epoch)-cutoff)/DAY)]);
   const vacuum=['HE','HX'].includes(w.group);
   if(!vacuum&&!['P','S1','GN'].includes(w.group)&&!weather6){
    // cycle-ap6 runs through XP2F's normalized 2024/2025 RSGA inventory.
    const xp2=JSON.parse(fs.readFileSync(path.join(external,'experiments/xp2-fit-design/config.json')));
    XM.config.spaceWeather.rsgaDirs=[path.join(xp2.store,'rsga/normalized')];
    weather6=await import(path.join(external,'experiments/xp-atmosphere-merit/lib/weather.mjs')+'?ap6');
   }
   const weather=vacuum?null:(['P','S1','GN'].includes(w.group)?W:weather6).rowsO(cutoff-6*DAY,cutoff);
   if(weather?.excluded)throw Error(weather.excluded);
   const config=S.pcfBytes({forces:{...(vacuum?{}:XM.config.arms.X2.forces),HAS_MAXIMUM_TESSERAL_DEGREE:true,MAXIMUM_TESSERAL_DEGREE:31,HAS_MAXIMUM_DEGREE:true,MAXIMUM_DEGREE:20},fit:null});
   // the fit on $OCM under the arm's FORCES (openApOcm writes 0.4's ENABLE_DRAG as ATMOSPHERE_MODEL and holds the rows as 0.4 did)
   const fitted=await A.fit(S.oemBytes({frame:'GCRF',object:{name:w.name,norad:w.norad},lines:thin,useableStart:thin[0].epoch,useableStop:w.cutoff}),config,weather?{rows:S.spwBytes(weather.rows)}:undefined);
   if(!fitted.ok)throw Error(fitted.error);
   const ocm=fitted.omm,model=noiseOf(ocm);
   if(!model)throw Error('fit returned no covariance');
   if(cached){
    if(cached.ngRate!==model.ngRate)throw Error('cached replay fit changed');
    cached.noise=model.noise;
    fs.writeFileSync(file,zlib.gzipSync(JSON.stringify(cached)));
    await new Promise(resolve=>setImmediate(resolve));
    continue;
   }
   const ta=model.noise[4];
   const reference=await referenceAxes.convert(scored,'GCRF','TEME');
   const runs=[];
   for(let k=-1;k<4;k++){
    const r=await h.invoke({methodId:'propagate',inputs:flight([withNoise(ocm,[...[0,1,2,3].map(j=>j===k?UNIT:0),ta])],{output:{EPOCHS:scored.map(l=>l.epoch)}})});
    if(r.statusCode!==0)throw Error(r.errorCode+': '+r.errorMessage);
    runs.push(OEM.getRootAsOEM(new fb.ByteBuffer(r.outputs.find(o=>o.portId==='ephemeris').payload)).unpack().EPHEMERIS_DATA_BLOCK[0]);
   }
   const pos=c=>[c.CX_X,c.CY_X,c.CY_Y,c.CZ_X,c.CZ_Y,c.CZ_Z];
   const samples=scored.map((l,i)=>{const state=runs[0].EPHEMERIS_DATA_LINES[i],P0=pos(runs[0].COVARIANCE_MATRIX_LINES[i]);return{day:Math.ceil((ms(l.epoch)-cutoff)/DAY),e:[state.X-reference[i].r[0],state.Y-reference[i].r[1],state.Z-reference[i].r[2]],P0,B:runs.slice(1).map(r=>pos(r.COVARIANCE_MATRIX_LINES[i]).map((v,j)=>(v-P0[j])/UNIT**2))};});
   const result={noise:model.noise,key:w.key,arm:w.arm,group:w.group,regime:model.regime,ngRate:model.ngRate,nDay:model.nDay,samples,stored:w.stored.days};
   fs.writeFileSync(file,zlib.gzipSync(JSON.stringify(result)));
   console.log(`${w.key} ${w.arm}: ${samples.length} covariance samples`);
   await new Promise(resolve=>setImmediate(resolve));
  }catch(e){console.error(`${w.key} ${w.arm}: ${e.stack}`);throw e;}
 }
 await referenceAxes.close();
}
export async function runReplay(){
 fs.mkdirSync(scratch,{recursive:true});
 let list=windows();
 const limit=Number(process.env.SDN_AP_CALIBRATION_LIMIT??0);if(limit)list=list.slice(0,limit);
 console.log(`registered AP windows: ${list.length}; module ${checksum}`);
 const n=Math.min(12,Number(process.env.SDN_AP_CALIBRATION_WORKERS??12),list.length);
 await Promise.all(Array.from({length:n},(_,k)=>new Promise((resolve,reject)=>{const w=new Worker(new URL(import.meta.url),{workerData:{list:list.filter((_,i)=>i%n===k)}});w.on('error',reject);w.on('exit',code=>code?reject(Error(`worker exit ${code}`)):resolve());})));
 const results=list.map(w=>JSON.parse(zlib.gunzipSync(fs.readFileSync(filename(w)))));
 fs.writeFileSync(path.join(scratch,'index.json'),JSON.stringify({checksum,files:list.map(filename)}));
 console.log(`replayed ${results.length} windows; covariance bases in ${scratch}`);
 return results;
}
if(!isMainThread)await replay(workerData.list);

// Symmetric 3x3 Gaussian likelihood; statistics only, no orbital dynamics.
function metric(P,e){
 const [a,b,c,d,f,g]=P, det=a*(c*g-f*f)-b*(b*g-f*d)+d*(b*f-c*d);
 if(!(a>0&&a*c-b*b>0&&det>0))return null;
 const d2=((c*g-f*f)*e[0]**2+(a*g-d*d)*e[1]**2+(a*c-b*b)*e[2]**2+2*(d*f-b*g)*e[0]*e[1]+2*(b*f-c*d)*e[0]*e[2]+2*(b*d-a*f)*e[1]*e[2])/det;
 if(!Number.isFinite(d2)||d2<0)return null;
 return {d2,logDet:Math.log(det)};
}
export function calibrate(results){
 const report={moduleSha256:checksum,created:new Date().toISOString(),bands:{meanD2Over3:[0.8,1.25],coverage95:[0.93,0.97]},tables:{},cells:[]};
 for(const regime of ['DRAG','ABOVE']){
  const rows=results.filter(r=>r.regime===regime);
  const samples=rows.flatMap(r=>r.samples.map(s=>({...s,key:r.key,arm:r.arm,group:r.group,B:s.B.map((b,k)=>b.map(v=>v*(k===3?(Math.abs(r.ngRate)*r.nDay)**2:1)))})));
  const covariance=(s,theta)=>s.P0.map((v,j)=>v+theta.reduce((a,t,k)=>a+t*t*s.B[k][j],0));
  const nll=lg=>{const theta=lg.map(x=>10**x);let v=0;for(const s of samples){const m=metric(covariance(s,theta),s.e);if(!m)return Infinity;v+=m.logDet+m.d2;}return v;};
  let best=null;
  for(const start of [-8,-6]){
   let lg=[start,start,start,regime==='DRAG'?-1:-Infinity],value=nll(lg);
   for(let step=1;step>=1/128;step/=2){
    let moved=true,iterations=0;
    while(moved&&iterations++<100){moved=false;for(let k=0;k<(regime==='DRAG'?4:3);k++)for(const sign of [-1,1]){
     const trial=lg.slice();trial[k]+=sign*step;const v=nll(trial);
     if(v<value){lg=trial;value=v;moved=true;}
    }}
   }
   if(!best||value<best.value)best={lg,value};
  }
  const theta=best.lg.map(x=>10**x);report.tables[regime]={s_e:theta[0],s_i:theta[1],s_l:theta[2],c:theta[3],negativeLogLikelihood:best.value};
  for(const day of [1,2,3,7]){
   const ss=samples.filter(s=>s.day===day),d2=ss.map(s=>metric(covariance(s,theta),s.e)?.d2??Infinity);
   const windows=new Set(ss.map(s=>s.key)).size;
   const meanD2Over3=d2.reduce((a,b)=>a+b,0)/(3*d2.length),coverage95=d2.filter(v=>v<=7.814727903251178).length/d2.length;
   const pass=meanD2Over3>=.8&&meanD2Over3<=1.25&&coverage95>=.93&&coverage95<=.97;
   const cell={regime,day,windows,samples:ss.length,meanD2Over3,coverage95,pass,required:windows>=30};
   report.cells.push(cell);console.log(JSON.stringify(cell));
  }
  console.log(JSON.stringify({regime,...report.tables[regime]}));
 }
 report.pass=report.cells.some(c=>c.required)&&report.cells.every(c=>!c.required||c.pass);
 fs.writeFileSync(path.join(scratch,'calibration.json'),JSON.stringify(report,null,2)+'\n');
 return report;
}

export function evaluate(results){
 const report={kind:"shipped",moduleSha256:checksum,created:new Date().toISOString(),forces:[31,20],windows:results.length,cells:[]};
 for(const regime of ['DRAG','ABOVE'])for(const day of [1,2,3,7]){
  const samples=results.filter(r=>r.regime===regime).flatMap(r=>r.samples.filter(s=>s.day===day).map(s=>({key:r.key,s,noise:r.noise})));
  const d2=samples.map(({s,noise})=>{
   if(!noise)throw Error('cached fit has no emitted noise');
   const P=s.P0.map((v,j)=>v+s.B.reduce((a,b,k)=>a+noise[k]**2*b[j],0));
   const m=metric(P,s.e);if(!m)throw Error('non-positive-definite covariance');return m.d2;
  });
  const windows=new Set(samples.map(s=>s.key)).size;
  const meanD2Over3=d2.reduce((a,b)=>a+b,0)/(3*d2.length),coverage95=d2.filter(v=>v<=7.814727903251178).length/d2.length;
  const cell={regime,day,windows,samples:d2.length,meanD2Over3,coverage95,required:windows>=30,pass:meanD2Over3>=.8&&meanD2Over3<=1.25&&coverage95>=.93&&coverage95<=.97};
  report.cells.push(cell);console.log(JSON.stringify(cell));
 }
 report.pass=report.cells.some(c=>c.required)&&report.cells.every(c=>!c.required||c.pass);
 fs.writeFileSync(path.join(scratch,'shipped.json'),JSON.stringify(report,null,2)+'\n');
 return report;
}

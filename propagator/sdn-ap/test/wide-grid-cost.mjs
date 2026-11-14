import fs from 'node:fs';import os from 'node:os';import {performance} from 'node:perf_hooks';import {createHash} from 'node:crypto';
import {records,open} from './lib/wide-catalog.mjs';
import {wasmPath} from './lib/module.mjs';
import {buildDiagnostic} from './lib/ap-diagnostic.mjs';
// Raw ABBA rounds for an equal-work comparison. Pool startup and record loading
// are outside the state timers. Cell costs include construction, sampling and checks.
const [kind,roundArg,file]=process.argv.slice(2),rounds=Number(roundArg);
if(!['wide-serial-pool','wide-pool-pool','cell'].includes(kind)||!Number.isInteger(rounds)||rounds<1||!file)throw Error('usage: node test/wide-grid-cost.mjs wide-serial-pool|wide-pool-pool|cell ROUNDS OUTPUT.json');
const wasm=kind==='cell'?buildDiagnostic('wide-cell-cost',`
SDNAP_EXPORT("sdnap_test_wide_cell") int sdnap_test_wide_cell(uint32_t i,double t,double* out){
 auto& s=sdnap::frames::state();uint32_t bytes=0;
 const int rc=sdnap::frames::row(s,i,t,bytes);out[0]=bytes;out[1]=s.split;
 if(bytes){double mid,half;std::memcpy(&mid,sdnap::frames::g_cell,8);std::memcpy(&half,sdnap::frames::g_cell+8,8);out[2]=mid;out[3]=half;}
 return rc;
}`):wasmPath;
const rs=records(kind==='cell'?1000:10000).filter((_,i)=>(!kind.startsWith('wide-')&&kind!=='cell')||i%10===0);
const out={kind,complete:false,start:new Date().toISOString(),loadStart:os.loadavg(),rounds:[],count:rs.length};
const save=()=>fs.writeFileSync(file,JSON.stringify(out));
async function arm(side){
 const threads=kind.endsWith('serial-pool')?(side==='A'?0:3):kind.endsWith('pool-pool')?(side==='A'?3:14):0;
 const h=await open(wasm,threads,rs.length);
 try{
  let t=performance.now();await h.load(rs);const loadMs=performance.now()-t;
  if(kind==='cell'){
   if(h.x.sdnap_frames_open(8*1024*1024,0)!==0)throw Error('frames open');
   if(side==='B')for(let i=0;i<rs.length;i++)h.x.sdnap_test_wide_cell(i,0,h.q);
   const classes=Array.from({length:2},()=>({count:0,ms:0,status:{},bytes:0,spanMinutes:{},splits:0}));let previousSplits=side==='B'?new Float64Array(h.h.memory.buffer,h.q,4)[1]:0;
   for(let i=0;i<rs.length;i++){t=performance.now();const rc=h.x.sdnap_test_wide_cell(i,side==='A'?0:48,h.q);const elapsed=performance.now()-t;const v=Array.from(new Float64Array(h.h.memory.buffer,h.q,4));const c=classes[i%2];c.count++;c.ms+=elapsed;c.status[rc]=(c.status[rc]||0)+1;c.bytes+=v[0];c.splits+=v[1]-previousSplits;previousSplits=v[1];if(v[0])c.spanMinutes[v[3]*2]=(c.spanMinutes[v[3]*2]||0)+1;}
   return {side,loadMs,firstMs:classes.reduce((s,c)=>s+c.ms,0),classes,budget:h.budget().out,linearBytes:h.h.memory.buffer.byteLength};
  }
  const passes=[];
  for(let pass=0;pass<2;pass++){t=performance.now();const rc=h.x.sdnap_epochs_at(2461206.5,1,0,rs.length,0,h.p,h.s,0);const ms=performance.now()-t;const status=Array.from(new Int32Array(h.h.memory.buffer,h.s,rs.length));if(rc||status.some(x=>x!==0))throw Error('state refusal');const hash=createHash('sha256').update(new Uint8Array(h.h.memory.buffer,h.p,48*rs.length)).digest('hex');passes.push({ms,digest:hash,budget:h.budget().out,linearBytes:h.h.memory.buffer.byteLength});}
  if(passes[0].digest!==passes[1].digest)throw Error('steady states differ');
  h.x.sdnap_pool_stats(h.q,16);const pool=Array.from(new Float64Array(h.h.memory.buffer,h.q,16));
  return {side,threads:threads+1,loadMs,firstMs:passes[0].ms,steadyMs:passes[1].ms,passes,pool};
 }finally{await h.close();}
}
for(let r=0;r<rounds;r++){const arms=[];for(const side of ['A','B','B','A'])arms.push(await arm(side));if(kind!=='cell'&&new Set(arms.map(a=>a.passes[0].digest)).size!==1)throw Error('thread state difference');out.rounds.push(arms);save();}
out.complete=true;out.end=new Date().toISOString();out.loadEnd=os.loadavg();save();

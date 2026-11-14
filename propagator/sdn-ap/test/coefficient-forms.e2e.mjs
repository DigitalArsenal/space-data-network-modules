// Cached AP forms against direct coefficient evaluation at the state's elements.
// Synthetic OCM streams; UTC epochs from the records; TEME positions in meters.
// The bounds and their measurement rationale are in lib/coefficient-forms.mjs.
// Every bake boundary and bracket node is checked through 120 h with cubic fits
// over +/-8 s at 0.1 s, excluding +/-0.5 s. Exact-distance samples are 300 s apart.
// SDNAP_WASM selects the production artifact; COEFFICIENT_CONTROL selects the
// unchanged artifact (default: committed dist). No reference digest is replaced.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {mixedForms} from './lib/coefficient-mixed.mjs';
import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {T} from './lib/ocm.mjs';
import {cases,records,buildForms} from './lib/coefficient-forms.mjs';
import {wasmPath} from './lib/module.mjs';
const builds=process.env.COEFFICIENT_BUILDS?JSON.parse(fs.readFileSync(process.env.COEFFICIENT_BUILDS)):buildForms();
const candidateFile=process.env.SDNAP_WASM??builds.production??wasmPath;
const control=process.env.COEFFICIENT_CONTROL??new URL('../dist/isomorphic/module.wasm',import.meta.url).pathname;
const DAY=86400000, span=432000;
const distance=(a,b)=>Math.hypot(...a.slice(0,3).map((v,k)=>v-b[k]));
async function open(file,r){
 const h=await createStandaloneHarness('browser',file,{surface:'direct',maxThreads:1,enableBrowserWasiThreads:false});
 const x=h.instance.exports,out=x.sdnap_alloc(48),level=x.sdnap_alloc(512),p=Buffer.alloc(r.bytes.length+4);p.writeUInt32LE(r.bytes.length);r.bytes.copy(p,4);
 const result=await h.invoke({methodId:'load_epochs',inputs:[{portId:'ocm',typeRef:T('OCM'),payload:p}]});assert.equal(result.statusCode,0);
 return {x,close:()=>h.close?.(),st(t){const ms=r.epochMs+t*1000,d=Math.floor(ms/DAY),status=x.sdnap_epochs_set_at(0,0,d+2440587.5,(ms-d*DAY)/DAY,out);return {status,v:status===0?Array.from(new Float64Array(h.memory.buffer,out,6),v=>v*1000):null};},levels(){const n=x.sdnap_test_levels(level),v=new Float64Array(h.memory.buffer,level,64);return {valid:v[0],lo:v[1]*60,h:v[2]*60,ns:Array.from(v.slice(3,3+n))};}};
}
const fitAt = (ts, ys, t0) => {  // cubic least squares, evaluated at t0
  const n = ts.length, A = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], b = [0, 0, 0, 0];
  for (let i = 0; i < n; i++) { const x = (ts[i] - t0) / 8, p = [1, x, x * x, x * x * x]; for (let a = 0; a < 4; a++) { b[a] += p[a] * ys[i]; for (let c = 0; c < 4; c++) A[a][c] += p[a] * p[c]; } }
  for (let p = 0; p < 4; p++) for (let a = p + 1; a < 4; a++) { const f = A[a][p] / A[p][p]; for (let c = p; c < 4; c++) A[a][c] -= f * A[p][c]; b[a] -= f * b[p]; }
  const x = [0, 0, 0, 0]; for (let p = 3; p >= 0; p--) { let s = b[p]; for (let c = p + 1; c < 4; c++) s -= A[p][c] * x[c]; x[p] = s / A[p][p]; }
  let rss = 0; for (let i = 0; i < n; i++) { const u = (ts[i] - t0) / 8; rss += (ys[i] - (x[0] + x[1] * u + x[2] * u * u + x[3] * u * u * u)) ** 2; }
  return [x[0], Math.sqrt(rss / n)];
};
const summaries=[];
for(const [i,r] of records().entries()){
 const [name,form,exactBound,jumpBound,moveBound]=cases[i];
 const [candidate,probe,unchanged,full,exact]=await Promise.all([candidateFile,builds.probe,control,builds.full,builds.exact].map(f=>open(f,r)));
 const summary={name,form,states:0,unchanged:0,maxExactM:0,maxMoveM:0,maxJumpM:0,boundaries:0};
 for(let t=0;t<=span;t+=300){
  const s=[candidate,probe,unchanged,full,exact].map(m=>m.st(t));
  assert(s.every(q=>q.status===s[0].status),`${name}: status at ${t}`);if(!s[0].v)continue;
  summary.states++;assert.deepEqual(s[0].v,s[1].v,`${name}: probe changes output`);
  assert.deepEqual(s[2].v,s[3].v,`${name}: diagnostic U differs from committed state`);
  assert.equal(probe.x.sdnap_test_form(),form,`${name}: fixed selection`);
  summary.maxExactM=Math.max(summary.maxExactM,distance(s[0].v,s[4].v));summary.maxMoveM=Math.max(summary.maxMoveM,distance(s[0].v,s[2].v));
  if(s[0].v.every((v,k)=>Object.is(v,s[2].v[k])))summary.unchanged++;
  if(form===0)assert.deepEqual(s[0].v,s[2].v,`${name}: U differs`);
 }
 assert(summary.states>0);assert(summary.maxExactM<=exactBound,`${name}: exact distance ${summary.maxExactM} > ${exactBound}`);
 assert(summary.maxMoveM<=moveBound,`${name}: movement ${summary.maxMoveM} > ${moveBound}`);
 const bounds=new Set(),seen=new Set();
 for(let t=1;t<span;t+=120){if(!probe.st(t).v)continue;const b=probe.levels();if(!b.valid||seen.has(b.lo))continue;seen.add(b.lo);bounds.add(+b.lo.toFixed(3));for(const n of b.ns)for(let k=1;k<n;k++)bounds.add(+(b.lo+b.h*k/n).toFixed(3));}
 for(const t of [...bounds].sort((a,b)=>a-b)){
  if(t<10||t>span-10)continue;const left=[],right=[];
  for(let k=0;k<75;k++){const l=t-8+k*.1,rr=t+.5+k*.1;left.push([l,candidate.st(l).v]);right.push([rr,candidate.st(rr).v]);}
  if([...left,...right].some(q=>!q[1]))continue;
  const jump=[];for(let j=0;j<3;j++)jump.push(fitAt(right.map(q=>q[0]),right.map(q=>q[1][j]),t)[0]-fitAt(left.map(q=>q[0]),left.map(q=>q[1][j]),t)[0]);
  summary.boundaries++;summary.maxJumpM=Math.max(summary.maxJumpM,Math.hypot(...jump));
 }
 assert(summary.boundaries>0);assert(summary.maxJumpM<=jumpBound,`${name}: jump ${summary.maxJumpM} > ${jumpBound}`);
 if(form===0)assert.equal(probe.x.sdnap_test_thread_derivative_bytes(),0,'U allocates thread derivative rows');
 summaries.push(summary);console.log(JSON.stringify(summary));
 await Promise.all([candidate,probe,unchanged,full,exact].map(m=>m.close()));
}
if(process.env.COEFFICIENT_JSON)fs.writeFileSync(process.env.COEFFICIENT_JSON,JSON.stringify(summaries,null,2)+'\n');
await mixedForms(candidateFile);
console.log('coefficient forms: all measured bounds passed');
process.exit(0);

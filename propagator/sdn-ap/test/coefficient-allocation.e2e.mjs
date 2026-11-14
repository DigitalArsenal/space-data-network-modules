#!/usr/bin/env node
// Synthetic U and A sets, UTC fixture epoch, TEME km and km/s. A thread first
// serves only U, then encounters A with its derivative-row allocation refused.
// Caller retry must return exactly the serial states. This test also forces the
// scalar-row fallback of the SIMD derivative-vector loader.
import assert from 'node:assert/strict';
import {buildDiagnostic} from './lib/ap-diagnostic.mjs';
import {records} from './lib/coefficient-forms.mjs';
import {repackOcm,ocmOf,seedOcm} from './lib/ocm.mjs';
import {coefficientHarness} from './lib/coefficient-harness.mjs';
const extra=String.raw`
SDNAP_EXPORT("sdnap_test_fail_derivatives") void sdnap_test_fail_derivatives(int mode) { sdnap::xpt::tess::g_test_fail_derivatives=mode; }
SDNAP_EXPORT("sdnap_test_derivative_failures") int sdnap_test_derivative_failures(){return sdnap::xpt::tess::g_test_derivative_failures;}
SDNAP_EXPORT("sdnap_test_u_transitions") int sdnap_test_u_transitions(){return sdnap::xpt::tess::g_test_u_transitions;}
SDNAP_EXPORT("sdnap_test_retries") int sdnap_test_retries(){return sdnap::xpt::tess::g_test_retries;}
`;
const file=process.env.COEFFICIENT_ALLOCATION_WASM??buildDiagnostic('coefficient-allocation',extra,s=>s.replace('    if (!s.pooled ||','    if (true || !s.pooled ||'),{
 'sdn_ap_module.cpp':s=>'namespace sdnap::pool { extern thread_local bool g_pool_thread; } namespace sdnap::xpt { extern thread_local int g_alloc_refused; }\n'+s,
 'tesseral.inc':s=>s.replace('inline MdailyDerivatives* mdaily_derivatives() {',String.raw`
inline int g_test_fail_derivatives=0,g_test_derivative_failures=0,g_test_u_transitions=0,g_test_retries=0;
inline thread_local bool g_test_saw_u=false;
inline MdailyDerivatives* mdaily_derivatives() {
 if(g_test_fail_derivatives && (g_test_fail_derivatives==2 || sdnap::pool::g_pool_thread)){
  __atomic_fetch_add(&g_test_derivative_failures,1,__ATOMIC_RELAXED);
  if(g_test_saw_u)__atomic_fetch_add(&g_test_u_transitions,1,__ATOMIC_RELAXED);
  sdnap::mem::note_failure(sizeof(MdailyDerivatives));if(sdnap::pool::g_pool_thread)sdnap::xpt::g_alloc_refused=1;return nullptr;
 }
`).replaceAll('uint8_t form, Args&&... args) {','uint8_t form, Args&&... args) {\n  if(form==0 && sdnap::pool::g_pool_thread)g_test_saw_u=true;'),
 'epoch_store.inc':s=>s.replace('    std::sort(deferred, deferred + n);','    std::sort(deferred, deferred + n);\n    sdnap::xpt::tess::g_test_retries += n;')});
const fixtures=records(),N=128;
const all=Array.from({length:N*2},(_,i)=>{const q=ocmOf(fixtures[i<N?7:4].bytes).MEAN_ELEMENTS;return {epochMs:Date.parse('2026-06-15T00:00:00Z'),bytes:seedOcm({epoch:'2026-06-15T00:00:00',n:q.MEAN_MOTION,e:q.ECCENTRICITY,i:q.INCLINATION,raan:q.RA_OF_ASC_NODE,argp:q.ARG_OF_PERICENTER,ma:q.MEAN_ANOMALY,bterm:0,agom:0,norad:95000+i,name:`SYNTHETIC-${i}`,tesseral:31,zonal:20})};});
// First build all sets on the caller: thread initialization and set allocation
// cannot be mistaken for the specific derivative-row refusal being measured.
const m=await coefficientHarness(file,all,4),epoch=all[0].epochMs;
for(let i=0;i<all.length;i++)assert.equal(m.state((epoch-all[i].epochMs)/1000,i)[0],0);
const x=m.x,h=m.h,out=x.sdnap_alloc(48*N),status=x.sdnap_alloc(4*N),refs=[];
for(let i=N;i<2*N;i++)refs.push(m.state(3600+(epoch-all[i].epochMs)/1000,i));
function batch(first,t){const ms=epoch+t*1000,d=Math.floor(ms/86400000);assert.equal(x.sdnap_epochs_at(d+2440587.5,(ms-d*86400000)/86400000,first,N,0,out,status,0),0);const v=new Float64Array(h.memory.buffer,out,6*N),s=new Int32Array(h.memory.buffer,status,N);return Array.from({length:N},(_,i)=>[s[i],...Array.from({length:6},(_,k)=>v[k*N+i])]);}
for(let i=0;i<8;i++)batch(0,600+i*60);
x.sdnap_test_fail_derivatives(1);
const got=batch(N,3600);assert.deepEqual(got,refs);
const failures=x.sdnap_test_derivative_failures(),transitions=x.sdnap_test_u_transitions(),retries=x.sdnap_test_retries();
assert(failures>0);assert(transitions>0);assert(retries>0);
// Failure on the calling thread has the same rounded coefficient values.
x.sdnap_test_fail_derivatives(2);for(let i=N;i<2*N;i++)assert.deepEqual(m.state(3600+(epoch-all[i].epochMs)/1000,i),refs[i-N]);
console.log(JSON.stringify({states:2*N,failures,transitions,retries}));await m.close();process.exit(0);

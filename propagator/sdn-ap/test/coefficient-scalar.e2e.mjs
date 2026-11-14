#!/usr/bin/env node
// Synthetic AP elements at UTC JD 2461206.5; direct output at displaced mean
// elements, TEME km and km/s. Scalar and SIMD coefficient forms must stay within
// 2 cm (the measured first-order class envelope), including derivative output.
import assert from 'node:assert/strict';
import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {buildDiagnostic} from './lib/ap-diagnostic.mjs';
const extra=String.raw`
SDNAP_EXPORT("sdnap_test_scalar") int sdnap_test_scalar(int c,double dn,int derivative,double* out){
 using namespace sdnap;using namespace sdnap::xpt;
 tess::active()=tess::Terms{31,20,false,false};Elements e{};
 e.epoch_jd_whole=2461206.5;e.xincl=.9;e.xnodeo=.7;e.omegao=1.2;e.xmo=.3;e.bterm=.001;
 e.eo=c==0?.001:.1;double hp=c==1?200:500;e.xno=kKe/std::pow((1+hp/kRe)/(1-e.eo),1.5);
 auto* s=new XpSat{};int rc=xp_init(e,*s);out[18]=s->ctx.continuity_form;
 if(rc==0){double y[6];std::copy(s->epoch.y,s->epoch.y+6,y);y[kN]*=1+dn;tess::g_sp_anchor.valid=false;
  rc=derivative?output_impl<true>(s->ctx,120,y,out,out+3,nullptr,nullptr,nullptr,out+6,out+12)
               :output_impl<false>(s->ctx,120,y,out,out+3,nullptr);}
 xp_release(*s);delete s;return rc;
}
`;
const normal=buildDiagnostic('coefficient-scalar-control',extra);
const scalar=buildDiagnostic('coefficient-scalar',extra,s=>s,{'tesseral.inc':s=>s.replaceAll('#include "coefficient_evaluation.inc"','#undef __wasm_simd128__\n#include "coefficient_evaluation.inc"\n#define __wasm_simd128__ 1')});
let worst=0;
for(let c=0;c<3;c++)for(const dn of [-.00003,-.00001,0,.00001,.00003])for(const derivative of [0,1]){
 const rows=[];
 for(const file of [normal,scalar]){
  const h=await createStandaloneHarness('browser',file,{surface:'direct',maxThreads:1,enableBrowserWasiThreads:false});const x=h.instance.exports,p=x.sdnap_alloc(19*8);
  assert.equal(x.sdnap_test_scalar(c,dn,derivative,p),0);const v=Array.from(new Float64Array(h.memory.buffer,p,19));assert(v.every(Number.isFinite));rows.push(v);await h.close?.();
 }
 const positionM=1000*Math.hypot(...rows[0].slice(0,3).map((v,k)=>v-rows[1][k]));worst=Math.max(worst,positionM);
 console.log(JSON.stringify({c,dn,derivative,form:rows[0][18],positionM}));
}
console.log(JSON.stringify({worstPositionM:worst}));assert(worst<=.02,'scalar coefficients omit the selected correction');process.exit(0);

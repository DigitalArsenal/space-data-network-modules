#!/usr/bin/env node
// Init-domain and selection controls; synthetic elements, radians and rad/min,
// UTC JD 2461206.5. Integer statuses/forms and call counts compare exactly.
// SDNAP_CONTINUITY_RULE is a compile-time diagnostic, absent from release inputs.
import assert from 'node:assert/strict';
import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {buildDiagnostic} from './lib/ap-diagnostic.mjs';
const exports=String.raw`
SDNAP_EXPORT("sdnap_test_selector") void sdnap_test_selector(int bad,int ap,double* out){
 using namespace sdnap;using namespace sdnap::xpt;
 Elements e{};e.epoch_jd_whole=2461206.5;e.eo=.001;e.xincl=.9;e.xno=kKe/std::pow((1+500/kRe)/(1-e.eo),1.5);e.bterm=.001;
 if(bad==1)e.xno=NAN;if(bad==2)e.eo=NAN;if(bad==3)e.bterm=NAN;
 tess::active()=ap?tess::Terms{31,20,false,false}:tess::Terms{};
 auto* s=new XpSat{};tess::g_selector_calls=0;out[0]=xp_init(e,*s);out[1]=tess::g_selector_calls;out[2]=s->ctx.continuity_form;
 // A changed ambient selection cannot change the stored form during flight.
 tess::active()=tess::Terms{};double r[3],v[3];out[3]=out[0]==0?xp_propagate(*s,0,r,v,nullptr):-1;out[4]=s->ctx.continuity_form;
 xp_release(*s);delete s;
}
`;
const file=buildDiagnostic('coefficient-selector',exports,s=>s,{'tesseral.inc':s=>s.replace('inline uint8_t continuity_form(double n, double e, double bterm, bool ap) {','inline int g_selector_calls=0;\ninline uint8_t continuity_form(double n, double e, double bterm, bool ap) {\n  ++g_selector_calls;')});
const h=await createStandaloneHarness('browser',file,{surface:'direct',maxThreads:1,enableBrowserWasiThreads:false});const x=h.instance.exports,p=x.sdnap_alloc(40);
for(const ap of [0,1])for(const bad of [0,1,2,3]){
 x.sdnap_test_selector(bad,ap,p);const [status,calls,form,flight,stored]=Array.from(new Float64Array(h.memory.buffer,p,5));
 console.log(JSON.stringify({ap,bad,status,calls,form,flight,stored}));
 if(bad===1||bad===2){assert.notEqual(status,0);assert.equal(calls,0);}
 else if(bad===0){assert.equal(status,0);assert.equal(calls,1);assert.equal(form,ap?3:0);assert.equal(flight,0);assert.equal(stored,form);}
 else {assert.equal(status,0);assert.equal(calls,1);assert.equal(form,ap?3:0);assert.equal(stored,form);assert.equal(flight,0);}
}
await h.close?.();process.exit(0);

// Epoch covariance-bank set 0 uses TableShareScope, not CovBankScope. Its
// tables can have one identity with two coefficient forms near a threshold.
// Source: synthetic pairs at UTC JD 2461206.5; TEME km and km/s, zero-bit
// cache-order tolerance. Removing only a form freshness check is the control.
import assert from 'node:assert/strict';
import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {buildDiagnostic} from './lib/ap-diagnostic.mjs';
import {sigmaProbe} from './lib/coefficient-sigma.mjs';
const replace=(s,a,b)=>{assert(s.includes(a),a);return s.replace(a,b);};
let probe=replace(sigmaProbe,'CovBankScope bank(&sats[0]);','TableShareScope bank(&sats[0]);');
probe=replace(probe,' out[4]=sats[1].ctx.shared_mask;',` out[6]=md_table_id(sats[0].ctx)==md_table_id(sats[1].ctx);
 out[7]=sp_table_id(sats[0].ctx)==sp_table_id(sats[1].ctx);
 out[4]=sats[1].ctx.shared_mask;`);
const transforms={'sdn_ap_module.cpp':s=>replace(s,'#include "abi.inc"',probe+'\n#include "abi.inc"')};
const omit=process.env.SDNAP_OMIT_FORM_KEY;
if(omit)transforms['coefficient_evaluation.inc']=s=>{
 const names=omit==='both'?['mc','sc']:[omit];
 for(const n of names){const a=`${n}.coefficient_form != SDNAP_COEFFICIENT_FORM || `;assert(s.includes(a));s=s.replaceAll(a,'');}return s;
};
const file=process.env.SDNAP_FORM_KEYS_WASM??buildDiagnostic('coefficient-form-keys',String.raw`
SDNAP_EXPORT("sdnap_test_form_keys") int sdnap_test_form_keys(int c,int warm,double* out){
 sdnap::pool::test_case=c+6;sdnap::pool::test_order=2;sdnap::pool::test_warm=warm;
 sdnap::pool::coefficient_sigma_case(out);return 0;
}`,s=>s,transforms);
let comparisons=0,differences=0,distinct=0;
for(let c=0;c<6;c++){
 let reference;
 for(const warm of [0,1]){
  const h=await createStandaloneHarness('browser',file,{surface:'direct'}),x=h.instance.exports,p=x.sdnap_alloc(32*8);
  assert.equal(x.sdnap_test_form_keys(c,warm,p),0);
  const row=Array.from(new Float64Array(h.memory.buffer,p,32));
  assert.equal(row[0],0);assert.equal(row[1],0);assert.equal(row[6],1);assert.equal(row[7],1);
  if(row[2]!==row[3])distinct++;
  const states=[0,1,2].flatMap(k=>row.slice(8+k*8,15+k*8));
  for(let k=0;k<3;k++)assert.equal(states[7*k],0);
  reference??=states;comparisons++;if(!states.every((v,i)=>Object.is(v,reference[i])))differences++;
  console.log(JSON.stringify({threshold:c,warm,forms:row.slice(2,4),sameTableIds:row.slice(6,8),differences}));await h.destroy?.();
 }
}
console.log(JSON.stringify({file,comparisons,distinct,differences,omitted:omit??null}));
assert.equal(distinct,12);assert.equal(differences,0,'form freshness checks must isolate shared tables');process.exit(0);

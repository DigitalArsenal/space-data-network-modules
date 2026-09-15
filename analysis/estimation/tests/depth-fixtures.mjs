import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createBrowserModuleHarness} from 'space-data-module-sdk/testing/browser';
import {encode,decode,unpack,pack,typeRef} from './wire.mjs';
import {correlated} from './fixtures.mjs';
const base=decode(correlated.inputs[0].payload).request;
const sample=decode(correlated.inputs[1].payload).propagator_samples[0];
const diagonal=Array(36).fill(0);for(let i=0;i<6;i++)diagonal[7*i]=1;
const config={...base.config,initial_covariance:diagonal,sigma_edit_threshold:1e9};
const observation={...base.observations[0],flags:3};
function request(value,samples=[sample]) {return {methodId:'run_estimation',inputs:[{portId:'request',typeRef,payload:encode({request:value})},{portId:'propagator_samples',typeRef,payload:encode({propagator_samples:samples})}]};}
const pv={observation:{...observation,kind:'POSITION_VELOCITY',value_count:6},values:[2,4,6,8,10,12],sigmas:[1,1,1,1,1,1]};
export const linear=request({...base,config:{...config,estimator:'LINEAR_KALMAN_FILTER'},observations:[],extended_observations:[pv],options:{}});
const clockP=Array(64).fill(0);for(let i=0;i<8;i++)clockP[9*i]=1;
export const clock=request({...base,config,observations:[],options:{estimate_clock:true,initial_covariance8:clockP,initial_clock_bias_m:100,initial_clock_drift_mps:2,smooth:true},extended_observations:[{observation:{...observation,epoch:{...observation.epoch,seconds:10},kind:'PSEUDORANGE',value_count:1,station_position_m:[-20000000,0,0]},values:[20000113],sigmas:[1],satellite_clock_bias_m:7}]},[{...sample,epoch:{...sample.epoch,seconds:10}}]);
export const inflated=request({...base,config:{...config,sigma_edit_threshold:3},observations:[],options:{inflate_measurement_noise:true},extended_observations:[{...pv,values:[10,0,0,0,0,0]}]});
const qConfig={...config,estimator:'LINEAR_KALMAN_FILTER',process_noise:'STATE_NOISE_COMPENSATION',process_noise_spectral_density:[3,0,0,0,0,0]};
const qObs=[1,2].map(t=>({observation:{...observation,epoch:{...observation.epoch,seconds:t},kind:'LINEAR',value_count:1},values:[3],sigmas:[1],linear_matrix:[1,0,0,0,0,0],linear_offset:[0]}));
const qSamples=[1,2].map(t=>{const stm=[...sample.stm];stm[3]=t;return {...sample,epoch:{...sample.epoch,seconds:t},stm};});
export const adaptiveQ=request({...base,config:qConfig,observations:[],options:{adaptive_process_noise:true,adaptation_rate:.25},extended_observations:qObs},qSamples);
export const staticDepthCases=[{id:'linear-six-lane-pv',request:linear},{id:'gnss-eight-state-clock',request:clock},{id:'adaptive-measurement-inflation',request:inflated},{id:'adaptive-process-scaling',request:adaptiveQ}];

export async function nonlinearCases() {
 const wasm=fs.readFileSync(new URL('../dist/isomorphic/module.wasm',import.meta.url));
 const providerBytes=fs.readFileSync(new URL('./.generated/provider/dist/isomorphic/module.wasm',import.meta.url));
 const estimator=await createBrowserModuleHarness({wasmSource:wasm,surface:'direct'});
 const provider=await createBrowserModuleHarness({wasmSource:providerBytes,surface:'direct'});
 const rows=fs.readFileSync(new URL('./fixtures/orekit-pv-reference.txt',import.meta.url),'utf8').trim().split('\n').map(l=>l.split(/\s+/).map(Number));
 const cases=[];
 try {
  for(const kind of [1,2]) {
   const reference=rows.filter(r=>r[0]===kind);
   const p=[...diagonal];for(let i=0;i<6;i++)p[7*i]=i<3?10000:.01;
   const invoke=request({...base,config:{...config,estimator:kind,initial_state:[7000100,-80,60,.1,7499.92,1000.05],initial_covariance:p},observations:[],options:{nonlinear_propagation:true,smooth:true,ukf_alpha:1,ukf_beta:2,ukf_kappa:0},extended_observations:reference.map(r=>({...pv,observation:{...pv.observation,epoch:{...observation.epoch,seconds:r[1]}},values:r.slice(2,8),sigmas:[10,10,10,.01,.01,.01]}))},[]);
   const envelope=unpack(invoke.inputs[0].payload);
   let rounds=0,answerCount=0;
   for(;;) {
    const current={...invoke,inputs:[{...invoke.inputs[0],payload:pack(envelope)},invoke.inputs[1]]};
    const response=await estimator.invoke(current);assert.equal(response.statusCode,0,response.errorMessage);
    const bytes=response.outputs.find(o=>o.portId==='result').payload;
    const out=unpack(bytes).result;
    if(out.status===1) {
     if(rounds===0 || (kind===2 && rounds===5))cases.push({id:`nonlinear-kind-${kind}-query-${rounds}`,request:current});
     assert.equal(out.propagationRequests.length,kind===2?13:1);
     const propagated=await provider.invoke({methodId:'test_propagate',inputs:[{portId:'request',typeRef,payload:bytes}]});assert.equal(propagated.statusCode,0,propagated.errorMessage);
     const answers=unpack(propagated.outputs[0].payload).propagationAnswers;
     envelope.propagationAnswers.push(...answers);answerCount+=answers.length;
     assert.ok(++rounds<=10,'continuation does not converge');
    } else {
     assert.equal(out.status,0);assert.equal(out.filterHistory.length,10);
     let position=0,velocity=0,covariance=0;
     reference.forEach((r,i)=>{const e=out.filterHistory[i];for(let j=0;j<6;j++){const error=Math.abs(e.filteredState[j]-r[8+j]);if(j<3)position=Math.max(position,error);else velocity=Math.max(velocity,error);}for(let j=0;j<36;j++)covariance=Math.max(covariance,Math.abs(e.filteredCovariance[j]-r[14+j]));});
     assert.ok(position<1e-6 && velocity<1e-8 && covariance<1e-6,JSON.stringify({position,velocity,covariance}));
     console.log(`PASS WASM Orekit kind=${kind} position_max_m=${position} velocity_max_mps=${velocity} covariance_max_SI=${covariance} rounds=${rounds} provider_samples=${answerCount}`);
     cases.push({id:`nonlinear-kind-${kind}-complete`,request:current});
     // A stale seed must fail explicitly, not silently use the wrong cloud.
     envelope.propagationAnswers[0].query.seed.state[0]+=1;
     const stale={...current,inputs:[{...invoke.inputs[0],payload:pack(envelope)},invoke.inputs[1]]};
     assert.notEqual((await estimator.invoke(stale)).statusCode,0);
     if(kind===2)cases.push({id:'nonlinear-stale-seed-rejection',request:stale});
     break;
    }
   }
  }
 } finally {estimator.destroy?.();estimator.dispose?.();provider.destroy?.();provider.dispose?.();}
 return cases;
}

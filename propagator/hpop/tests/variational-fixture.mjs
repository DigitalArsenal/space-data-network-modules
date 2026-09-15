// Invoke orchestration only; oracle numbers are independently generated C++
// Kepler solutions, not propagation outputs from the implementation under test.
import fs from 'node:fs';
import { hexRequestFor } from './lib/prwCodec.mjs';
export const reference=JSON.parse(fs.readFileSync(new URL('./variational-kepler-reference.json',import.meta.url)));
export const controls={method:'RKF78',initialStep:20,minStep:0.001,maxStep:20,absTolerance:1e-14,relTolerance:1e-14};
export const oracleParams=c=>({epochJD:reference.epoch_jd,targetJD:c.target_jd??reference.epoch_jd+c.duration_s/86400,
  position:c.initial_state.slice(0,3),velocity:c.initial_state.slice(3),
  forces:{gravityMode:'POINT_MASS',j2:false,mu:reference.mu_km3_s2},integrator:controls,includeSTM:true});
const kernel=fs.readFileSync(new URL('../../../files/orbit-products/tests/fixtures/de440/de440-2026.bsp',import.meta.url));
export const request=(params,withKernel=false)=>hexRequestFor('propagate',params,withKernel?kernel:undefined);
export const rich={epochJD:2461041.5,targetJD:2461041.5+600/86400,position:[6778,80,60],velocity:[-0.1,7.5,1],
  includeSTM:true,integrator:{...controls,absTolerance:1e-12,relTolerance:1e-12},
  forces:{gravityMode:'J2',thirdBody:true,srp:true,drag:true,dragModel:'NRLMSISE00'},DENSITY_GRADIENT:'FINITE_DIFFERENCE'};
export const burnParams={...oracleParams(reference.cases[0]),targetJD:2451545+600/86400,
  maneuvers:[{epochJD:2451545+300/86400,deltaV:[0.0001,0.001,-0.0002],frame:'RTN'}]};
export const cases=[
  ...reference.cases.map(c=>({id:c.name,request:request(oracleParams(c))})),
  {id:'J2-finite-difference',request:request({...rich,STM_METHOD:'FINITE_DIFFERENCE',forces:{gravityMode:'J2'}})},
  {id:'DE440-drag-SRP',request:request(rich,true)},
  {id:'RTN-impulse',request:request(burnParams)},
  {id:'exhausted-steps',request:request({...oracleParams(reference.cases[0]),integrator:{...controls,maxSteps:1}})},
  {id:'unsupported-analytic-integrator',request:request({...oracleParams(reference.cases[0]),integrator:{...controls,method:'BS'}})},
  {id:'invalid-STM-method',request:request({...oracleParams(reference.cases[0]),STM_METHOD:'INVALID'})},
];

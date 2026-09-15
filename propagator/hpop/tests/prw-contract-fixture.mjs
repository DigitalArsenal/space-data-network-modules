// Computable wire outcomes: SDS 1.220.0 schema/{PRW,FRM,TIM,PCE}/main.fbs.
// These cases test verification/classification, not new numerical goldens.
import { TYPE, makeTable, encodePrw, execution, requestFor } from './lib/prwCodec.mjs';

export const identityParams={epochJD:2451545,targetJD:2451545,
  position:[7000,100,-50],velocity:[1,7,.4],includeSTM:true,
  forces:{centralBody:false,j2:false,thirdBody:false,srp:false,drag:false},
  integrator:{method:'RKF78',initialStep:17,minStep:1e-6,maxStep:17,absTolerance:2e-13,relTolerance:2e-13}};
const req=payload=>({methodId:'invoke',inputs:[{portId:'request',typeRef:TYPE,payloadHex:Buffer.from(payload).toString('hex')}]});
const changed=change=>{const e=execution(identityParams);change(e);return encodePrw('EXECUTION_REQUEST',e);};
const version=encodePrw('VERSION_QUERY',true);
export const invalidCases=[
  {id:'empty-prw',request:req(encodePrw(makeTable('PRW')))},
  {id:'two-prw-arms',request:req(encodePrw(makeTable('PRW',{VERSION_QUERY:true,EXECUTION_REQUEST:execution(identityParams)})))},
  {id:'truncated-prw',request:req(version.slice(0,13))},
  {id:'legacy-json-rejected',request:req(Buffer.from('{"operation":"version"}'))},
  {id:'request-arm-is-result',request:req(encodePrw('VERSION_RESULT',makeTable('PRWVersionResult',{VERSION:'1.0.0',MODULE_ID:'com.orbpro.hpop'})))},
  {id:'unknown-stm-enum',request:req(changed(e=>e.STM_TECHNIQUE=255))},
  {id:'unknown-integrator-enum',request:req(changed(e=>e.INTEGRATOR.ALGORITHM=255))},
  {id:'nonuniform-absolute-tolerance',request:req(changed(e=>e.INTEGRATOR.ABSOLUTE_TOLERANCES[2]*=2))},
  {id:'unknown-frame',request:req(changed(e=>{e.INITIAL.STATE.COORDINATE_SYSTEM_NAME='ECI';e.INITIAL.COORDINATE_SYSTEM.NAME='ECI';e.INITIAL.COORDINATE_SYSTEM.AXIS_TYPE=255;}))},
  {id:'nonfinite-state',request:req(changed(e=>e.INITIAL.STATE.POSITION.X=NaN))},
  {id:'invalid-state',request:req(changed(e=>e.INITIAL.VALID=false))},
  {id:'negative-covariance',request:req(changed(e=>{e.INITIAL_COVARIANCE=makeTable('PRWStateMatrix',{DIMENSION:6,VALUES:Array(36).fill(0)});e.INITIAL_COVARIANCE.VALUES[0]=-1;}))},
  {id:'asymmetric-covariance',request:req(changed(e=>{const p=Array(36).fill(0);p[0]=p[7]=1;p[1]=.5;e.INITIAL_COVARIANCE=makeTable('PRWStateMatrix',{DIMENSION:6,VALUES:p});}))},
  {id:'duplicate-covariance',request:req(changed(e=>{e.INITIAL_COVARIANCE=makeTable('PRWStateMatrix',{DIMENSION:6,VALUES:Array(36).fill(0)});e.INITIAL.COVARIANCE=e.INITIAL_COVARIANCE;}))},
];
export const cases=[
  {id:'empty-stdin',stdinUtf8:''},
  {id:'malformed-stdin',stdinUtf8:'not a PIV frame'},
  {id:'truncated-piv-header',stdinHex:'24504956'},
  ...invalidCases,
  {id:'valid-after-errors',request:{methodId:'invoke',inputs:[{portId:'request',typeRef:TYPE,payloadHex:Buffer.from(version).toString('hex')}]}}
];
export const identityRequest=()=>requestFor('propagate',identityParams);

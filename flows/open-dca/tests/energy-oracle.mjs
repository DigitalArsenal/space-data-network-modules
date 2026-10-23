// Independent E13 energy-arc orchestration: execute the frozen reference's
// estimator verbatim, with typed adapters to the unchanged energy/FFM/frames
// methods. No orbit, frame, time, density or energy arithmetic is implemented
// here. RTN covariance and estimator statistics are the frozen E13 source.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {modules,load,S,Builder,ByteBuffer,input} from './inputs.mjs';
export const table=(name,value)=>Object.assign(new S[`${name}T`](),value);
export function dclFrame(value,port='request'){const b=new Builder(1024);S.DCL.finishDCLBuffer(b,value.pack(b));return input(port,b.asUint8Array().slice(),'DCL.fbs','$DCL','DCL');}
export const decodeDcl=f=>S.DCL.getRootAsDCL(new ByteBuffer(f.payload)).unpack();
export async function energyOracle(inputs){
 const reference=process.env.OPEN_DCA_ORACLE;assert(reference,'OPEN_DCA_ORACLE is required');
 const frozen=await fs.readFile(path.join(reference,'experiments/e13-open-dca/arcs.mjs'),'utf8');
 const {executionFrame,decodeSamples}=await import(pathToFileURL(path.join(reference,'experiments/e13-open-dca/vendor/full-force.mjs')));
 const {rtnAxes}=await import(pathToFileURL(path.join(reference,'experiments/e13-open-dca/vendor/frames.mjs')));
 assert(process.env.OPEN_DCA_REFERENCE_ARTIFACTS,'Set OPEN_DCA_REFERENCE_ARTIFACTS to rebuilt current-main foundation artifacts');
 const frames=await load('foundation/frames',path.join(process.env.OPEN_DCA_REFERENCE_ARTIFACTS,'foundation/frames/dist/isomorphic/module.wasm'));
 const density=await load('analysis/density-calibration'),ffm=await load('propagator/ffm');
 const isoUs=ms=>new Date(ms).toISOString().replace(/\.(\d{3})Z$/,'.$1000');
 const environment=inputs.filter(f=>f.portId!=='request');
 async function propagate(a,tbMs,b0,cr){
  const r=await ffm.call('invoke',[executionFrame({epoch:isoUs(a.ms),state:a.state,samples:[isoUs(tbMs)],forces:{degree:24,order:24,thirdBodies:[10,301],srp:true,solidTides:true,drag:true,atmosphere:'NRLMSISE00'},coefficients:{b:b0,agom:cr,inTrack:0},parameters:[{kind:'DRAG_AREA_OVER_MASS'}],stm:true,integrator:{tolerance:1e-11,maxStep:75}}),...environment]);
  const s=decodeSamples(r)[0],n=s.n;
  return {state:s.state,phi:Array.from({length:6},(_,i)=>Array.from({length:6},(_,j)=>s.stm[i*n+j])),sens:Array.from({length:6},(_,i)=>s.stm[i*n+6]),steps:s.steps};
 }
 async function energyOf(list){
  const request=table('DCL',{GRAVITY_DEGREE:36,GM_M3_S2:3.986004418e14,SETTINGS:table('dclSettings',{WANT_GRADIENT:true}),STATES:table('dclStates',{EPHEMERIS:table('ephemerisDataBlock',{EPHEMERIS_DATA_LINES:list.map(s=>table('ephemerisDataLine',{EPOCH:isoUs(s.ms),X:s.state[0]/1000,Y:s.state[1]/1000,Z:s.state[2]/1000,X_DOT:s.state[3]/1000,Y_DOT:s.state[4]/1000,Z_DOT:s.state[5]/1000}))})})});
  const out=decodeDcl((await density.call('energy',[dclFrame(request)])).outputs[0]).STATES;
  assert.equal(out.REFUSED.length,0);
  return list.map((_,i)=>({energy:out.ENERGY_J_KG[i],gradient:out.ENERGY_GRADIENT.slice(i*6,i*6+6),geodetic:{altKm:out.ALTITUDE_KM[i]}}));
 }
 const linear=frozen.slice(frozen.indexOf('const zeros ='),frozen.indexOf('// atmosphere:'));
 const estimator=frozen.slice(frozen.indexOf('  async function stateCovariance'),frozen.indexOf('  // The 6-D least squares'));
 assert(linear.includes('const blockRot'));assert(estimator.includes('async function energyArc'));
 const create=new Function('modules','rtnAxes','isoUs','propagate','energyOf',linear+'\n'+estimator+'\nreturn energyArc;');
 const energyArc=create({'foundation/frames':{invoke:(m,f)=>frames.call(m,f)}},rtnAxes,isoUs,propagate,energyOf);
 return {energyArc,destroy:async()=>{for(const m of [frames,density,ffm])await m.destroy();}};
}

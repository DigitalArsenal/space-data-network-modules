// Mixed forms on the actual epoch pool. Reference: each set alone, same build,
// TEME km and km/s, exact state/status bytes at the same UTC times.
import assert from 'node:assert/strict';
import {records} from './coefficient-forms.mjs';
import {repackOcm,ocmOf,seedOcm} from './ocm.mjs';
import {coefficientHarness} from './coefficient-harness.mjs';
export async function mixedForms(file){
 const epochMs=Date.parse('2026-06-15T00:00:00Z');
 const all=Array.from({length:68},(_,i)=>{const m=ocmOf(records()[i%17].bytes).MEAN_ELEMENTS;return {epochMs,bytes:seedOcm({epoch:'2026-06-15T00:00:00',n:m.MEAN_MOTION,e:m.ECCENTRICITY,i:m.INCLINATION,raan:m.RA_OF_ASC_NODE,argp:m.ARG_OF_PERICENTER,ma:m.MEAN_ANOMALY,bterm:m.BTERM,agom:m.AGOM,norad:90000+i,name:`SYNTHETIC-${i}`,tesseral:31,zonal:20})};});
 const times=[-3600,0,1,3600,21600,86400],epoch=all[0].epochMs,refs=[];
 for(const r of all){const m=await coefficientHarness(file,[r]);refs.push(times.map(t=>m.state(t+(epoch-r.epochMs)/1000)));await m.close();}
 let comparisons=0;
 for(const order of [[0,1,2,3,4,5],[5,4,3,2,1,0],[2,5,0,4,1,3]]){
  const m=await coefficientHarness(file,all,4);
  for(const k of order){const rows=m.batch(epoch+times[k]*1000);for(let i=0;i<rows.length;i++){assert.deepEqual(rows[i],refs[i][k],`mixed form ${i%17}, order ${order}, time ${k}`);comparisons++;}}
  await m.close();
 }
 console.log(JSON.stringify({mixedFormsComparisons:comparisons,threads:4,orders:3}));
}

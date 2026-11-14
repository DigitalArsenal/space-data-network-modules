// Mixed forms on the actual epoch pool. Reference: each set alone, same build,
// TEME km and km/s, exact state/status bytes at the same UTC times.
import assert from 'node:assert/strict';
import {records} from './coefficient-forms.mjs';
import {repackOcm} from './ocm.mjs';
import {coefficientHarness} from './coefficient-harness.mjs';
export async function mixedForms(file){
 const all=Array.from({length:68},(_,i)=>{const r=records()[i%17];return {...r,bytes:repackOcm(r.bytes,t=>{t.METADATA.NORAD_CAT_ID=90000+i;t.METADATA.OBJECT_NAME=`SYNTHETIC-${i}`;t.COVARIANCE_DATA=[];t.COV_SIZE=0;})};});
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

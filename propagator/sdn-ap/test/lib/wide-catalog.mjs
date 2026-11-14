// Synthetic regression inputs. TEME, km and km/s, UTC; exact comparisons test
// storage and scheduling identity, with an independently built release as control.
import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {seedOcm,rowsThrough,repackOcm,T,ocmOf} from './ocm.mjs';
import {configuration} from './pcf.mjs';
import {pcfOutputFrame} from 'spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js';
export {repackOcm,ocmOf};
export const epoch=Date.parse('2026-06-15T00:00:00Z');
export const jd=days=>[2461206.5,days];
export const prefix=b=>{const p=Buffer.alloc(b.length+4);p.writeUInt32LE(b.length);p.set(b,4);return p;};
const rows=rowsThrough(Array.from({length:10},(_,k)=>({DATE:new Date(epoch+(k-2)*86400000).toISOString().slice(0,10),F107_OBS:100,F107_OBS_CENTER81:100,AP_AVG:4})));
export function records(count){return Array.from({length:count},(_,k)=>{
 const wide=k%10===0,transfer=wide&&k%20===0;
 return seedOcm({epoch:'2026-06-15T00:00:00.000',n:(transfer?2.26:14.8)*(1+k*1e-7),e:(transfer?.65:wide?.052:.001)+k*1e-8,i:15+(k*37%13000)/100,raan:40,argp:90,ma:(k*13)%360,norad:900000+k,msis:true,records:true,rows,bterm:.0001,agom:.001,tesseral:12,zonal:6});
});}
export function order(count,kind){const a=Array.from({length:count},(_,i)=>i);if(kind==='descending')a.reverse();if(kind==='shuffled'){let s=17091;for(let i=count-1;i>0;--i){s=(Math.imul(s,1664525)+1013904223)>>>0;const j=s%(i+1);[a[i],a[j]]=[a[j],a[i]];}}return a;}
export async function open(file,threads=0,count=1){
 const h=await createStandaloneHarness('browser',file,{surface:'direct',maxThreads:threads+1,enableBrowserWasiThreads:threads>0}),x=h.instance.exports;
 if(threads&&x.sdnap_threads(threads)!==threads)throw Error('pool start');
 const p=x.sdnap_alloc(48*count),s=x.sdnap_alloc(4*count),q=x.sdnap_alloc(1024);
 return {h,x,p,s,q,async load(rs){const r=await h.invoke({methodId:'load_epochs',inputs:[{portId:'ocm',typeRef:T('OCM'),payload:Buffer.concat(rs.map(prefix))}]});if(r.statusCode)throw Error(r.errorCode);},one(k=0,days=1){const rc=x.sdnap_epochs_set_at(k,0,...jd(days),p);return {rc,state:rc?null:Array.from(new Float64Array(h.memory.buffer,p,6))};},batch(days=1,cov=0){const rc=x.sdnap_epochs_at(...jd(days),0,count,0,p,s,cov);return {rc,status:Array.from(new Int32Array(h.memory.buffer,s,count)),values:Array.from(new Float64Array(h.memory.buffer,p,6*count))};},budget(bytes=0){const rc=x.sdnap_wide_grid_budget(bytes,q);return {rc,out:Array.from(new Float64Array(h.memory.buffer,q,4))};},async frame(rs,days=1){return h.invoke({methodId:'propagate_epochs',inputs:[{portId:'ocm',typeRef:T('OCM'),payload:Buffer.concat(rs.map(prefix))},configuration({output:{EPOCHS:[new Date(epoch+days*86400000).toISOString().slice(0,-1)],FRAME:pcfOutputFrame.TEME,MAXIMUM_STATES:rs.length+1}})]});},async close(){await h.destroy();}};
}

import assert from 'node:assert/strict';
import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {T} from './ocm.mjs';
export const prefix=b=>{const p=Buffer.alloc(b.length+4);p.writeUInt32LE(b.length);p.set(b,4);return p;};
export async function coefficientHarness(file,records,threads=1){
 const h=await createStandaloneHarness('browser',file,{surface:'direct',maxThreads:threads,enableBrowserWasiThreads:threads>1});
 const x=h.instance.exports,n=records.length,out=x.sdnap_alloc(n*48),status=x.sdnap_alloc(n*4);
 if(threads>1)assert.equal(x.sdnap_threads(threads),threads);
 const loaded=await h.invoke({methodId:'load_epochs',inputs:[{portId:'ocm',typeRef:T('OCM'),payload:Buffer.concat(records.map(r=>prefix(r.bytes)))}]});
 assert.equal(loaded.statusCode,0);assert.equal(x.sdnap_epochs_count(),n,'every synthetic series retained');
 const date=ms=>{const d=Math.floor(ms/86400000);return [d+2440587.5,(ms-d*86400000)/86400000];};
 return {x,h,close:()=>h.close?.(),state(t,i=0){const [w,f]=date(records[i].epochMs+t*1000),rc=x.sdnap_epochs_set_at(i,0,w,f,out);return [rc,...Array.from(new Float64Array(h.memory.buffer,out,6))];},batch(ms){const [w,f]=date(ms);assert.equal(x.sdnap_epochs_at(w,f,0,n,0,out,status,0),0);const v=new Float64Array(h.memory.buffer,out,n*6),s=new Int32Array(h.memory.buffer,status,n);return Array.from({length:n},(_,i)=>[s[i],...Array.from({length:6},(_,k)=>v[k*n+i])]);}};
}
export const positionM=(a,b)=>1000*Math.hypot(...a.slice(1,4).map((v,k)=>v-b[k+1]));

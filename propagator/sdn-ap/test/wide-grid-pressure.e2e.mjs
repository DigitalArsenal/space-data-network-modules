// Bounded residency and retry, including schedule-node blending and covariance.
// Synthetic TEME states (km, km/s) at UTC day two; comparison is bit equality
// against isolated release states. Covariance entries use km and km/s products.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {buildDiagnostic} from './lib/ap-diagnostic.mjs';
import {records,open,repackOcm,ocmOf} from './lib/wide-catalog.mjs';
const file=buildDiagnostic('wide-grid-pressure',`
static sdnap::xpt::tess::WideGrid* held_grids[34]{};
SDNAP_EXPORT("sdnap_test_grid_min") double sdnap_test_grid_min(){return sdnap::xpt::tess::kGridMinimumBytes;}
SDNAP_EXPORT("sdnap_test_hold_grids") int sdnap_test_hold_grids(int count){
 using namespace sdnap::xpt::tess;
 for(auto& g:held_grids)if(g){grid_unpin(g);wide_grid_drop(g);g=nullptr;}
 for(int i=0;i<count;++i){auto* g=wide_grid_acquire(12,0,.06+i*.00001,.06,.8);if(!g)return -1;
 if(!grid_pin(g)){wide_grid_drop(g);return -2;}held_grids[i]=g;}
 return 0;
}`);
const rs=records(400),days=2-.1/1440,reference=process.env.SDN_AP_REFERENCE_WASM||file;
const truth=[];for(const r of rs){const h=await open(reference);try{await h.load([r]);const v=h.one(0,days);assert.equal(v.rc,0);truth.push(v.state);}finally{await h.close();}}
const outcomes=[];
for(const threads of [0,3,14,16]){
 const h=await open(file,threads,400);try{const min=h.x.sdnap_test_grid_min();assert.equal(h.budget(min).rc,0);await h.load(rs);const v=h.batch(days);assert.equal(v.rc,0);assert.ok(v.status.every(x=>x===0));for(let k=0;k<400;k++)assert.deepEqual(Array.from({length:6},(_,z)=>v.values[z*400+k]),truth[k]);assert.ok(h.budget().out[1]<=min);outcomes.push({threads:threads+1,answered:400});}finally{await h.close();}
}
const h=await open(file);
try{
 const min=h.x.sdnap_test_grid_min();assert.equal(h.budget(min).rc,0);await h.load([rs[0]]);
 assert.equal(h.x.sdnap_test_hold_grids(34),0);assert.equal(h.one(0,days).rc,91);assert.deepEqual(h.batch(days).status,[91]);
 assert.equal(h.x.sdnap_test_hold_grids(0),0);assert.deepEqual(h.one(0,days),{rc:0,state:truth[0]});
}finally{await h.close();}
const template=ocmOf(fs.readFileSync(new URL('./fixtures/ap-fit-0.6.42.ocm',import.meta.url)));
const covariance=repackOcm(rs[10],t=>{for(const [k,v] of Object.entries(template))if(k.startsWith('COV'))t[k]=v;t.PROVENANCE=template.PROVENANCE;t.COV_SIZE=6;t.COV_PARAMETER_KINDS=[];t.COV_PARAMETERS=[];t.COV_REALISM=[];t.COV_UNITS=['km','km','km','km/s','km/s','km/s'];t.COVARIANCE_DATA=Array.from({length:21},(_,j)=>[0,2,5].includes(j)?1e-2:[9,14,20].includes(j)?1e-8:0);for(const k of Object.keys(t.COV_PROPAGATION))t.COV_PROPAGATION[k]=0;});
const cov=[];
for(const f of [reference,file]){const h=await open(f);try{if(h.x.sdnap_test_grid_min)h.budget(h.x.sdnap_test_grid_min());await h.load([covariance]);const p=h.x.sdnap_alloc(36*8),v=h.batch(days,p);assert.deepEqual(v.status,[0]);const values=Array.from(new Float64Array(h.h.memory.buffer,p,36));assert.ok(values.every(Number.isFinite));cov.push({values,state:v.values});}finally{await h.close();}}
assert.deepEqual(cov[1],cov[0]);
console.log(JSON.stringify({complete:true,outcomes,shortageRetry:true,covarianceIdentity:true}));

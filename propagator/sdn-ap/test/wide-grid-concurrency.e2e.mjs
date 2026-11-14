// Synthetic equal-key wide records at UTC epoch, TEME km and km/s. The serial
// committed release supplies exact states; probes observe ownership and builds.
import assert from 'node:assert/strict';
import {buildDiagnostic} from './lib/ap-diagnostic.mjs';
import {releaseReference} from './lib/release-reference.mjs';
import {records,open,repackOcm} from './lib/wide-catalog.mjs';
const file=buildDiagnostic('wide-grid-concurrency',`
bool sdnap::xpt::tess::sdnap_test_is_pool(){return sdnap::pool::g_pool_thread;}
SDNAP_EXPORT("sdnap_test_grid_ownership") void sdnap_test_grid_ownership(double* out){
 using namespace sdnap::xpt::tess;auto& c=grid_cache();cache_lock(&c.word);
 out[0]=out[1]=0;for(auto* head:c.bucket)for(auto* g=head;g;g=g->link){out[0]+=g->pins;out[1]+=g->building;}
 out[2]=test_pool_builds;out[3]=grid_counts()[2];cache_unlock(&c.word);
}
`,s=>s,{'wide_grid_cache.inc':s=>'bool sdnap_test_is_pool();\n'+s.replace('constexpr size_t kGridCacheBytes', 'inline int32_t test_pool_builds=0;\nconstexpr size_t kGridCacheBytes').replace('    WideGrid data{};', '    if(sdnap_test_is_pool())__atomic_add_fetch(&test_pool_builds,1,__ATOMIC_RELAXED);\n    WideGrid data{};')});
const rs=Array.from({length:128},(_,k)=>repackOcm(records(11)[10],o=>{o.METADATA.NORAD_CAT_ID=920000+k;o.MEAN_ELEMENTS.MEAN_ANOMALY=k;}));
const base=await open(releaseReference()),truth=[];
try{for(const r of rs){await base.load([r]);truth.push(base.one(0,0));assert.equal(truth.at(-1).rc,0);}}finally{await base.close();}
const h=await open(file,3,rs.length);
try{
 await h.load(rs);const result=h.batch(0);assert.ok(result.status.every(s=>s===0));
 for(let k=0;k<rs.length;k++)assert.deepEqual(Array.from({length:6},(_,j)=>result.values[j*rs.length+k]),truth[k].state);
 h.x.sdnap_test_grid_ownership(h.q);const v=Array.from(new Float64Array(h.h.memory.buffer,h.q,4));
 assert.equal(v[0],0,'pins after quiescence');assert.equal(v[1],0,'builds after quiescence');assert.ok(v[2]>0,'a wide payload was built on a pool thread');assert.equal(v[3],1,'one publication for the common exact key');
 await h.load(rs);assert.ok(h.batch(0).status.every(s=>s===0));h.x.sdnap_test_grid_ownership(h.q);assert.equal(new Float64Array(h.h.memory.buffer,h.q,4)[3],1,'reload reuses the same exact payload');
 console.log(JSON.stringify({complete:true,pins:v[0],building:v[1],poolBuilds:v[2],totalBuilds:v[3]}));
}finally{await h.close();}

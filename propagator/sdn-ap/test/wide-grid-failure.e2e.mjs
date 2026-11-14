// Allocation and retry regression on made-up AP sets. Isolated successful
// states are binary64 TEME km and km/s, UTC day one; tolerance is exact equality.
import assert from 'node:assert/strict';
import * as flatbuffers from 'flatbuffers';
import {flight} from './lib/ocm.mjs';
import {OEM} from 'spacedatastandards.org/lib/js/OEM/OEM.js';
import {buildDiagnostic} from './lib/ap-diagnostic.mjs';
import {records,open} from './lib/wide-catalog.mjs';
const inject=s=>s.replace('namespace mem {',`namespace mem {
inline int test_grid_depth=0,test_grid_at=0,test_grid_calls=0,test_comment_fail=0;
struct TestGridScope {TestGridScope(){++test_grid_depth;}~TestGridScope(){--test_grid_depth;}};
inline bool test_grid_fail(){return test_grid_depth && (++test_grid_calls == test_grid_at || test_grid_at < 0);}
`).replace('  void* p = std::malloc(n);','  if(test_grid_fail()){note_failure(n);return nullptr;}\n  void* p = std::malloc(n);')
.replace('  void* p = std::calloc(k, n);','  if(test_grid_fail()){note_failure(k*n);return nullptr;}\n  void* p = std::calloc(k, n);');
const scope=(s,name)=>{const re=new RegExp('(inline [^\\n]* '+name+'\\([^;{]*\\) \\{)');if(!re.test(s))throw Error(name);return s.replace(re,'$1\n  sdnap::mem::TestGridScope allocation_scope;');};
const file=buildDiagnostic('wide-grid-failure',`
SDNAP_EXPORT("sdnap_test_comment_fail") void sdnap_test_comment_fail(int n){sdnap::mem::test_comment_fail=n;}
SDNAP_EXPORT("sdnap_test_grid_fail") void sdnap_test_grid_fail(int n){sdnap::mem::test_grid_at=n;sdnap::mem::test_grid_calls=0;}
SDNAP_EXPORT("sdnap_test_grid_calls") int sdnap_test_grid_calls(){return sdnap::mem::test_grid_calls;}
SDNAP_EXPORT("sdnap_test_grid_min") double sdnap_test_grid_min(){return sdnap::xpt::tess::kGridMinimumBytes;}
`,s=>s,{'epoch_store.inc':s=>s.replace('refused_comment = static_cast<char*>(mem::malloc(size));','refused_comment = mem::test_comment_fail ? (mem::note_failure(size), nullptr) : static_cast<char*>(mem::malloc(size));'),'constants.inc':inject,'wide_grid_cache.inc':s=>scope(s,'wide_grid_acquire'),'tesseral.inc':s=>scope(s,'wide_grid_build')});
const rs=records(21),cases=[];
for(const k of [0,10]){
 const base=await open(file);await base.load([rs[k]]);base.x.sdnap_test_grid_fail(0);const truth=base.one();assert.equal(truth.rc,0);const count=base.x.sdnap_test_grid_calls();assert.ok(count>=12);await base.close();
 for(let at=1;at<=count;++at){
  const h=await open(file);try{await h.load([rs[k]]);h.x.sdnap_test_grid_fail(at);const failed=h.one();assert.equal(failed.rc,91,'retryable allocation '+at);h.x.sdnap_test_grid_fail(0);assert.deepEqual(h.one(),truth,'retry '+at);assert.ok(h.budget().out[1]<=h.budget().out[0]);}finally{await h.close();}
 }
 cases.push({class:k===0?'transfer':'eccentric-low',allocationSites:count});
}
const h=await open(file);
try{
 h.x.sdnap_test_grid_fail(1);
 const frame=await h.frame(rs.slice(0,3));assert.equal(frame.statusCode,3);assert.equal(frame.errorCode,'out-of-memory');
 const blocks=frame.outputs.filter(o=>o.portId==='ephemeris').flatMap(o=>OEM.getRootAsOEM(new flatbuffers.ByteBuffer(o.payload)).unpack().EPHEMERIS_DATA_BLOCK);
 assert.equal(blocks.length,3);assert.match(String(blocks[0].COMMENT),/status=refused/);assert.match(String(blocks[0].COMMENT),/out-of-memory/);
 assert.equal(blocks[0].EPHEMERIS_DATA_LINES.length,0);
 for(const b of blocks.slice(1)){assert.equal(b.COMMENT,null);assert.equal(b.EPHEMERIS_DATA_LINES.length,1);}
 h.x.sdnap_test_grid_fail(-1);
 const many=await h.h.invoke({methodId:'propagate_epochs',inputs:flight([rs[0]],{output:{EPOCHS:Array.from({length:2000},(_,k)=>new Date(Date.parse('2026-06-15T00:00:00Z')+k*60000).toISOString().slice(0,-1))}})});
 assert.equal(many.statusCode,3);assert.equal(many.errorCode,'out-of-memory');
 const block=OEM.getRootAsOEM(new flatbuffers.ByteBuffer(many.outputs[0].payload)).unpack().EPHEMERIS_DATA_BLOCK[0];
 assert.equal(block.EPHEMERIS_DATA_LINES.length,0);assert.match(block.COMMENT,/refused=2000;/);assert.match(block.COMMENT,/detail-truncated/);assert.ok(block.COMMENT.length<1300);
 h.x.sdnap_test_comment_fail(1);const noComment=await h.frame(rs.slice(0,3));assert.equal(noComment.statusCode,3);assert.equal(noComment.errorCode,'out-of-memory');h.x.sdnap_test_comment_fail(0);
 h.x.sdnap_test_grid_fail(0);assert.equal((await h.frame(rs.slice(0,3))).statusCode,0);
}finally{await h.close();}
console.log(JSON.stringify({complete:true,cases,framedContinuation:true}));

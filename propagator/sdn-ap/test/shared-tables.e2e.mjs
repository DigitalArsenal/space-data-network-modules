// Deterministic concurrent initialization: no orbital tolerance is involved.
// A held writer exposes the leap-table publication gap, or a second writer
// enters a table fill. Startup must finish every fill before either can occur.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {buildDiagnostic} from './lib/ap-diagnostic.mjs';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const replace=(s,a,b)=>{assert(s.includes(a),a);return s.replace(a,b);};
const original=(f,s)=>process.env.SDNAP_TABLE_BASELINE
 ?execFileSync('git',['-C',root,'show',`${process.env.SDNAP_TABLE_BASELINE}:propagator/sdn-ap/src/${f}`],{encoding:'utf8'}):s;
const hooks=`
namespace sdnap::pool {
inline int table_target=0, table_armed=0, table_arrivals=0;
inline int leap_release=0, leap_ready=0, leap_zero=0;
inline void table_enter(int target) {
 if(!table_armed || target!=table_target)return;
 __atomic_add_fetch(&table_arrivals,1,__ATOMIC_SEQ_CST);
 while(__atomic_load_n(&table_arrivals,__ATOMIC_SEQ_CST)<2)sched_yield();
}
inline void leap_hook(int phase,int pointer) {
 if(!table_armed || table_target!=0)return;
 if(phase==1){
  if(__atomic_add_fetch(&table_arrivals,1,__ATOMIC_SEQ_CST)==1){
   while(!__atomic_load_n(&leap_release,__ATOMIC_SEQ_CST))sched_yield();
  }else __atomic_store_n(&leap_release,1,__ATOMIC_SEQ_CST);
 }else if(pointer==0){
  __atomic_add_fetch(&leap_zero,1,__ATOMIC_SEQ_CST);
  __atomic_store_n(&leap_release,1,__ATOMIC_SEQ_CST);
  while(!__atomic_load_n(&leap_ready,__ATOMIC_SEQ_CST))sched_yield();
 }else __atomic_store_n(&leap_ready,1,__ATOMIC_SEQ_CST);
}
inline void table_probe() {
 switch(table_target){
 case 0:{double d;eraDat(2026,1,1,0.0,&d);break;}
 case 1:(void)drag::table_heights();break;
 case 2:(void)drag::table();break;
 case 3:(void)xpt::tess::egm_tables();break;
 case 4:(void)xpt::tess::half_table();break;
 }
}
}
`;
const extra=`
SDNAP_EXPORT("sdnap_test_leap_hook") void sdnap_test_leap_hook(int p,int v){sdnap::pool::leap_hook(p,v);}
SDNAP_EXPORT("sdnap_test_table_run") int sdnap_test_table_run(int target){
 using namespace sdnap::pool;table_target=target;table_armed=1;
 auto& j=job();j.kind=99;j.count=4*kChunk;
 const int rc=run(j.count,16*1024*1024);table_armed=0;return rc;
}
SDNAP_EXPORT("sdnap_test_table_entries") int sdnap_test_table_entries(){return sdnap::pool::table_arrivals;}
SDNAP_EXPORT("sdnap_test_table_zero") int sdnap_test_table_zero(){return sdnap::pool::leap_zero;}
`;
const transforms={
 'gcrf.inc':s=>original('gcrf.inc',s)+'\n',
 'pool.inc':s=>original('pool.inc',s)+'\n',
 'drag.inc':s=>{
  s=original('drag.inc',s);
  s=replace(s,'namespace sdnap {','namespace sdnap::pool { void table_enter(int); }\nnamespace sdnap {');
  s=replace(s,'  if (!built) {\n    int k = 0;','  if (!built) {\n    pool::table_enter(1);\n    int k = 0;');
  return replace(s,'  if (!built) {\n    const double* hs','  if (!built) {\n    pool::table_enter(2);\n    const double* hs');
 },
 'tesseral.inc':s=>{
  s=original('tesseral.inc',s);
  s=replace(s,'    init_egm_tables(t);','    sdnap::pool::table_enter(3);\n    init_egm_tables(t);');
  return replace(s,'    for (uint32_t h = 0; h < 65536;','    sdnap::pool::table_enter(4);\n    for (uint32_t h = 0; h < 65536;');
 },
 'sdn_ap_module.cpp':s=>replace(original('sdn_ap_module.cpp',s),'#include "abi.inc"',hooks+'\n#include "abi.inc"'),
 'abi.inc':s=>replace(original('abi.inc',s),'void run_chunk(const Job& j, int32_t chunk) {','void run_chunk(const Job& j, int32_t chunk) {\n if(j.kind==99){table_probe();return;}'),
};
const binary=process.env.SDNAP_TABLE_WASM??buildDiagnostic('shared-tables',extra,s=>s,transforms);
const wat=execFileSync('wasm2wat',['--enable-all',binary],{encoding:'utf8',maxBuffer:64*1024*1024});
const hook=Number(wat.match(/\(export "sdnap_test_leap_hook" \(func (\d+)\)\)/)[1]);
const inserts=[];
const instrumented=wat.split(/(?=^  \()/m).map(p=>{
 if(!p.startsWith('  (func ')||!p.includes('i32.const 2028')||!p.includes('i32.const 42'))return p;
 let n=0;
 p=p.replace(/(      i32.const 42\n      i32.store[^\n]*\n)/g,m=>{n++;const a=`      i32.const 1\n      i32.const 0\n      call ${hook}\n`;inserts.push(a);return m+a;});assert.equal(n,1);
 p=p.replace(/(    end\n    local.set (\d+)\n)/,(m,_,local)=>{const a=`    i32.const 2\n    local.get ${local}\n    call ${hook}\n`;inserts.push(a);return m+a;});return p;
}).join('');
assert.equal(inserts.length,2);
let recovered=instrumented;for(const i of inserts)recovered=recovered.replace(i,'');assert.equal(recovered,wat);
const output=binary+'.tables.wasm',wp=output+'.wat';fs.writeFileSync(wp,instrumented);
execFileSync('wat2wasm',['--enable-all',wp,'-o',output]);
const results=[];
for(let target=0;target<5;target++){
 const h=await createStandaloneHarness('browser',output,{surface:'direct',maxThreads:2,enableBrowserWasiThreads:true});
 const x=h.instance.exports;assert.equal(x.sdnap_threads(2),2);
 assert.equal(x.sdnap_test_table_run(target),0);
 results.push({target,entries:x.sdnap_test_table_entries(),nullReads:x.sdnap_test_table_zero()});
 await h.close?.();
}
console.log(JSON.stringify({binary,originalInstructionsPreserved:true,results}));
assert(results.every(r=>r.entries===0&&r.nullReads===0),'shared tables must finish initialization before concurrent calls');
process.exit(0);

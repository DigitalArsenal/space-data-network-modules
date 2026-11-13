#!/usr/bin/env node
// Synthetic low AP orbit in TEME, UTC 2026-06-15. Each failed initialization
// table allocation must produce out-of-memory with no output and release its tables.
import assert from 'node:assert/strict';
import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {buildDiagnostic} from './lib/ap-diagnostic.mjs';
import {seedOcm,flight} from './lib/ocm.mjs';
const file=buildDiagnostic('init-allocation',`
SDNAP_EXPORT("sdnap_test_fail_table") void sdnap_test_fail_table(int n) { sdnap::mem::test_fail_after=n;sdnap::mem::test_table_calls=0; }
SDNAP_EXPORT("sdnap_test_table_calls") int sdnap_test_table_calls() { return sdnap::mem::test_table_calls; }
SDNAP_EXPORT("sdnap_test_live_tables") int sdnap_test_live_tables() { return sdnap::mem::test_live_tables; }
`,s=>s,{'constants.inc':s=>s.replace('namespace mem {','namespace mem {\ninline int test_fail_after=-1,test_table_calls=0,test_live_tables=0;')
 .replace('if (data) return count == n;','if (data) return count == n;\n    if (test_table_calls++ == test_fail_after) { note_failure(n*sizeof(T)); return false; }')
 .replace('count = n;','count = n; ++test_live_tables;')
 .replace('std::free(data); data = nullptr; count = 0;','if (data) --test_live_tables;\n    std::free(data); data = nullptr; count = 0;')});
const record=seedOcm({epoch:'2026-06-15T00:00:00.000',n:15.2,e:0.0001,i:97.4,raan:60,argp:90,ma:10,norad:81100,tesseral:70,zonal:20,slow:true});
const inputs=flight([record],{output:{EPOCHS:['2026-06-15T00:00:00.000','2026-06-15T01:00:00.000']}});
const open=()=>createStandaloneHarness('browser',file,{surface:'direct',maxThreads:1,enableBrowserWasiThreads:false});
const good=await open();good.instance.exports.sdnap_test_fail_table(-1);
const expected=await good.invoke({methodId:'propagate',inputs});assert.equal(expected.statusCode,0);
const calls=good.instance.exports.sdnap_test_table_calls();assert.ok(calls>21);
for(const at of [...new Set([0,1,2,3,5,8,13,21,calls-1])]) {
 const h=await open(),x=h.instance.exports;x.sdnap_test_fail_table(at);
 const r=await h.invoke({methodId:'propagate',inputs});
 assert.notEqual(r.statusCode,0,`failure ${at} refuses`);assert.equal(r.errorCode,'out-of-memory',`failure ${at}`);
 assert.equal(r.outputs?.length??0,0,`failure ${at} emits nothing`);assert.equal(x.sdnap_test_live_tables(),0,`failure ${at} releases tables`);
 x.sdnap_test_fail_table(-1);const retry=await h.invoke({methodId:'propagate',inputs});assert.equal(retry.statusCode,0,`retry ${at}`);
 assert.equal(x.sdnap_test_live_tables(),0,`retry ${at} releases tables`);
 const bytes=r=>Buffer.from(r.outputs.find(o=>o.portId==='ephemeris').payload);
 assert.deepEqual(bytes(retry),bytes(expected),`retry ${at} reproduces the successful output bytes`);
}
console.log(`INIT-ALLOCATION PASS: nine injected failures among ${calls} table allocations refuse by name, release all tables, and retry byte equal`);
process.exit(0);

#!/usr/bin/env node
// Synthetic AP sets, TEME km and km/s, UTC 2026-06-15. Exact equality (Object.is):
// initialization and flight depend on the set and time, with zero rounding allowance.
// The independent reference for each memo value is the original scalar evaluator,
// not another invocation of the memo. This also detects an incomplete within-call key.
import assert from 'node:assert/strict';
import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {wasmPath, elementRows} from './lib/module.mjs';
import {buildDiagnostic} from './lib/ap-diagnostic.mjs';
import {seedOcm, T} from './lib/ocm.mjs';

const probeSource = `
static uint32_t test_pool_rows = 0;
static void test_row_seen(uint32_t, bool threaded) { if (threaded) __atomic_add_fetch(&test_pool_rows, 1u, __ATOMIC_RELAXED); }
SDNAP_EXPORT("sdnap_test_init_memo") int sdnap_test_init_memo(double e) {
  using namespace sdnap::xpt;
  tess::SlowGMemo memo;
  for (int j = 1; j <= 6; ++j) for (int q = -4; q <= 4; ++q) {
    const int w = j - q, aw = std::abs(w);
    for (int l = std::max(2, aw); l <= 70; ++l) {
      if ((l - w) & 1) continue;
      double a[2], b[2];
      memo.get(l, (l-w)/2, q, j, e, a[0], a[1]);
      tess::slow_G(l, (l-w)/2, q, j, e, b[0], b[1]);
      if (std::memcmp(a, b, sizeof(a))) return j*10000+(q+4)*100+l;
    }
  }
  return 0;
}
SDNAP_EXPORT("sdnap_test_ap_rows") int sdnap_test_ap_rows(const sdnap::ElementRow* rows, uint32_t n) {
  sdnap::xpt::tess::active() = sdnap::xpt::tess::Terms{70,20,false,true};
  int rc = sdnap::store_init(rows,n);
  sdnap::xpt::tess::active() = sdnap::xpt::tess::Terms{};
  sdnap::pool::g_row_hook = test_row_seen;
  return rc;
}
SDNAP_EXPORT("sdnap_test_pool_rows") uint32_t sdnap_test_pool_rows() { return test_pool_rows; }
`;
// An externally supplied diagnostic permits a deliberate mutation without altering this test.
const diagnostic = process.env.SDNAP_INIT_DIAGNOSTIC || buildDiagnostic('init-memos', probeSource);
const open = async (file, threads=0) => {
  const h = await createStandaloneHarness('browser',file,{surface:'direct',maxThreads:Math.max(1,threads),enableBrowserWasiThreads:threads>0});
  const x=h.instance.exports;
  if(threads) assert.equal(x.sdnap_threads(threads),threads,'all four pool threads start');
  return {h,x};
};
const d=await open(diagnostic);
for(const e of [0,0.0001,0.000199,0.03,0.048,0.05,0.1,0.72,0.85,0.96]) {
  const mismatch=d.x.sdnap_test_init_memo(e);
  assert.equal(mismatch,0,`scalar memo reference e=${e}, first differing key encoded j*10000+(q+4)*100+l=${mismatch}`);
}
console.log('scalar memo references: ten eccentricities, every valid (j,q,l), exact');
const cases=[
 ['circular',15.2,0,97.4],['central difference',15.2,0.0001,97.4],
 ['exact 0.03',14.2,0.03,65],['exact 0.048',13.8,0.048,65],['exact 0.1',12.8,0.1,65],
 ['polar',15.2,0.001,89.98],['medium',2.0056,0.005,55],['geosynchronous',1.0027,0.0003,0.05],['transfer',2.26,0.72,27]
];
const leads=[0,60,1440,10080], epoch='2026-06-15T00:00:00.000', whole=2461206.5;
const records=cases.map(([name,n,e,i],k)=>seedOcm({epoch,n,e,i,raan:60,argp:90,ma:10,norad:81000+k,name,tesseral:70,zonal:20,slow:true}));
const prefix=u=>{const b=Buffer.alloc(u.length+4);b.writeUInt32LE(u.length);b.set(u,4);return b;};
const compare=(a,b,label)=>{assert.equal(a.length,b.length,label);a.forEach((v,k)=>assert.ok(Object.is(v,b[k]),`${label}: component ${k}: ${v} != ${b[k]}`));};
async function epochFlight(order,threads=0) {
 const {h,x}=await open(wasmPath,threads), out=x.sdnap_alloc(48);
 const r=await h.invoke({methodId:'load_epochs',inputs:[{portId:'ocm',typeRef:T('OCM'),payload:Buffer.concat(order.map(k=>prefix(records[k])))}]});
 assert.equal(r.statusCode,0,`${r.errorCode}: ${r.errorMessage}`);
 const meta=x.sdnap_alloc(64), series=new Map();
 for(let j=0;j<order.length;j++){x.sdnap_epochs_series(j,meta,0,0);series.set(new Float64Array(h.memory.buffer,meta,1)[0],j);}
 const result={};
 for(const k of order) result[k]=leads.map(t=>{
  assert.equal(x.sdnap_epochs_set_at(series.get(81000+k),0,whole,t/1440,out),0,`${cases[k][0]} at ${t} min`);
  return Array.from(new Float64Array(h.memory.buffer,out,6));
 });
 return result;
}
const alone={};for(const k of cases.keys()) Object.assign(alone,await epochFlight([k]));
for(const threads of [0,4]) for(const order of [[...cases.keys()],[...cases.keys()].reverse()]) {
 const got=await epochFlight(order,threads);
 for(const k of order) leads.forEach((t,j)=>compare(got[k][j],alone[k][j],`${cases[k][0]} ${t} min, threads=${threads}`));
}
console.log('nine sets: alone, forward and reverse construction/flight orders, pool configured at zero and four, exact');
// Epoch-store calls are serial. Exercise actual pool flight separately through the row ABI.
const sets=cases.map(([,n,e,i],k)=>({epochWhole:whole,epochFrac:0,meanMotion:n,ecc:e,inc:i,raan:60,argp:90,ma:10,norad:81000+k,theory:4}));
async function rowFlight(order,threads) {
 const {h,x}=await open(diagnostic,threads), bytes=elementRows(order.map(k=>sets[k])), p=x.sdnap_alloc(bytes.length);
 new Uint8Array(h.memory.buffer,p,bytes.length).set(bytes);
 assert.equal(x.sdnap_test_ap_rows(p,order.length),order.length);
 const out=x.sdnap_alloc(48*order.length),st=x.sdnap_alloc(4*order.length),times=x.sdnap_alloc(8*order.length), result=[];
 for(const t of leads) {
  new Float64Array(h.memory.buffer,times,order.length).fill(t);
  assert.equal(x.sdnap_propagate_minutes_soa(times,0,order.length,out,st),0);
  const status=new Int32Array(h.memory.buffer,st,order.length), data=new Float64Array(h.memory.buffer,out,6*order.length);
  result.push(order.map((k,r)=>{assert.equal(status[r],0,`${cases[k][0]} row ${r}`);return Array.from({length:6},(_,c)=>data[c*order.length+r]);}));
 }
 if(threads) assert.ok(x.sdnap_test_pool_rows()>0,'pool threads actually flew rows');
 return result;
}
const reference=[];for(const k of cases.keys()) reference[k]=(await rowFlight([k],0)).map(rows=>rows[0]);
for(const reverse of [false,true]) {
 const order=Array.from({length:2048},(_,k)=>k%cases.length);if(reverse)order.reverse();
 const got=await rowFlight(order,4);
 got.forEach((rows,j)=>rows.forEach((state,r)=>compare(state,reference[order[r]][j],`pool row ${r}, ${leads[j]} min`)));
}
console.log('INIT-MEMOS PASS: scalar keys, nine sets, two orders, actual four-thread pool, every state bit equal');
process.exit(0);

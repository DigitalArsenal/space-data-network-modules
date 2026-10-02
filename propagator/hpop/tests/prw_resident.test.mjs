// Portable resident contract, sourced from the published SDS 1.232.0 PRW/FRM/
// PPE/TIM definitions. Numerical fixtures use the zero-duration solution
// x(t0)=x0 (any regular ODE), SI kilo=10^3, and the independent clock facts below.
// Physics remains in the C++ guest; JS builds records and checks outcomes only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { residentHarness } from './lib/residentRuntime.mjs';
import { createHash } from 'node:crypto';
import { TYPE, sds, makeTable, encodePrw, decodePrw, instant, coordinateSystem, residentState } from './lib/prwCodec.mjs';

const wasm = fs.readFileSync(new URL('../dist/isomorphic/module.wasm', import.meta.url));
const epoch = 2451545;
const residentRuntime=process.env.HPOP_RESIDENT_RUNTIME??'browser';
if(!['browser','wasmedge','docker-wasmedge'].includes(residentRuntime)) throw new Error(`Unsupported resident runtime ${residentRuntime}`);
console.log(`PRW resident runtime=${residentRuntime} wasm_sha256=${createHash('sha256').update(wasm).digest('hex')}`);
const instance = (generation=1n) => makeTable('PRWInstance', {
  MODULE_ID:'com.orbpro.hpop', INSTANCE_ID:'resident-contract-fixture', GENERATION:generation,
});
function seed(handle=31, generation=1n, extra={}) {
  return Object.assign(residentState({epochJD:epoch, position:[7000,0,0], velocity:[0,7.5,1]}), {
    INSTANCE:instance(generation), ENTITY_HANDLE:handle, CATALOG_NUMBER:25544,
    OBJECT_ID:`fixture-${handle}`, ...extra,
  });
}
const frame = (portId, arm, record) => ({portId, typeRef:TYPE, payload:encodePrw(arm,record)});
const input = (methodId, arm, record, outputStreamCap=1) => ({methodId, outputStreamCap,
  inputs:[frame(methodId==='ingest_state'?'state':'request',arm,record)]});
async function harness(t) {
  const h = await residentHarness(residentRuntime);
  t.after(()=>h.destroy());
  return h;
}
function success(response) {
  assert.equal(response.statusCode,0,`${response.errorCode}: ${response.errorMessage}`);
  return response.outputs.map(x=>decodePrw(x.payload));
}
function rejected(response, classification) {
  assert.notEqual(response.statusCode,0);
  assert.equal(response.outputs.length,0);
  assert.equal(response.errorCode,classification,response.errorMessage);
}
const batch = (generation=1n, handles=[]) => makeTable('PRWResidentRequest', {
  INSTANCE:instance(generation), TARGET_EPOCH:instant(epoch), ENTITY_HANDLES:handles,
  TARGET_COORDINATE_SYSTEM:coordinateSystem(),
});
const prepare = (generation=1n, extra={}) => makeTable('PRWPrepareRequest', {
  INSTANCE:instance(generation), START_EPOCH:instant(epoch), DURATION_SECONDS:600,
  PROFILE:'conjunction-screening', ...extra,
});
const describe = (handle,generation=1n) => makeTable('PRWDescribeRequest', {
  INSTANCE:instance(generation), SEGMENT_SET_HANDLE:handle,
});
function assertUnmeasured(quality) {
  assert.equal(quality.EVIDENCE_KIND,sds.prwQualityEvidence.UNMEASURED);
  assert.equal(quality.HAS_MAXIMUM_POSITION_ERROR_M,false);
  assert.equal(quality.HAS_MAXIMUM_VELOCITY_ERROR_M_S,false);
  assert.equal(quality.METHOD,null);
  assert.equal(quality.REFERENCE_CONTENT_ID,null);
}

test('PRW resident retains SI state and host handles at the initial TDB epoch',async t=>{
  const h=await harness(t);
  success(await h.invoke(input('ingest_state','RESIDENT_STATE',seed())));
  const [result]=success(await h.invoke(input('propagate_state','RESIDENT_REQUEST',batch())));
  const out=result.RESIDENT_STATE;
  assert.equal(out.ENTITY_HANDLE,31);
  assert.equal(out.CATALOG_NUMBER,25544);
  assert.equal(out.OBJECT_ID,'fixture-31');
  assert.equal(out.INSTANCE.GENERATION,1n);
  assert.equal(out.COORDINATE_SYSTEM.NAME,'GCRF');
  assert.equal(out.COORDINATE_SYSTEM.ORIGIN.CELESTIAL_BODY_ID,399);
  assert.equal(out.STATE.EPOCH_TIME_SYSTEM,'TDB');
  // Exact initial-value solution, Earth GCRF, J2000 TDB; no integration/fit
  // tolerance needed. SI prefixes: https://www.bipm.org/en/measurement-units/si-prefixes
  assert.deepEqual([out.STATE.POSITION.X,out.STATE.POSITION.Y,out.STATE.POSITION.Z],[7000000,0,0]);
  assert.deepEqual([out.STATE.VELOCITY.X,out.STATE.VELOCITY.Y,out.STATE.VELOCITY.Z],[0,7500,1000]);
});

test('PRW resident UTC clock is converted inside WASM before TDB integration',async t=>{
  const h=await harness(t);
  const state=seed(); state.STATE.EPOCH_TIME_SYSTEM='UTC';
  success(await h.invoke(input('ingest_state','RESIDENT_STATE',state)));
  const request=batch(); request.TARGET_EPOCH=instant(epoch,'UTC');
  const [result]=success(await h.invoke(input('propagate_state','RESIDENT_REQUEST',request)));
  const out=result.RESIDENT_STATE;
  assert.equal(out.STATE.EPOCH_TIME_SYSTEM,'TDB');
  // BIPM Circular T 201: TAI-UTC=32 s from 1999-01-01.
  // https://webtai.bipm.org/ftp/pub/tai/Circular-T/cirtpdf/cirt.201.pdf
  // IERS: TT=TAI+32.184 s. ESA Earth Observation CFI math conventions:
  // |TDB-TT| <= 0.001658+0.000014 s in the supported approximate model.
  // https://www.iers.org/iers/en/service/faqs/time/howisttcomputedfromtai-163
  // https://eop-cfi.esa.int/Repo/PUBLIC/DOCUMENTATION/CFI/ENVCFI/5.9_Documentation/mcd2.0.pdf
  // Epoch is 2000-01-01T12:00:00 UTC, units seconds. 2 ms tolerance covers the
  // model's full periodic amplitude plus binary JD/text rounding (<0.1 ms).
  const match=/T12:01:(\d\d\.\d+)/.exec(out.STATE.EPOCH);
  assert.ok(match,out.STATE.EPOCH);
  assert.ok(Math.abs(60+Number(match[1])-64.184)<0.002,out.STATE.EPOCH);
  assert.equal(out.STATE.POSITION.X,7000000);
});

test('PRW replacement is atomic and rejects stale generations and unsupported controls',async t=>{
  const h=await harness(t);
  success(await h.invoke(input('ingest_state','RESIDENT_STATE',seed())));
  for (const extra of [
    {HAS_MASS_KG:true,MASS_KG:1000},
    {HAS_DRAG_AREA_OVER_MASS_M2_KG:true,DRAG_AREA_OVER_MASS_M2_KG:0.01},
    {HAS_SRP_AREA_OVER_MASS_M2_KG:true,SRP_AREA_OVER_MASS_M2_KG:0.01},
  ]) rejected(await h.invoke(input('ingest_state','RESIDENT_STATE',seed(31,2n,extra))),'unsupported-configuration');
  // Failed replacement leaves the previous catalog generation intact.
  success(await h.invoke(input('propagate_state','RESIDENT_REQUEST',batch())));
  rejected(await h.invoke(input('ingest_state','RESIDENT_STATE',seed())),'stale-instance');
  const [prepared]=success(await h.invoke(input('prepare_trajectory_segments','PREPARE_REQUEST',prepare())));
  const handle=prepared.PREPARE_RESULT.SEGMENT_SET_HANDLE;
  success(await h.invoke(input('ingest_state','RESIDENT_STATE',seed(31,2n))));
  rejected(await h.invoke(input('propagate_state','RESIDENT_REQUEST',batch())),'stale-instance');
  rejected(await h.invoke(input('describe_trajectory_segments','DESCRIBE_REQUEST',describe(handle,2n))),'stale-handle');
  success(await h.invoke(input('propagate_state','RESIDENT_REQUEST',batch(2n))));
});

test('PRW resident rejects unsupported axes, wrong arms and invalid selected states',async t=>{
  const h=await harness(t);
  for (const axes of ['ECEF','TEME']) {
    const state=seed(); state.COORDINATE_SYSTEM=coordinateSystem(axes); state.STATE.COORDINATE_SYSTEM_NAME=axes;
    rejected(await h.invoke(input('ingest_state','RESIDENT_STATE',state)),'eop-data-required');
  }
  success(await h.invoke(input('ingest_state','RESIDENT_STATE',seed(31,1n,{VALID:false}))));
  rejected(await h.invoke(input('propagate_state','RESIDENT_REQUEST',batch())),'invalid-state');
  rejected(await h.invoke(input('propagate_state','VERSION_QUERY',true)),'method-arm-mismatch');
});

test('PRW resident preserves requested ordering and validates duplicates',async t=>{
  const h=await harness(t);
  success(await h.invoke({methodId:'ingest_state',inputs:[
    frame('state','RESIDENT_STATE',seed(31)),frame('state','RESIDENT_STATE',seed(47)),
  ]}));
  const request=batch(1n,[47,31]); request.MAXIMUM_COUNT=1;
  const response=await h.invoke(input('propagate_state','RESIDENT_REQUEST',request));
  assert.equal(success(response)[0].RESIDENT_STATE.ENTITY_HANDLE,47);
  assert.equal(response.yielded,false); assert.equal(BigInt(response.backlogRemaining),0n);
  rejected(await h.invoke(input('propagate_state','RESIDENT_REQUEST',batch(1n,[31,31]))),'invalid-request');
  rejected(await h.invoke(input('propagate_state','RESIDENT_REQUEST',batch(1n,[999]))),'unknown-entity');
  const replacement={methodId:'ingest_state',inputs:[
    frame('state','RESIDENT_STATE',seed(31,2n)),frame('state','RESIDENT_STATE',seed(31,2n)),
  ]};
  rejected(await h.invoke(replacement),'invalid-request');
  success(await h.invoke(input('propagate_state','RESIDENT_REQUEST',batch(1n,[31]))));
});

test('PRW resident invalidates diagnostic configuration and burn mutations',
  {skip:residentRuntime!=='browser'?'SDK process harness intentionally exposes only public PIV methods, not diagnostic C exports':false},async t=>{
  const h=await harness(t);
  success(await h.invoke(input('ingest_state','RESIDENT_STATE',seed())));
  h.instance.exports.plugin_set_integrator(2);
  rejected(await h.invoke(input('propagate_state','RESIDENT_REQUEST',batch(1n,[31]))),'stale-instance');
  success(await h.invoke(input('ingest_state','RESIDENT_STATE',seed(31,2n))));
  h.instance.exports.plugin_clear_burns(0);
  rejected(await h.invoke(input('propagate_state','RESIDENT_REQUEST',batch(2n,[31]))),'stale-instance');
});

test('PRW trajectory exports nested PPE, honest quality, and bounded source chunks',async t=>{
  const h=await harness(t);
  success(await h.invoke({methodId:'ingest_state',inputs:[
    frame('state','RESIDENT_STATE',seed(31)),frame('state','RESIDENT_STATE',seed(47)),
  ]}));
  const firstBatch=await h.invoke(input('propagate_state','RESIDENT_REQUEST',batch()));
  assert.equal(success(firstBatch)[0].RESIDENT_STATE.ENTITY_HANDLE,31);
  assert.equal(firstBatch.yielded,true); assert.equal(BigInt(firstBatch.backlogRemaining),1n);
  const secondBatch=await h.invoke(input('propagate_state','RESIDENT_REQUEST',batch()));
  assert.equal(success(secondBatch)[0].RESIDENT_STATE.ENTITY_HANDLE,47);
  assert.equal(secondBatch.yielded,false); assert.equal(BigInt(secondBatch.backlogRemaining),0n);
  rejected(await h.invoke(input('prepare_trajectory_segments','PREPARE_REQUEST',prepare(1n,{PROFILE:'unknown'}))),'unsupported-configuration');
  const [prepared]=success(await h.invoke(input('prepare_trajectory_segments','PREPARE_REQUEST',prepare())));
  assert.equal(prepared.PREPARE_RESULT.COVERAGE_COMPLETE,true);
  assertUnmeasured(prepared.PREPARE_RESULT.QUALITY);
  const request=input('describe_trajectory_segments','DESCRIBE_REQUEST',describe(prepared.PREPARE_RESULT.SEGMENT_SET_HANDLE));
  for (let i=0;i<2;i++) {
    const response=await h.invoke(request);
    const [result]=success(response), chunk=result.DESCRIBE_RESULT;
    assert.equal(chunk.SOURCE_OFFSET,BigInt(i)); assert.equal(chunk.FINAL_CHUNK,i===1);
    assert.equal(chunk.SOURCES.length,1); assert.equal(chunk.SOURCES[0].SOURCE_HANDLE,[31,47][i]);
    const source=chunk.SOURCES[0], ppe=source.EPHEMERIS;
    assert.equal(ppe.CENTER_NAME,'EARTH'); assert.equal(ppe.TIME_SYSTEM,sds.timingStandard.TDB);
    assert.equal(ppe.REFERENCE_FRAME.NAME,'GCRF');
    assert.ok(ppe.POSITION_RECORDS.length>=1);
    assert.equal(ppe.POSITION_RECORDS.length,source.SEGMENT_QUALITY.length);
    // SDS PPE representation requirements, not an unverified error bound:
    // midpoint + half-span, 13 intact coefficients/axis, km and km/s.
    for (const polynomial of ppe.POSITION_RECORDS) {
      assert.equal(polynomial.NUM_COEFFICIENTS,13);
      assert.equal(polynomial.BASIS_TYPE,sds.polynomialBasisType.CHEBYSHEV);
      assert.equal(polynomial.HAS_VELOCITY_COEFFICIENTS,true);
      assert.ok(Math.abs(polynomial.EPOCH_HALF_SPAN-300)<0.0001);
      for (const axis of ['POS_COEFF_X','POS_COEFF_Y','POS_COEFF_Z','VEL_COEFF_X','VEL_COEFF_Y','VEL_COEFF_Z']) {
        assert.equal(polynomial[axis].length,13); assert.ok(polynomial[axis].every(Number.isFinite));
      }
    }
    source.SEGMENT_QUALITY.forEach(assertUnmeasured);
    assert.equal(response.yielded,i===0);
  }
  console.log('PASS PRW resident SI/UTC-generation/PPE: 2 sources, 13 coefficients per axis, quality UNMEASURED, 1-source chunks');
});

test('PRW trajectory windows on segment boundaries export one after another',async t=>{
  const h=await harness(t);
  success(await h.invoke({methodId:'ingest_state',inputs:[frame('state','RESIDENT_STATE',seed(31)),frame('state','RESIDENT_STATE',seed(47))]}));
  // 2 h windows start on 10-minute segment boundaries, where the grid index
  // used to land one segment off; each window is exported after the last.
  let previousEnd=null;
  for (let k=0;k<4;k++) {
    const start=epoch+k*2/24;
    const [prepared]=success(await h.invoke(input('prepare_trajectory_segments','PREPARE_REQUEST',
      makeTable('PRWPrepareRequest',{INSTANCE:instance(),START_EPOCH:instant(start),DURATION_SECONDS:7200,PROFILE:'conjunction-screening'}))));
    assert.equal(prepared.PREPARE_RESULT.COVERAGE_COMPLETE,true);
    const [described]=success(await h.invoke(input('describe_trajectory_segments','DESCRIBE_REQUEST',describe(prepared.PREPARE_RESULT.SEGMENT_SET_HANDLE))));
    const records=described.DESCRIBE_RESULT.SOURCES[0].EPHEMERIS.POSITION_RECORDS;
    const jd=(iso)=>Date.parse(iso.slice(0,23)+'Z')/86400000+2440587.5;
    const first=jd(records[0].EPOCH_MID)-records[0].EPOCH_HALF_SPAN/86400, last=jd(records.at(-1).EPOCH_MID)+records.at(-1).EPOCH_HALF_SPAN/86400;
    assert.ok(first<=start+1e-8 && last>=start+2/24-1e-8,`window ${k} covered`);
    if (previousEnd!==null) assert.ok(first<=previousEnd+1e-8,`window ${k} follows window ${k-1}`);
    previousEnd=last;
  }
});

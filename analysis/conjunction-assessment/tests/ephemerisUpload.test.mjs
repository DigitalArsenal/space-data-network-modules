// All science executes in the built guest. Fixtures and independent ERFA
// reference: scripts/generate-ephemeris-fixtures.cpp. Native ERFA producer
// checks the published t_c2t06a matrix at TT=UT1=MJD53736, xp=2.55060238e-7,
// yp=1.860359247e-6 rad to 1e-12 before generating the UTC fixtures.
// Straight-line EME2000 trajectories at 2006-01-02T00:01:00Z have closed-form
// TCA at that epoch and 50 m miss. Cubic Hermite exactly represents each
// line after transforming its nodes: 0.5 mm per position component (3-D
// error < 1 mm) and 1 um/s velocity
// allowances cover matrix/stencil roundoff. TCA tolerance 2 ms covers the
// requested 50 us search resolution and ~40 us binary64 JD quantization;
// Analytic miss tolerance 5 m bounds the transverse displacement at 2 ms
// (10.607 km/s relative speed); parity comparisons use 1 mm.
// Pc relative tolerance 1e-5: a 1 mm miss error changes log(Pc) by about
// d*delta_d/sigma^2=50*.001/20000=2.5e-6 for these covariances; the remaining
// margin covers covariance-axis interpolation and the neighboring TCA clock.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createConjunctionCommandHarness } from './lib/conjunctionCommandHarness.mjs';
import { decodeCqr, encodeCqr, initCqrFlatc, publishedSchema, pairRequest, earthFrame, utcJd } from './lib/cqr.mjs';
const fixture = name => fs.readFileSync(new URL(`fixtures/ephemeris-upload/${name}`, import.meta.url), 'utf8');
const reference = JSON.parse(fixture('reference.json'));
const failures = JSON.parse(fixture('failures.json'));
const formats = ['oem-eme2000.kvn','oem-itrf.kvn','itc.txt','jspoc.txt','utc.txt','nasa.txt'];
const encode = (f, schema, value) => f.generateBinary(publishedSchema(schema), JSON.stringify(value), {sizePrefix:false});
const decode = (f, schema, payload) => JSON.parse(f.generateJSON(publishedSchema(schema), {path:'/record.bin', data:payload}, {defaultsJson:true}));
const native = text => ({NATIVE_DOCUMENT:{CONTENT:[...new TextEncoder().encode(text)]}});
const rows = oem => oem.EPHEMERIS_DATA_BLOCK.flatMap(b=>b.EPHEMERIS_DATA_LINES);
const source = (oem,id) => ({OBJECT_ID:id, OBJECT_NAME:id, EPHEMERIS:oem});
const vec = p => [p.X,p.Y,p.Z];
function close(got,want,tolerance,label) { assert.ok(Math.abs(got-want)<=tolerance,`${label}: got ${got}, expected ${want}, tolerance ${tolerance}`); }

for(const runtimeKind of ['browser','wasmedge']) test(`${runtimeKind}: ephemeris uploads and ITRF screening through built WASM`, async t=>{
  let h;
  try { h=await createConjunctionCommandHarness({runtimeKind}); }
  catch(error) { if(runtimeKind==='wasmedge' && /ENOENT|command not found|Failed to launch|WasmEdge.*(?:not found|missing)/i.test(String(error))) {t.skip(`WasmEdge unavailable: ${error.message}`);return;} throw error; }
  t.after(()=>h.destroy());
  const f=await initCqrFlatc();
  const eop = value => ({portId:'earth_orientation',payload:encode(f,'EOP',value)});
  async function parse(text,options={}) {
    const inputs=[{portId:'ephemeris',payload:encodeCqr(f,native(text))},
      {portId:'reference_epoch',payload:encode(f,'TIM',{INSTANT:options.reference ? {TIME_SYSTEM:'UTC',EPOCH_FORMAT:'ISO8601',ISO8601:options.reference} : utcJd(reference.reference_jd)})}];
    if(options.format) inputs.push({portId:'format',payload:encodeCqr(f,native(options.format))});
    if(options.object) inputs.push({portId:'object',payload:encode(f,'CAT',options.object)});
    const r=await h.invoke({methodId:'parse_ephemeris',inputs});
    return {r,oem:r.outputs?.find(x=>x.portId==='oem')?.payload};
  }
  async function good(text,options) { const {r,oem}=await parse(text,options); assert.equal(r.statusCode,0,`${r.errorCode}: ${r.errorMessage}`); assert.ok(oem);const validation=decodeCqr(f,r.outputs.find(x=>x.portId==='validation').payload);assert.match(new TextDecoder().decode(Uint8Array.from(validation.NATIVE_DOCUMENT.CONTENT)),/^valid; format=.+; states=13; future_states=13$/);return decode(f,'OEM',oem); }
  async function assess(a,b,{withEop=true,frame='EME2000',algorithm='ALFANO_MAXIMUM',startJd=reference.start_jd,durationSeconds=120,methodId='assess_conjunction',eops=[reference.eop]}={}) {
    const record=pairRequest({PRIMARY:source(a,'A'),SECONDARY:source(b,'B'),EVALUATION_FRAME:earthFrame(frame),startJd,durationSeconds,coarseStepSec:5,fineTolSec:.00005});
    record.PAIR_REQUEST.CONTROLS.ALGORITHM=algorithm;
    const inputs=[{portId:'request',payload:encodeCqr(f,record)},...(withEop?eops.map(eop):[])];
    const r=await h.invoke({methodId,inputs});
    return {r,event:r.statusCode===0?decodeCqr(f,r.outputs.find(x=>x.portId==='result').payload).EVENT_RESULT:null};
  }
  const parsed={};
  await t.test('all six autodetected formats preserve states and covariance declarations',async()=>{
    for(const name of formats) parsed[name]=await good(fixture(`A-${name}`));
    const expected=rows(parsed[formats[0]]);
    for(const name of formats.filter(x=>!x.includes('itrf'))) assert.deepEqual(rows(parsed[name]),expected,name);
    assert.equal(parsed['oem-itrf.kvn'].EPHEMERIS_DATA_BLOCK[0].REFERENCE_FRAME.REFERENCE_FRAME.COORDINATE_SYSTEM.NAME,'ITRF2020');
    for(const name of ['oem-itrf.kvn','itc.txt']) {
      const b=parsed[name].EPHEMERIS_DATA_BLOCK[0];assert.equal(b.COV_REFERENCE_FRAME.REFERENCE_FRAME.frame,'RSW_INERTIAL');assert.equal(b.COVARIANCE_MATRIX_LINES.length,13);assert.equal(b.COVARIANCE_MATRIX_LINES[0].CX_X,.01);
    }
    assert.equal(parsed['jspoc.txt'].CREATION_DATE,'2006-01-01T00:00:00.000000000Z');
    assert.equal(parsed['jspoc.txt'].EPHEMERIS_DATA_BLOCK[0].OBJECT.OBJECT_NAME,'A');
  });
  await t.test('forced format and CAT object identity',async()=>{
    const oem=await good(fixture('A-nasa.txt'),{format:'NASA',object:{OBJECT_ID:'synthetic-id',OBJECT_NAME:'synthetic-name'}});
    const ocm=await parse(fixture('ocm.txt'),{format:'OEM'});assert.equal(ocm.r.errorCode,'unsupported-format');assert.match(ocm.r.errorMessage,/S2/);
    assert.equal(oem.EPHEMERIS_DATA_BLOCK[0].OBJECT.OBJECT_ID,'synthetic-id');assert.equal(oem.EPHEMERIS_DATA_BLOCK[0].OBJECT.OBJECT_NAME,'synthetic-name');
  });
  for(const [name,options] of Object.entries(failures)) await t.test(`reject ${name}: ${options.error}`,async()=>{
    const {r}=await parse(fixture(`${name}.txt`),options);
    assert.equal(r.statusCode,400,r.errorMessage);assert.equal(r.errorCode,options.error,r.errorMessage);assert.match(r.errorMessage,/line \d+/);assert.equal(r.outputs.length,0);
  });
  await t.test('WGS-84 polar clearance, inclusive lower span/speed bounds, singular PSD, extra covariance epochs',async()=>{
    // WGS-84 a=6378.137 km, b=6356.752314245 km (1/f=298.257223563):
    // z=6370 km is above the polar ellipsoid but inside a sphere of radius a.
    // Literal states/epochs here are synthetic; no JS frame/time computation.
    const polar=fixture('A-oem-eme2000.kvn').split('COVARIANCE_START')[0].replace('REF_FRAME = EME2000','REF_FRAME = ITRF2014').split('\n').map(line=>/^2006-/.test(line)?line.split(' ')[0]+' 0 0 6370 0 0 0':line).join('\n');
    assert.equal((await parse(polar)).r.statusCode,0);
    assert.equal((await parse(polar.replaceAll(' 6370 ',' 6350 '))).r.errorCode,'below-earth-surface');
    const boundary=['00','07','14','21','28','35','42'].map(sec=>'060020000'+sec+'.000 7000 0 0 0 70 0').join('\n');
    assert.equal((await parse(boundary)).r.statusCode,0);
    assert.equal((await parse(boundary.replace('06002000042.000','06002000041.999999'))).r.errorCode,'span-too-short');
    const singular=fixture('A-oem-eme2000.kvn').replaceAll('0.01','0').replaceAll('0.089999999999999997','0');
    assert.equal((await parse(singular)).r.statusCode,0);
    const extra='EPOCH = 2006-01-03T00:00:00Z\nCOV_REF_FRAME = RTN\n-1\n0 1\n0 0 1\n0 0 0 1\n0 0 0 0 1\n0 0 0 0 0 1\n';
    const oem=await good(fixture('A-oem-eme2000.kvn').replace('COVARIANCE_STOP',extra+'COVARIANCE_STOP'));
    assert.equal(oem.EPHEMERIS_DATA_BLOCK[0].COVARIANCE_MATRIX_LINES.length,13);
  });
  const secondary=await good(fixture('B-oem-eme2000.kvn'));
  await t.test('six formats agree in EME2000 to 1 mm after conversion',async()=>{
    let baseline;
    for(const name of formats) {
      const {r,event}=await assess(parsed[name],secondary);assert.equal(r.statusCode,0,r.errorMessage);
      close(event.MISS_DISTANCE_M,50,5,`${name} closed-form miss (2 ms time tolerance)`);
      close(event.TCA.JULIAN_DATE,reference.tca_jd,2e-3/86400,`${name} analytic TCA`);
      if(!baseline)baseline=event;
      close(event.TCA.JULIAN_DATE,baseline.TCA.JULIAN_DATE,2e-3/86400,'TCA parity');
      const expected=reference.evaluation_grid.find(x=>x.jd===event.TCA.JULIAN_DATE);assert.ok(expected, `Missing independent epoch ${event.TCA.JULIAN_DATE}`);
      for(const [key,values] of [['POSITION',expected.position_m],['VELOCITY',expected.velocity_m_s]]) for(let i=0;i<3;++i) close(vec(event.PRIMARY_STATE.STATE[key])[i],values[i],key==='POSITION'?.0005:1e-6,`${name} ${key}[${i}]`);
    }
  });
  await t.test('both ITRF sources screen equivalently, with RTN and transformed ITRF covariance/Pc',async()=>{
    for(const suffix of ['', '-cov']) {
      const inertialA=await good(fixture(`A-oem-eme2000${suffix}.kvn`)),inertialB=await good(fixture(`B-oem-eme2000${suffix}.kvn`));
      const fixedA=await good(fixture(`A-oem-itrf${suffix}.kvn`)),fixedB=await good(fixture(`B-oem-itrf${suffix}.kvn`));
      const a=await assess(inertialA,inertialB,{algorithm:'LAAS_2015'}),b=await assess(fixedA,fixedB,{algorithm:'LAAS_2015'});
      assert.equal(a.r.statusCode,0,a.r.errorMessage);assert.equal(b.r.statusCode,0,b.r.errorMessage);
      close(a.event.TCA.JULIAN_DATE,b.event.TCA.JULIAN_DATE,2e-3/86400,'TCA');close(a.event.MISS_DISTANCE_M,b.event.MISS_DISTANCE_M,.001,'miss');
      assert.ok(a.event.PROBABILITY.PROBABILITY>0);assert.equal(b.event.PROBABILITY.UNCERTAINTY_SOURCE,'SUPPLIED_COVARIANCE');
      close(a.event.PROBABILITY.PROBABILITY,b.event.PROBABILITY.PROBABILITY,a.event.PROBABILITY.PROBABILITY*1e-5,'Pc');
    }
  });
  await t.test('ITRF without EOP fails closed, and EOP coverage is enforced',async()=>{
    const a=await assess(parsed['oem-itrf.kvn'],secondary,{withEop:false});assert.equal(a.r.errorCode,'eop-required');assert.equal(a.r.outputs.length,0);
    const b=await assess(parsed['oem-itrf.kvn'],secondary,{eops:[{...reference.eop,MJD:53738},{...reference.eop,MJD:53739}]});assert.equal(b.r.errorCode,'eop-coverage');
    const c=await assess(parsed['oem-itrf.kvn'],secondary,{eops:[{...reference.eop,IAU_CONVENTION:'IAU_2000B'}]});assert.equal(c.r.errorCode,'invalid-eop');
  });
  await t.test('catalog screening and bracketed EOP records retain pair/Pc equivalence',async()=>{
    async function screen(a,b,eops) {
      const pair=pairRequest({PRIMARY:source(a,'A'),SECONDARY:source(b,'B'),EVALUATION_FRAME:earthFrame('EME2000'),startJd:reference.start_jd,durationSeconds:120,fineTolSec:.00005}).PAIR_REQUEST;
      pair.CONTROLS.ALGORITHM='LAAS_2015';
      const record={CATALOG_REQUEST:{PRIMARIES:[pair.PRIMARY],SECONDARIES:[pair.SECONDARY],CONTROLS:pair.CONTROLS,EVALUATION_FRAME:pair.EVALUATION_FRAME}};
      const r=await h.invoke({methodId:'screen_catalog',inputs:[{portId:'request',payload:encodeCqr(f,record)},...eops.map(eop)]});
      assert.equal(r.statusCode,0,r.errorMessage);const result=decodeCqr(f,r.outputs.find(x=>x.portId==='result').payload).CATALOG_RESULT;assert.equal(result.EVENTS.length,1);return result.EVENTS[0];
    }
    const a=await screen(parsed['oem-eme2000.kvn'],secondary,[]);
    const fixedB=await good(fixture('B-oem-itrf.kvn'));
    // Legacy fields are deliberately contradictory: every present _HP wins.
    const precise={...reference.eop,UT1_MINUS_UTC_SECONDS:-.7,X_POLE_WANDER_RADIANS:1e-4,Y_POLE_WANDER_RADIANS:1e-4};
    const b=await screen(parsed['oem-itrf.kvn'],fixedB,[precise,{...precise,MJD:53738}]);
    close(a.TCA.JULIAN_DATE,b.TCA.JULIAN_DATE,2e-3/86400,'catalog TCA');close(a.MISS_DISTANCE_M,b.MISS_DISTANCE_M,.001,'catalog miss');
    close(a.PROBABILITY.PROBABILITY,b.PROBABILITY.PROBABILITY,a.PROBABILITY.PROBABILITY*1e-5,'catalog Pc');
    const missing=await assess(parsed['oem-itrf.kvn'],secondary,{eops:[{MJD:53737}]});assert.equal(missing.r.errorCode,'invalid-eop');
  });
  for (const c of reference.precision_cases) await t.test(`${c.name}: ERFA epoch precision preserves 1 mm`,async()=>{
    const a=structuredClone(parsed['oem-itrf.kvn']), b=structuredClone(a);
    for(const oem of [a,b]) for(const block of oem.EPHEMERIS_DATA_BLOCK) {delete block.COVARIANCE_MATRIX_LINES;delete block.COV_REFERENCE_FRAME;}
    a.EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES=[
      {EPOCH:c.start,X:7000,Y:0,Z:0,X_DOT:0,Y_DOT:0,Z_DOT:0},
      {EPOCH:c.stop,X:7000,Y:0,Z:0,X_DOT:0,Y_DOT:0,Z_DOT:0}];
    b.EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES=[
      {EPOCH:c.start,X:7100,Y:0,Z:0,X_DOT:1,Y_DOT:0,Z_DOT:0},
      {EPOCH:c.stop,X:7130,Y:0,Z:0,X_DOT:1,Y_DOT:0,Z_DOT:0}];
    const {r,event}=await assess(a,b,{frame:'GCRF',startJd:c.start_jd,durationSeconds:.00005,eops:[c.eop]});assert.equal(r.statusCode,0,r.errorMessage);
    const expected=c.grid.find(x=>x.jd===event.TCA.JULIAN_DATE);assert.ok(expected);
    for(let i=0;i<3;++i)close(vec(event.PRIMARY_STATE.STATE.POSITION)[i],expected.position_m[i],.0005,`${c.name} GCRF position[${i}]`);
  });
  await t.test('ITRF to GCRF independent ERFA known answer <=1 mm, including velocity',async()=>{
    const a=structuredClone(parsed['oem-itrf.kvn']),b=structuredClone(a);
    for(const oem of [a,b]) for(const block of oem.EPHEMERIS_DATA_BLOCK) {delete block.COVARIANCE_MATRIX_LINES;delete block.COV_REFERENCE_FRAME;}
    // The positions/velocities are literal synthetic inputs. The secondary
    // begins 100 km farther out, receding at 1 km/s, so TCA is the left endpoint.
    a.EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES=[
      {EPOCH:'2006-01-02T00:00:00Z',X:7000,Y:0,Z:0,X_DOT:0,Y_DOT:0,Z_DOT:0},
      {EPOCH:'2006-01-02T00:00:30Z',X:7000,Y:0,Z:0,X_DOT:0,Y_DOT:0,Z_DOT:0}];
    b.EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES=[
      {EPOCH:'2006-01-02T00:00:00Z',X:7100,Y:0,Z:0,X_DOT:1,Y_DOT:0,Z_DOT:0},
      {EPOCH:'2006-01-02T00:00:30Z',X:7130,Y:0,Z:0,X_DOT:1,Y_DOT:0,Z_DOT:0}];
    const {r,event}=await assess(a,b,{frame:'GCRF',startJd:reference.start_jd,durationSeconds:.00005});assert.equal(r.statusCode,0,r.errorMessage);
    close(event.TCA.JULIAN_DATE,reference.start_jd,2e-3/86400,"endpoint TCA");
    const expected=reference.gcrf_grid.find(x=>x.jd===event.TCA.JULIAN_DATE);assert.ok(expected);
    for(let i=0;i<3;++i) {
      close(vec(event.PRIMARY_STATE.STATE.POSITION)[i],expected.position_m[i],.0005,`ERFA GCRF position[${i}]`);
      close(vec(event.PRIMARY_STATE.STATE.VELOCITY)[i],expected.velocity_m_s[i],1e-6,`ERFA GCRF velocity[${i}]`);
    }
  });
});

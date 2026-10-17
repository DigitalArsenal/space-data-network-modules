import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,generateKeyPairSync,sign,verify} from 'node:crypto';
import * as fb from 'flatbuffers';
import * as slp from 'spacedatastandards.org/lib/js/SLP/main.js';
import * as pss from 'spacedatastandards.org/lib/js/PSS/main.js';
import * as oem from 'spacedatastandards.org/lib/js/OEM/main.js';
import {RFMT} from 'spacedatastandards.org/lib/js/RFM/main.js';
import {timingStandard} from 'spacedatastandards.org/lib/js/TIM/main.js';
import {createBrowserModuleHarness} from 'space-data-module-sdk/host/browser-module';
import {encodeContext,decodeContext,typeRef,units} from '../codec.mjs';
import {createSigningServer} from './wasmedge-signing-host.mjs';
import {encodeGridRequest} from '../../lambert-izzo/grid-codec.js';

const repo=fileURLToPath(new URL('../../../',import.meta.url));
const starRoot=path.join(repo,'maneuver/star-search');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const hashes={
  'de440s.bsp':'c1c7feeab882263fc493a9d5a5b2ddd71b54826cdf65d8d17a76126b260a49f2',
  'gm_de440.tpc':'924ddf4fb9ead9fe8a1aa55780bcabde40b09d00065d58226e24b68d8092f140',
};
const frame=(portId,id,payload)=>({portId,typeRef:{schemaName:id==='OEM'?'OEM/main.fbs':`${id}.fbs`,fileIdentifier:`$${id}`,rootTypeName:id},payload});
const entry=(value,unit=units.DIMENSIONLESS)=>({value,unit});
const strings=o=>Object.fromEntries(Object.entries(o).map(([k,v])=>[k,entry(v,units.UNSPECIFIED)]));
const success=r=>{assert.equal(r.statusCode,0,`${r.errorCode}: ${r.errorMessage}`);return r;};
async function kernel(name) {
  const dir=process.env.MISSION_SCREENING_KERNEL_DIR??fileURLToPath(new URL('data/',import.meta.url));
  const file=path.join(dir,name);let bytes;
  try{bytes=await fs.readFile(file);}catch(error){
    if(error.code!=='ENOENT')throw error;
    const base='https://naif.jpl.nasa.gov/pub/naif/generic_kernels/';
    const response=await fetch(base+(name.endsWith('.bsp')?'spk/planets/':'pck/')+name);
    assert.equal(response.ok,true,`Download ${name}`);bytes=Buffer.from(await response.arrayBuffer());
    assert.equal(sha(bytes),hashes[name]);await fs.mkdir(dir,{recursive:true});await fs.writeFile(file,bytes);
  }
  assert.equal(sha(bytes),hashes[name]);return bytes;
}
function canonicalPss(p) {
  return JSON.stringify({SOLUTION_SET_ID:p.SOLUTION_SET_ID,PROBLEM_ID:p.PROBLEM_ID,OBJECTIVE_IDS:p.OBJECTIVE_IDS,
    SOLUTIONS:p.SOLUTIONS.map(s=>({SOLUTION_ID:s.SOLUTION_ID,STATUS:'FEASIBLE',VARIABLES:s.VARIABLES.map(v=>({VARIABLE_ID:v.VARIABLE_ID,VALUE:v.VALUE})),
      OBJECTIVES:s.OBJECTIVES.map(v=>({OBJECTIVE_ID:v.OBJECTIVE_ID,VALUE:v.VALUE})),DOMINANCE_RANK:0,CROWDING_DISTANCE:0,VERIFY_BY_PROPAGATION_RESIDUAL:0,
      PROVENANCE:{SOLVER_MODULE_ID:s.PROVENANCE.SOLVER_MODULE_ID,SOLVER_MODULE_VERSION:s.PROVENANCE.SOLVER_MODULE_VERSION,
        SOURCE_SDS_TYPE:s.PROVENANCE.SOURCE_SDS_TYPE,SOURCE_RECORD_ID:s.PROVENANCE.SOURCE_RECORD_ID,CREATED_AT:s.PROVENANCE.CREATED_AT}})),
    GENERATED_AT:p.GENERATED_AT,ATTESTATION:{SIGNING_PUBLIC_KEY:p.ATTESTATION.SIGNING_PUBLIC_KEY,SIGNED_AT:p.ATTESTATION.SIGNED_AT}});
}

test('DE440 → Lambert PCE → mission budgets; typed ballistic Star → signed PSS', {timeout:600000}, async t=>{
  const harnesses=[];t.after(async()=>{for(const h of harnesses.reverse())await h.destroy();});
  async function load(module,options={}) {
    const bytes=await fs.readFile(path.join(repo,module,'dist/isomorphic/module.wasm'));
    const h=await createBrowserModuleHarness({wasmSource:bytes,surface:'direct',maxThreads:1,wasiThreadPoolSize:1,...options});harnesses.push(h);return h;
  }
  const lambert=await load('analysis/lambert-izzo'),screen=await load('analysis/mission-screening');
  const ssb=await load('propagator/solar-system-bodies'),x=ssb.instance.exports;
  for(const name of Object.keys(hashes)) {const bytes=await kernel(name),p=x.plugin_alloc(bytes.length);new Uint8Array(ssb.memory.buffer,p,bytes.length).set(bytes);assert.ok(x.ssb_load_kernel(p,bytes.length)>=0);x.plugin_free(p,bytes.length);}
  const idp=x.plugin_alloc(4),out=x.plugin_alloc(48),statusp=x.plugin_alloc(4),evidence={grids:[],states:[]};
  function states(body,epochs) {
    const result={epochs,positions:[],velocities:[]};
    for(const et of epochs) {new Int32Array(ssb.memory.buffer,idp,1)[0]=body;x.ssb_states(et,idp,1,10,out,statusp);assert.equal(new Int32Array(ssb.memory.buffer,statusp,1)[0],0);
      const state=Array.from(new Float64Array(ssb.memory.buffer,out,6));result.positions.push(state.slice(0,3));result.velocities.push(state.slice(3));evidence.states.push({body,et,state});}
    return result;
  }
  const epoch=date=>(Date.parse(date+'T00:00:00Z')-Date.parse('2000-01-01T12:00:00Z'))/1000;
  const axis=(a,b)=>Array.from({length:(epoch(b)-epoch(a))/86400+1},(_,i)=>epoch(a)+i*86400);
  const windows=[['2026','2026-08-01','2026-12-31','2027-03-01','2028-02-01',51714,9.183497472],['2028','2028-09-01','2029-03-01','2029-04-01','2030-03-01',60970,8.995375526]];
  let total=0;
  for(const [year,ds,de,as,ae,count,c3] of windows) {
    const departure=states(399,axis(ds,de)),arrival=states(4,axis(as,ae));
    const query={departure,arrival,departureStart:epoch(ds),departureEnd:epoch(de),arrivalStart:epoch(as),arrivalEnd:epoch(ae),step:86400,mu:1.3271244004127942e20,
      maxRevolutions:0,prograde:true,referenceFrame:'ICRF',timeScale:'TDB',epochOrigin:'2000-01-01T12:00:00'};
    const mesh=success(await lambert.invoke(encodeGridRequest(query))).outputs.filter(f=>f.portId==='mesh');
    const config={...strings({ephemeris:'DE440s; Earth 399 / Mars barycenter 4',center:'SUN (NAIF 10)',reference_frame:'ICRF',time_scale:'TDB',epoch_origin:query.epochOrigin,
      provenance:`de440s.bsp sha256:${hashes['de440s.bsp']}`,objective:'departure_c3'}),
      departure_mu:entry(3.9860043550702266e14,units.PROVIDER_DEFINED),arrival_mu:entry(4.282837362069909e13,units.PROVIDER_DEFINED),
      departure_parking_radius:entry(6778008.366666666,units.METRE),arrival_parking_radius:entry(3789526.6666666665,units.METRE),
      grid_step:entry(86400,units.SECOND),page_offset:entry(0),page_size:entry(160000),cancelled:entry(0)};
    async function evaluate(overrides={}) {return success(await screen.invoke({methodId:'screen_grid',inputs:[...mesh,{portId:'request',typeRef,payload:encodeContext({...config,...overrides})}]}));}
    const r=await evaluate(),rows=r.outputs.filter(f=>f.portId==='mesh').map(f=>decodeContext(f.payload).values),best=decodeContext(r.outputs.find(f=>f.portId==='best').payload).values;
    assert.equal(rows.reduce((n,r)=>n+r.status.length,0),count);assert.ok(rows.every(r=>r.status.every(v=>v===0)));
    assert.ok(Math.abs(best.departure_c3/1e6-c3)<0.001);assert.equal(best.objective,'departure_c3');assert.ok(best.parking_injection>0&&best.capture>0);
    assert.notEqual(best.total_impulse,best.sum_vinf);assert.equal(best.total_impulse,best.parking_injection+best.capture);assert.equal(best.flyby_impulse,0);
    const page=await evaluate({page_offset:entry(17),page_size:entry(7)}),paged=page.outputs.filter(f=>f.portId==='mesh').flatMap(f=>decodeContext(f.payload).values.cell_index);
    assert.deepEqual(paged,[17,18,19,20,21,22,23]);assert.equal(decodeContext(page.outputs.find(f=>f.portId==='best').payload).values.departure_c3,best.departure_c3);
    const cancelled=await evaluate({cancelled:entry(1)});assert.equal(cancelled.outputs.length,1);assert.equal(decodeContext(cancelled.outputs[0].payload).values.cancelled,1);
    const arrivalResult=await evaluate({objective:entry('arrival_vinf',units.UNSPECIFIED),page_size:entry(1)});
    const arrivalBest=decodeContext(arrivalResult.outputs.find(f=>f.portId==='best').payload).values;
    assert.ok(Math.abs(arrivalBest.arrival_vinf-(year==='2026'?2563.987232:2965.950544))<0.00001);
    assert.notEqual(arrivalBest.cell_index,best.cell_index);
    if(year==='2026') {
      const invalid=success(await lambert.invoke(encodeGridRequest({...query,arrival:departure,
        departureEnd:query.departureStart+86400,arrivalStart:query.departureStart,arrivalEnd:query.departureStart}))).outputs.filter(f=>f.portId==='mesh');
      const invalidResult=success(await screen.invoke({methodId:'screen_grid',inputs:[...invalid,{portId:'request',typeRef,payload:encodeContext(config)}]}));
      const cells=invalidResult.outputs.filter(f=>f.portId==='mesh').map(f=>decodeContext(f.payload).values);
      assert.ok(cells.every(c=>c.status.every(s=>s===1)&&c.departure_c3.every(Number.isNaN)));
      assert.equal(decodeContext(invalidResult.outputs.find(f=>f.portId==='best').payload).values.result_status,'no-valid-cells');
    }
    evidence.grids.push({year,cells:count,query,best});total+=count;t.diagnostic(`${year}: ${count} cells, C3=${best.departure_c3/1e6} km²/s²`);
  }
  assert.equal(total,112684);x.plugin_free(idp,4);x.plugin_free(out,48);x.plugin_free(statusp,4);
  if(process.env.MISSION_SCREENING_EVIDENCE)await fs.writeFile(process.env.MISSION_SCREENING_EVIDENCE,JSON.stringify(evidence));

  const {privateKey,publicKey}=generateKeyPairSync('ed25519'),publicHex=publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('hex');
  let signatures=0;
  const star=await createSigningServer(path.join(starRoot,'dist/isomorphic/module.wasm'),(params,payload)=>{assert.equal(params.SLOT_ID,'e2e-ephemeral');signatures++;return sign(null,payload,privateKey);});harnesses.push(star);
  const raw=await fs.readFile(path.join(starRoot,'tests/vectors/test2_EMEJ.ephem'));
  let offset=24;const constants={},blocks=[];
  const toIso=et=>{const whole=Math.floor(et),fraction=(et-whole).toFixed(9).slice(2);return new Date(Date.UTC(2000,0,1,12)+whole*1000).toISOString().slice(0,19)+'.'+fraction;};
  for(let body=0;body<raw.readUInt32LE(12);body++) {
    const id=raw.readInt32LE(offset),gm=raw.readDoubleLE(offset+8),radius=raw.readDoubleLE(offset+16),n=Number(raw.readBigUInt64LE(offset+24));offset+=32;
    constants[`body.${id}.gm_km3_s2`]=gm;constants[`body.${id}.radius_km`]=radius;
    const b=new oem.ephemerisDataBlockT();b.OBJECT_NAIF_ID=id;b.CENTER_NAIF_ID=10;b.CENTER_NAME='SUN';b.REFERENCE_FRAME=Object.assign(new RFMT(),{NAME:'ECLIPJ2000'});b.TIME_SYSTEM=timingStandard.TDB;
    b.EPHEMERIS_DATA_LINES=[];
    for(let i=0;i<n;i++){const v=Array.from({length:7},(_,j)=>raw.readDoubleLE(offset+j*8));offset+=56;
      b.EPHEMERIS_DATA_LINES.push(Object.assign(new oem.ephemerisDataLineT(),{EPOCH:toIso(v[0]),X:v[1],Y:v[2],Z:v[3],X_DOT:v[4],Y_DOT:v[5],Z_DOT:v[6]}));}
    blocks.push(b);
  }
  const source=Object.assign(new oem.OEMT(),{EPHEMERIS_DATA_BLOCK:blocks,MESSAGE_ID:`upstream-5c66706/test2_EMEJ/sha256:${sha(raw)}`});
  const ob=new fb.Builder(500000);oem.OEM.finishOEMBuffer(ob,source.pack(ob));
  const vars={...constants,threads:1};
  const lines=(await fs.readFile(path.join(starRoot,'tests/vectors/test2_EMEJ.problem'),'utf8')).split('\n').filter(l=>l.includes(' = '));
  for(const line of lines){const [k,s]=line.split(' = '),list=s.split(',').map(s=>s==='inf'?Infinity:s==='-inf'?-Infinity:Number(s));
    const vector=k==='tfilter_dt_s'||/^(null_legs|resonant_legs|dv_lev_max_km_s|delta_dv_lev_km_s|lambert_nrev_max|lambert_hz|vinf_margin_pre_filter_km_s)$/.test(k)||/stage\.\d+\.(bodies|altitude_km)/.test(k);
    if(vector)list.forEach((v,i)=>{vars[`${k}.${i}`]=v;});else vars[k]=list[0];
    if(/stage\.\d+\.bodies/.test(k))vars[k.replace('bodies','body_count')]=list.length;
  }
  const when='2026-10-17T00:00:00Z';
  const problem=new slp.SLPT();problem.PROBLEM_ID='upstream-test2-EMEJ';problem.PROPAGATOR_PORT_ID='ephemeris';
  problem.KIND=slp.slpProblemKind.OPTIMIZE;
  problem.OBJECTIVE=Object.assign(new slp.SLPObjectiveT(),{OBJECTIVE_ID:'star_patch_total_m_s',PROVIDER_DEFINED_PARAMETER_NAME:'star_patch_total_m_s',DIRECTION:slp.slpObjectiveDirection.MINIMIZE});
  problem.VARIABLES=Object.entries(vars).filter(([,v])=>Number.isFinite(v)).map(([id,value])=>Object.assign(new slp.SLPVariableT(),{VARIABLE_ID:id,PROVIDER_DEFINED_PARAMETER_NAME:id,INITIAL_VALUE:value}));
  // Use the ratified enum rather than assuming its provider-defined numeric value.
  const {pceParameter}=await import('spacedatastandards.org/lib/js/PCE/main.js');for(const v of problem.VARIABLES)v.PARAMETER=pceParameter.PROVIDER_DEFINED;problem.OBJECTIVE.PARAMETER=pceParameter.PROVIDER_DEFINED;
  problem.ATTESTATION=new slp.SLPAttestationT(publicHex,when,Array(64).fill(0),Array(64).fill(0));
  const sb=new fb.Builder(20000);slp.SLP.finishSizePrefixedSLPBuffer(sb,problem.pack(sb));const signed=sb.asUint8Array();
  const at=slp.SLP.getSizePrefixedRootAsSLP(new fb.ByteBuffer(signed)).ATTESTATION();const canonicalProblem=JSON.stringify(problem,(k,v)=>{
    if(k==='SIGNATURE'||k==='CANONICAL_JSON_SIGNATURE'||v===null)return undefined;
    if(k==='PARAMETER')return pceParameter[v];
    if(k==='KIND')return slp.slpProblemKind[v];
    if(k==='DIRECTION')return slp.slpObjectiveDirection[v];
    return v;
  });
  const binary=sign(null,signed,privateKey),json=sign(null,Buffer.from(canonicalProblem),privateKey);
  assert.ok(verify(null,Buffer.from(canonicalProblem),publicKey,json));
  assert.ok(verify(null,signed,publicKey,binary));at.signatureArray().set(binary);at.canonicalJsonSignatureArray().set(json);
  const context={...strings({signing_slot:'e2e-ephemeral',signing_public_key:publicHex,generated_at:when,ephemeris:'Upstream Star fixture; SPICE planetary states; ECLIPJ2000/TDB'}),page_offset:entry(0),page_size:entry(1000),cancelled:entry(0)};
  const response=success(await star.invoke({methodId:'search_trajectories',inputs:[frame('problem','SLP',signed),frame('ephemeris','OEM',ob.asUint8Array()),frame('request','PCE',encodeContext(context))]}));
  const payload=response.outputs.find(f=>f.portId==='solutions').payload,ps=pss.PSS.getSizePrefixedRootAsPSS(new fb.ByteBuffer(payload)).unpack();
  assert.equal(signatures,2);assert.equal(ps.SOLUTIONS.length,33);
  const signedPss=Buffer.from(payload),pa=pss.PSS.getSizePrefixedRootAsPSS(new fb.ByteBuffer(signedPss)).ATTESTATION();pa.signatureArray().fill(0);pa.canonicalJsonSignatureArray().fill(0);
  assert.ok(verify(null,signedPss,publicKey,Buffer.from(ps.ATTESTATION.SIGNATURE)),'binary PSS signature');
  assert.ok(verify(null,Buffer.from(canonicalPss(ps)),publicKey,Buffer.from(ps.ATTESTATION.CANONICAL_JSON_SIGNATURE)),'canonical JSON PSS signature');
  const reference=(await fs.readFile(path.join(starRoot,'tests/vectors/reference/test2_EMEJ.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);let maxDv=0;
  for(let i=0;i<reference.length;i++) {
    const ref=reference[i],solution=ps.SOLUTIONS[i],v=Object.fromEntries(solution.VARIABLES.map(v=>[v.VARIABLE_ID,v.VALUE])),o=Object.fromEntries(solution.OBJECTIVES.map(v=>[v.OBJECTIVE_ID,v.VALUE]));
    assert.equal(solution.SOLUTION_ID,String(ref.traj_id));for(let j=0;j<ref.t_et_s.length;j++)assert.ok(Math.abs(v[`epoch_tdb_s.${j}`]-ref.t_et_s[j])<1e-6);
    const residual=Math.abs(o.star_patch_total_m_s/1000-ref.dv_total_km_s);assert.ok(residual<1e-8);maxDv=Math.max(maxDv,residual);
    assert.ok(o.parking_injection_m_s>o.star_escape_excess_m_s);assert.ok(o.capture_m_s>o.star_insertion_excess_m_s);
    assert.equal(o.total_impulse_m_s,o.parking_injection_m_s+o.flyby_impulse_m_s+o.capture_m_s);
  }
  const report=decodeContext(response.outputs.find(f=>f.portId==='report').payload).values;assert.equal(report.total_solutions,33);assert.equal(report.reference_frame,'ECLIPJ2000');
  const starInputs=[frame('problem','SLP',signed),frame('ephemeris','OEM',ob.asUint8Array())];
  const page=success(await star.invoke({methodId:'search_trajectories',inputs:[...starInputs,frame('request','PCE',encodeContext({...context,page_offset:entry(5),page_size:entry(7)}))]}));
  const pageSet=pss.PSS.getSizePrefixedRootAsPSS(new fb.ByteBuffer(page.outputs.find(f=>f.portId==='solutions').payload)).unpack();
  assert.deepEqual(pageSet.SOLUTIONS.map(s=>s.SOLUTION_ID),ps.SOLUTIONS.slice(5,12).map(s=>s.SOLUTION_ID));
  const cancelled=success(await star.invoke({methodId:'search_trajectories',inputs:[...starInputs,frame('request','PCE',encodeContext({...context,cancelled:entry(1)}))]}));
  assert.equal(pss.PSS.getSizePrefixedRootAsPSS(new fb.ByteBuffer(cancelled.outputs.find(f=>f.portId==='solutions').payload)).solutionsLength(),0);
  assert.equal(decodeContext(cancelled.outputs.find(f=>f.portId==='report').payload).values.cancelled,1);
  const tampered=Uint8Array.from(signed),bad=slp.SLP.getSizePrefixedRootAsSLP(new fb.ByteBuffer(tampered)).ATTESTATION();bad.signatureArray()[0]^=1;
  const rejected=await star.invoke({methodId:'search_trajectories',inputs:[frame('problem','SLP',tampered),starInputs[1],frame('request','PCE',encodeContext(context))]});
  assert.notEqual(rejected.statusCode,0);assert.match(rejected.errorMessage,/signature verification failed/);assert.equal(rejected.outputs.length,0);
  evidence.star={rows:ps.SOLUTIONS.length,max_dv_difference_km_s:maxDv,report};t.diagnostic(`Star: 33 upstream rows; maximum patch Δv difference ${maxDv} km/s; both PSS signatures verified`);
  evidence.artifacts={};for(const module of ['analysis/mission-screening','maneuver/star-search','analysis/lambert-izzo','propagator/solar-system-bodies'])evidence.artifacts[module]=sha(await fs.readFile(path.join(repo,module,'dist/isomorphic/module.wasm')));
  if(process.env.MISSION_SCREENING_EVIDENCE)await fs.writeFile(process.env.MISSION_SCREENING_EVIDENCE,JSON.stringify(evidence));
});

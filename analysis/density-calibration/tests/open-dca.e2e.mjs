// Method E2E: the same WASM contract as the provider, independently checked
// against frozen E13 at the supplied origin/main reference checkout. Private
// derived arc inputs are read in place and never copied into this repository.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {Builder,ByteBuffer} from 'flatbuffers';
import * as S from 'spacedatastandards.org/lib/js/DCL/main.js';
import {createBrowserModuleHarness} from 'space-data-module-sdk/host/browser-module';
import {runtimeParity} from '../../../data-source/space-weather/tests/runtime-parity.mjs';
const reference=process.env.OPEN_DCA_ORACLE;
assert(reference,'OPEN_DCA_ORACLE must name a private, fetched origin/main E13 checkout');
const {solveCommonMode,arcCenterOffsetMs,sAt}=await import(pathToFileURL(path.join(reference,'experiments/e13-open-dca/common-mode.mjs')));
const sample=JSON.parse(await fs.readFile(path.join(reference,'experiments/e13-open-dca/planet-sample.json'))).calibration;
const bytes=await fs.readFile(process.env.OPEN_DCA_ARCS||'/opt/data/sdn-archive/e13-open-dca/planet-arcs/live-g24lean.jsonl');
const rows=bytes.toString().trim().split('\n').map(JSON.parse).filter(a=>a.atmosphere==='NRLMSISE00'&&sample.includes(a.hwid)&&a.cdAreaOverMass>0&&a.sigmaB/a.cdAreaOverMass<=0.5&&a.hours>=20&&a.hours<=28);
assert(rows.length>=60,'Need at least 60 genuine NRLMSISE-00 energy arc fits');
const H=3600000,D=24*H,issue=Math.max(...rows.map(a=>Date.parse(a.utcB)))+12*H,cutoff=issue-6*H;
const arcs=rows.map(a=>({dove:a.hwid,startMs:Date.parse(a.utcA),endMs:Date.parse(a.utcB),y:Math.log(a.cdAreaOverMass),B:a.cdAreaOverMass,sigma:a.sigmaB/a.cdAreaOverMass})).filter(a=>a.endMs<=cutoff&&a.startMs>=cutoff-30*D);
const anchorMs=Math.round(Math.floor(cutoff/D)*D+arcCenterOffsetMs(arcs));
const expected=solveCommonMode(arcs,{anchorMs,nodeHours:24,baseline:{kind:'randomWalk',stepSigma:0.005},smoothSigma:0.05,huberK:1.5,iterations:60,tolerance:1e-5,minDovesPerNode:6,minNodeInfo:1.5,scaleSweeps:8});
assert(expected.converged,'Frozen E13 oracle must converge on this evidence window');
const table=(name,value)=>Object.assign(new S[`${name}T`](),value);
const value=table('DCL',{CREATED_AT_MS:BigInt(issue),ATMOSPHERE:table('ATM',{MODEL:S.AtmosphericModelFamily.NRLMSIS00E}),OBJECTS:arcs.map(a=>table('dclObject',{ID:a.dove,FIRST_MS:BigInt(a.startMs),LAST_MS:BigInt(a.endMs),LN_B:a.y,LN_B_SIGMA:a.sigma,BALLISTIC_COEFFICIENT_M2_KG:a.B,OK:true}))});
const frame=v=>{const b=new Builder(1024);S.DCL.finishDCLBuffer(b,v.pack(b));return {portId:'request',typeRef:{schemaName:'DCL.fbs',fileIdentifier:'$DCL',rootTypeName:'DCL',wireFormat:'flatbuffer'},payload:b.asUint8Array().slice()};};
const root=fileURLToPath(new URL('../',import.meta.url)),wasmPath=path.join(root,'dist/isomorphic/module.wasm'),manifest=JSON.parse(await fs.readFile(path.join(root,'plugin-manifest.json')));
const harness=await createBrowserModuleHarness({wasmSource:await fs.readFile(wasmPath),manifest,surface:'direct'});
const evidence=await fs.mkdtemp(path.join(os.tmpdir(),'open-dca-method-'));
try {
 const request={methodId:'calibrate_log_density',inputs:[frame(value)]};
 const result=await harness.invoke(request);assert.equal(result.statusCode,0,result.errorMessage);assert.equal(result.outputs.length,1);
 const actual=S.DCL.getRootAsDCL(new ByteBuffer(result.outputs[0].payload)).unpack(),c=actual.CORRECTION;
 assert.equal(actual.STATUS,S.dclStatus.Solved);assert.equal(c.FORM,S.dclCorrectionForm.LogDensityNodes);assert.equal(actual.OBJECTS.length,0);assert.equal(actual.STATES,null);assert.equal(c.NODE_VALUES_K.length,0);assert(actual.PROVENANCE.ORIGINATOR.includes('CC BY-NC 4.0'));
 const first=expected.supported.indexOf(true),last=expected.supported.lastIndexOf(true);
 assert.equal(Number(actual.SETTINGS.TO_MS),expected.nodeMs[last]);assert.equal(c.NODE_TIMES_MS.length,last-first+1+48);
 let maxError=0;
 for(let i=0;i<c.NODE_TIMES_MS.length;i++){const t=Number(c.NODE_TIMES_MS[i]);const want=sAt(expected,t,48);maxError=Math.max(maxError,Math.abs(c.NODE_LOG_DENSITY_SCALE_DIMENSIONLESS[i]-want));}
 assert(maxError<2e-9,`Frozen E13 maximum log-density error ${maxError}`);
 assert.equal(actual.FIT.ITERATIONS,expected.sweeps);assert.equal(actual.FIT.CONVERGED,true);
 const invalid=table('DCL',{...value,ATMOSPHERE:table('ATM',{MODEL:S.AtmosphericModelFamily.JB08})});
 const stale=table('DCL',{...value,CREATED_AT_MS:BigInt(issue+20*D)});
 const cases=[request,{methodId:'calibrate_log_density',inputs:[frame(invalid)]},{methodId:'calibrate_log_density',inputs:[frame(stale)]}];
 for(const test of cases.slice(1)){const refused=await harness.invoke(test);assert.notEqual(refused.statusCode,0);assert.equal(refused.outputs.length,0);}
 await harness.destroy();
 const parity=await runtimeParity({wasmPath,manifest,cases,evidence});
 await fs.writeFile(path.join(evidence,'receipt.json'),JSON.stringify({status:'PASS',inputSha256:createHash('sha256').update(bytes).digest('hex'),arcs:arcs.length,fleet:new Set(arcs.map(a=>a.dove)).size,maxError,iterations:expected.sweeps,parity},null,2));
 console.log(`PASS E13 common mode: ${arcs.length} real energy arcs, ${expected.sweeps} iterations, max |delta ln rho|=${maxError}; browser/native byte parity; ${evidence}`);
} catch(error){await harness.destroy();throw error;}

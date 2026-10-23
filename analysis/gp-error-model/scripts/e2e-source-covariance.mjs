#!/usr/bin/env node
// One E2E: real typed records -> source covariance -> resident FFM, followed by
// byte parity in Chromium headless shell and native WasmEdge. Docker is waived.
// Oracle physics is C++ WASM. JS only encodes records, orchestrates, and scores.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as flatbuffers from 'flatbuffers';
import { compileModuleFromSource } from 'space-data-module-sdk/compiler';
import { createBrowserModuleHarness, normalizeParityFixture, runParityHarness } from 'space-data-module-sdk/testing';
import { generateSdsHeaders } from '../sds-headers.mjs';
import { composeErfaTranslationUnit } from '../../../foundation/frames/erfa-amalgamation.mjs';
const exec = promisify(execFile);
const here = fileURLToPath(new URL('../', import.meta.url));
const modules = path.resolve(here, '../..');
const require = createRequire(import.meta.url);
const sdsRoot = path.dirname(require.resolve('spacedatastandards.org/package.json'));
const schema = Object.fromEntries(await Promise.all(['OCM','OEM','CDM','PRW','ERM'].map(async code => [code,await import(pathToFileURL(path.join(sdsRoot,`lib/js/${code}/main.js`)))])));
const P=schema.PRW;
const make=(code,type,fields={})=>Object.assign(new schema[code][`${type}T`](),fields);
const table=(type,fields)=>make('PRW',type,fields);
const type=code=>({schemaName:`${code}.fbs`,fileIdentifier:`$${code}`,rootTypeName:code,wireFormat:'flatbuffer'});
function encode(code,fields) {const b=new flatbuffers.Builder(2048);schema[code][code][`finishSizePrefixed${code}Buffer`](b,make(code,code,fields).pack(b));return Buffer.from(b.asUint8Array());}
const decode=(code,payload)=>schema[code][code][`getSizePrefixedRootAs${code}`](new flatbuffers.ByteBuffer(new Uint8Array(payload))).unpack();
const frame=(portId,code,fields)=>({portId,typeRef:type(code),payload:encode(code,fields)});
const rootManifest=JSON.parse(await fs.readFile(path.join(here,'plugin-manifest.json')));
const cache=path.join(here,'.sdk-build/source-covariance');await fs.mkdir(cache,{recursive:true});
const wasmPath=path.join(here,'dist/isomorphic/module.wasm');
const wasm=await fs.readFile(wasmPath);
const sha=x=>createHash('sha256').update(x).digest('hex');
const oracleSource=await fs.readFile(path.join(here,'scripts/source-covariance-oracle.cpp'),'utf8');
const oraclePath=path.join(cache,'oracle.wasm');
const oracleManifest={...rootManifest,pluginId:'com.digitalarsenal.e2e.source-covariance-reference',name:'Source covariance independent reference',version:'1.0.0',
  description:'Test-only independent matrix congruence and SOFA/ERFA reference.',methods:[{methodId:'reference_covariances',inputPorts:[],outputPorts:[{...rootManifest.methods.find(m=>m.methodId==='source_covariance').outputPorts[1],portId:'reference'}],maxBatch:1,drainPolicy:'single-shot'}]};
const oracleKey=sha(oracleSource+JSON.stringify(oracleManifest));
if(await fs.readFile(path.join(cache,'oracle.key'),'utf8').catch(()=>null)!==oracleKey) {
  const [{header},erfa]=await Promise.all([generateSdsHeaders(['ERM'],import.meta.url),composeErfaTranslationUnit()]);
  await compileModuleFromSource({manifest:oracleManifest,sourceCode:['#include "space_data_module_invoke.h"','#include <cmath>',header,erfa.source,oracleSource].join('\n'),language:'c++',threadModel:'wasi-sequential',outputPath:oraclePath});
  await fs.writeFile(path.join(cache,'oracle.key'),oracleKey);
}
const oracle=await createBrowserModuleHarness({wasmSource:await fs.readFile(oraclePath),manifest:oracleManifest,surface:'direct'});
const or=await oracle.invoke({methodId:'reference_covariances',inputs:[]});oracle.destroy();assert.equal(or.statusCode,0,or.errorMessage);
const refs=Object.fromEntries(decode('ERM',or.outputs[0].payload).CALIBRATED_COVARIANCES.RESULTS.map(r=>[r.ID,r]));
const epoch='2020-01-01T00:00:00Z', later='2020-01-02T00:00:00Z', before='2019-12-31T23:59:00Z';
const instant=iso=>table('TIMInstant',{TIME_SYSTEM:P.timingStandard.UTC,EPOCH_FORMAT:P.timEpochRepresentation.ISO8601,ISO8601:iso});
const cs=()=>table('RFMCoordinateSystem',{NAME:'GCRF',AXIS_TYPE:P.rfmAxisType.ICRF,ORIGIN:table('RFMOrigin',{KIND:P.rfmOriginKind.CELESTIAL_BODY,CELESTIAL_BODY_ID:399})});
const instance=()=>table('PRWInstance',{MODULE_ID:'com.orbpro.ffm',INSTANCE_ID:'source-covariance-e2e',GENERATION:1n});
const vector=values=>table('FRMVector3',{X:values[0],Y:values[1],Z:values[2]});
function state(at=epoch) {return table('PRWResidentState',{INSTANCE:instance(),ENTITY_HANDLE:1,CATALOG_NUMBER:99999,OBJECT_ID:'synthetic-reference',
  STATE:table('FRMStateVector',{REPRESENTATION:P.frmStateRepresentation.CARTESIAN,POSITION:vector([7000000,0,0]),VELOCITY:vector([1200,7200,2400]),EPOCH:at,EPOCH_TIME_SYSTEM:'UTC',COORDINATE_SYSTEM_NAME:'GCRF'}),COORDINATE_SYSTEM:cs()});}
const eop=()=>table('PRWEarthOrientation',{ROWS:[58849,58850].map(MJD=>table('EOP',{MJD,X_POLE_WANDER_RADIANS:3.7e-7,Y_POLE_WANDER_RADIANS:1.4e-6,UT1_MINUS_UTC_SECONDS:-.1771554,TAI_MINUS_UTC_SECONDS:37}))});
function request(clock=epoch,at=epoch,earth=true) {return frame('request','PRW',{RESIDENT_STATE:state(at),RESIDENT_REQUEST:table('PRWResidentRequest',{INSTANCE:instance(),TARGET_EPOCH:instant(clock),TARGET_COORDINATE_SYSTEM:cs(),ENTITY_HANDLES:[1]}),...(earth?{EARTH_ORIENTATION:eop()}:{})});}
const rfm=(code,name)=>make(code,'RFM',{NAME:name});
function ocm(axes,epochs=[epoch],cov=refs.GCRF.COVARIANCE_RTN) {return frame('ocm','OCM',{
  METADATA:make('OCM','Metadata',{CATALOG_NAME:'99999',INTERNATIONAL_DESIGNATOR:'synthetic-reference',TIME_SYSTEM:'UTC',START_TIME:epochs[0]}),
  TRAJ_REF_FRAME:rfm('OCM','GCRF'),COV_REF_FRAME:rfm('OCM',axes),STATE_EPOCHS:epochs,STATE_VECTOR_SIZE:6,
  STATE_DATA:epochs.flatMap(()=>[7000,0,0,1.2,7.2,2.4]),COV_SIZE:6,COVARIANCE_DATA:epochs.flatMap(()=>cov)});}
const fields=['CX_X','CY_X','CY_Y','CZ_X','CZ_Y','CZ_Z','CX_DOT_X','CX_DOT_Y','CX_DOT_Z','CX_DOT_X_DOT','CY_DOT_X','CY_DOT_Y','CY_DOT_Z','CY_DOT_X_DOT','CY_DOT_Y_DOT','CZ_DOT_X','CZ_DOT_Y','CZ_DOT_Z','CZ_DOT_X_DOT','CZ_DOT_Y_DOT','CZ_DOT_Z_DOT'];
function oem(axes,epochs=[before,later],override=false) {return frame('oem','OEM',{EPHEMERIS_DATA_BLOCK:[make('OEM','ephemerisDataBlock',{
  OBJECT:make('OEM','CAT',{NORAD_CAT_ID:99999}),REFERENCE_FRAME:rfm('OEM','GCRF'),COV_REFERENCE_FRAME:rfm('OEM',override?'unsupported-sentinel':axes),TIME_SYSTEM:schema.OEM.timingStandard.UTC,
  COVARIANCE_MATRIX_LINES:epochs.map((EPOCH,i)=>make('OEM','covarianceMatrixLine',{EPOCH,...Object.fromEntries(fields.map((f,k)=>[f,refs.GCRF.COVARIANCE_RTN[k]])),...(override?{COV_REFERENCE_FRAME:rfm('OEM',axes)}:{})}))})]});}
const cdm=()=>frame('cdm','CDM',{TCA:epoch,OBJECT1:make('CDM','CDMObject',{OBJECT:make('CDM','CAT',{NORAD_CAT_ID:99999}),REFERENCE_FRAME:rfm('CDM','GCRF'),COVARIANCE:refs.GCRF.COVARIANCE_RTN})});
const harness=await createBrowserModuleHarness({wasmSource:wasm,manifest:rootManifest,surface:'direct'});
const cases=[];let worst=0,comparisonCount=0;
function close(a,b,label) {assert.equal(a.length,b.length,label);let scale=Math.max(...b.map(Math.abs));for(let i=0;i<a.length;++i) {const error=Math.abs(a[i]-b[i])/scale;assert(Number.isFinite(error),label);worst=Math.max(worst,error);assert(error<=1e-12,`${label} cell ${i}: ${a[i]} vs ${b[i]} rel=${error}`);}++comparisonCount;}
async function invoke(id,inputs,expected=null,reason=null) {
  const result=await harness.invoke({methodId:'source_covariance',inputs});
  cases.push({id,request:{methodId:'source_covariance',inputs:inputs.map(({payload,...r})=>({...r,payloadBase64:Buffer.from(payload).toString('base64')}))},expect:reason?'guest-error':'ok'});
  if(reason) {assert.notEqual(result.statusCode,0,id);assert.match(result.errorMessage,reason);return;}
  assert.equal(result.statusCode,0,`${id}: ${result.errorCode} ${result.errorMessage}`);
  const s=decode('PRW',result.outputs.find(f=>f.portId==='state').payload).RESIDENT_STATE;
  const report=decode('ERM',result.outputs.find(f=>f.portId==='report').payload).ATTACH_REPORT.OBJECTS[0];
  assert.equal(report.RULE,schema.ERM.covarianceRule.Operator);assert.equal(report.ROWS[0].BASIS,'OPERATOR');assert.equal(report.EPOCH,s.STATE.EPOCH);assert.equal(s.COVARIANCE.DIMENSION,6);assert.equal(s.PROCESS_NOISE,null);
  if(expected)close(s.COVARIANCE.VALUES,expected,id);
  return s;
}
try {
  for(const [axes,key] of Object.entries({GCRF:'GCRF',ICRF:'GCRF',RTN:'RTN',RSW:'RTN',RIC:'RTN',UVW:'RTN',RSW_INERTIAL:'RTN',TNW:'TNW',TNW_INERTIAL:'TNW',EME2000:'EME2000',TEME:'TEME',ITRF:'ITRF',ECEF:'ITRF'}))
    await invoke(`OCM-${axes}`,[ocm(axes),request()],refs[key].COVARIANCE_INERTIAL);
  await invoke('OEM-interior',[oem('RTN'),request()],refs.RTN.COVARIANCE_INERTIAL);
  await invoke('OEM-line-frame',[oem('TNW',[epoch],true),request()],refs.TNW.COVARIANCE_INERTIAL);
  await invoke('OCM-interior',[ocm('RTN',[before,later]),request()],refs.RTN.COVARIANCE_INERTIAL);
  await invoke('CDM-object',[cdm(),request(later)],refs.RTN.COVARIANCE_INERTIAL);
  await invoke('outside-span',[oem('RTN',[epoch,later]),request(before,before)],null,/outside covariance span/);
  await invoke('wrong-state-epoch',[ocm('RTN'),request(later,later)],null,/covariance epoch/);
  await invoke('missing-eop',[ocm('ITRF'),request(epoch,epoch,false)],null,/EARTH_ORIENTATION/);
  await invoke('unknown-frame',[ocm('invented-frame'),request()],null,/unsupported covariance frame/);
  const attached=await invoke('singleton-at-source-epoch',[ocm('RTN'),request(later)],refs.RTN.COVARIANCE_INERTIAL);
  assert.equal(attached.STATE.EPOCH,epoch);
  const ffmRoot=path.join(modules,'propagator/ffm');
  const ffmBytes=await fs.readFile(path.join(ffmRoot,'dist/isomorphic/module.wasm'));
  const ffmManifest=JSON.parse(await fs.readFile(path.join(ffmRoot,'dist/plugin-manifest.json')));
  const ffm=await createBrowserModuleHarness({wasmSource:ffmBytes,manifest:ffmManifest,surface:'direct'});
  try {
    const independent=state();independent.ENTITY_HANDLE=2;independent.COVARIANCE=table('PRWStateMatrix',{DIMENSION:6,VALUES:refs.RTN.COVARIANCE_INERTIAL});
    const ingest=await ffm.invoke({methodId:'ingest_state_gravity_only',inputs:[frame('state','PRW',{RESIDENT_STATE:attached}),frame('state','PRW',{RESIDENT_STATE:independent})]});
    assert.equal(ingest.statusCode,0,`FFM ingest: ${ingest.errorMessage}`);
    const propagated=await ffm.invoke({methodId:'propagate_state',inputs:[frame('request','PRW',{RESIDENT_REQUEST:table('PRWResidentRequest',{INSTANCE:instance(),TARGET_EPOCH:instant(later),TARGET_COORDINATE_SYSTEM:cs(),ENTITY_HANDLES:[1,2]})})]});
    assert.equal(propagated.statusCode,0,`FFM propagate: ${propagated.errorMessage}`);
    const results=propagated.outputs.map(f=>decode('PRW',f.payload).RESIDENT_STATE);assert.equal(results.length,2);
    close(results[0].COVARIANCE.VALUES,results[1].COVARIANCE.VALUES,'FFM resident 1 day composition');
    assert.notDeepEqual(results[0].COVARIANCE.VALUES,attached.COVARIANCE.VALUES,'FFM must actually carry covariance');
  } finally {ffm.destroy();}
  // Explicit headless-shell path prevents the SDK fallback from starting Chrome.
  if(!process.env.SDM_CHROME_BINARY) {
    const playwright=path.join(os.homedir(),'Library/Caches/ms-playwright');
    const dirs=(await fs.readdir(playwright)).filter(n=>n.startsWith('chromium_headless_shell-')).sort().reverse();
    for(const dir of dirs) {const candidate=path.join(playwright,dir,'chrome-headless-shell-mac-arm64/chrome-headless-shell');if(await fs.stat(candidate).catch(()=>false)){process.env.SDM_CHROME_BINARY=candidate;break;}}
  }
  assert(process.env.SDM_CHROME_BINARY?.includes('headless'), 'Set SDM_CHROME_BINARY to Chromium headless shell');
  process.env.PATH=path.join(os.homedir(),'.wasmedge/bin')+path.delimiter+process.env.PATH;
  const plan=await normalizeParityFixture({name:'source-covariance',threadCounts:[1],cases});
  const parity=await runParityHarness({wasmPath,plan,lanes:['browser','wasmedge'],surface:'direct'});
  await fs.writeFile(path.join(cache,'parity.json'),JSON.stringify(parity,null,2));assert(parity.ok,JSON.stringify(parity.failures));
  const nodeBinary=process.env.SDN_PREWARM_BINARY;
  assert(nodeBinary,'Set SDN_PREWARM_BINARY to the locally provisioned node binary (prewarm-aot, WasmEdge 0.16.4)');
  const aot=await exec(nodeBinary,['prewarm-aot','--cache-dir',path.join(cache,'aot'),'--flow',wasmPath],{maxBuffer:8*1024*1024,timeout:600000});
  await fs.writeFile(path.join(cache,'aot.log'),aot.stdout+aot.stderr);
  const result={ok:true,moduleSha256:sha(wasm),frames:Object.keys(refs),cases:cases.length,comparisonCount,worstRelativeError:worst,composition:'FFM resident gravity-only, 86400 s; no process noise',ffmSha256:sha(ffmBytes),parity:['headless-browser','native-WasmEdge-0.16.4'],docker:'waived by owner 2026-10-22',aot:'node prewarm-aot passed'};
  await fs.writeFile(path.join(cache,'result.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
} finally {harness.destroy();}

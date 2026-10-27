// E2E: public-fit covariance -> typed PRW -> native validation/propagation ->
// returned full covariance, in both runtime surfaces. Authority and SI units,
// epoch, frame and fixed tolerances are recorded in the independent fixture.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createBrowserModuleHarness} from 'space-data-module-sdk/host/browser-module';
import {loadModule} from 'space-data-module-sdk/host/isomorphic';
import {encodePluginManifest,decodePluginManifest} from 'space-data-module-sdk/manifest';
import {assertWasmEdgeVersionMatchesPin,loadWasmEdgePin} from 'space-data-module-sdk/testing';
import {makeTable,execution,encodePrw,decodePrw,TYPE,sds} from '../tests/lib/prwCodec.mjs';
const pkg=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const fixture=JSON.parse(fs.readFileSync(path.join(pkg,'tests/fixtures/covariance-scaling.json')));
const wasm=path.join(pkg,'dist/isomorphic/module.wasm');
assertWasmEdgeVersionMatchesPin(execFileSync('wasmedge',['--version'],{encoding:'utf8'}),loadWasmEdgePin(),'FFM covariance E2E');
// Verify every current declared port, including DCL/SHC. Earlier unit assertions
// that every port must be PRW predate those already-published typed inputs.
const manifest=JSON.parse(fs.readFileSync(path.join(pkg,'plugin-manifest.json')));
const encodedManifest=encodePluginManifest(manifest),decodedManifest=decodePluginManifest(encodedManifest);
assert.deepEqual(encodePluginManifest(decodedManifest),encodedManifest);
for(let i=0;i<manifest.methods.length;i++)for(const direction of ['inputPorts','outputPorts'])for(let j=0;j<manifest.methods[i][direction].length;j++){
  const wanted=manifest.methods[i][direction][j],actual=decodedManifest.methods[i][direction][j];
  assert.equal(actual.portId,wanted.portId);assert.equal(actual.acceptedTypeSets.length,wanted.acceptedTypeSets.length);
  for(let k=0;k<wanted.acceptedTypeSets.length;k++){
    const a=actual.acceptedTypeSets[k],w=wanted.acceptedTypeSets[k];assert.equal(a.setId,w.setId);assert.equal(a.allowedTypes.length,w.allowedTypes.length);
    for(let m=0;m<w.allowedTypes.length;m++)for(const field of ['schemaName','fileIdentifier','rootTypeName','wireFormat'])assert.equal(a.allowedTypes[m][field],w.allowedTypes[m][field]);
  }
}
const parameters=[sds.prwDynamicParameter.DRAG_AREA_OVER_MASS,sds.prwDynamicParameter.SRP_AREA_OVER_MASS];
function request(values,n=8,target=fixture.epochJD){
  const e=execution({epochJD:fixture.epochJD,targetJD:target,epochTimeScale:fixture.timeScale,targetTimeScale:fixture.timeScale,position:[7000,100,-50],velocity:[1,7,.4],includeSTM:true,
    forces:{centralBody:false,j2:false,thirdBody:false,srp:n===8,drag:n===8},
    ...(n===8?{weather:{F107:150,F107a:150,Ap:15}}:{}),
    integrator:{method:'RKF78',initialStep:60,minStep:1e-6,maxStep:600,absTolerance:1e-12,relTolerance:1e-12}});
  e.INITIAL_COVARIANCE=makeTable('PRWStateMatrix',{DIMENSION:n,VALUES:values});
  if(n===8)e.DYNAMIC_PARAMETERS=parameters;
  return{methodId:'invoke',inputs:[{portId:'request',typeRef:TYPE,payload:encodePrw('EXECUTION_REQUEST',e)}]};
}
function close(actual,expected,label){
  assert.equal(actual.length,expected.length);
  for(let i=0;i<actual.length;i++)assert.ok(Number.isFinite(actual[i])&&Math.abs(actual[i]-expected[i])<=fixture.tolerance.absoluteCovariance+fixture.tolerance.relativeCovariance*Math.abs(expected[i]),`${label}[${i}] ${actual[i]} != ${expected[i]}`);
}
const matrix=(n,diagonal)=>Array.from({length:n*n},(_,k)=>Math.floor(k/n)===k%n?diagonal[k%n]:0);
const results=[];
for(const runtimeKind of ['browser','wasmedge']){
  const host=runtimeKind==='browser'?await createBrowserModuleHarness({wasmSource:fs.readFileSync(wasm),surface:'direct'}):await loadModule({wasmSource:wasm,runtimeKind,enableThreads:true,cwd:pkg});
  let accepted=0,rejected=0;
  try{
    async function accept(values,n=8,target=fixture.epochJD,expected=values){
      const r=await host.invoke(request(values,n,target));assert.equal(r.statusCode,0,`${r.errorCode}: ${r.errorMessage}`);
      const decoded=decodePrw(r.outputs.find(o=>o.portId==='response').payload).EXECUTION_RESULT;
      assert.ok(decoded);const last=decoded.FINAL_SAMPLE;assert.ok(last);
      assert.equal(last.COVARIANCE.DIMENSION,n);close(last.COVARIANCE.VALUES,expected,`${runtimeKind} full covariance`);accepted++;return last;
    }
    await accept(fixture.initialCovariance);
    const six=p=>Array.from({length:36},(_,k)=>p[Math.floor(k/6)*8+k%6]);
    const propagated=await accept(six(fixture.initialCovariance),6,fixture.targetJD,six(fixture.expectedCovarianceAfter10800Seconds));
    const p=propagated.STATE.STATE.POSITION;
    for(const [i,k]of ['X','Y','Z'].entries())assert.ok(Math.abs(p[k]-[17800000,75700000,4270000][i])<=fixture.tolerance.positionM);
    // Same correlation structure, very different unit/variance scales.
    const scaling=[1e-5,1e3,1e-2,1e4,1e-4,1e2,1e-6,1e5];
    await accept(fixture.initialCovariance.map((v,k)=>v*scaling[Math.floor(k/8)]*scaling[k%8]));
    await accept(matrix(6,[1e-20,1e12,1,1e-22,1e-5,0]),6);
    const rankOne=Array.from({length:36},(_,k)=>[1,2,0,1e-10,3,0][Math.floor(k/6)]*[1,2,0,1e-10,3,0][k%6]);
    await accept(rankOne,6);
    for(const mutate of [
      p=>{p[0]=-1e-30;},
      p=>{p[0]=0;p[1]=p[6]=1e-30;},
      p=>{p[0]=p[7]=1e-20;p[1]=p[6]=2e-20;},
      p=>{p[0]=p[7]=1e-20;p[1]=.5e-20;},
      p=>{p[0]=NaN;},
    ]){
      const input=matrix(6,[1,1,1,1,1,1]);mutate(input);const r=await host.invoke(request(input,6));assert.notEqual(r.statusCode,0);assert.match(`${r.errorCode}: ${r.errorMessage}`,/invalid-covariance/);rejected++;
    }
    await accept(fixture.initialCovariance); // invalid input must not poison the instance
    results.push({runtimeKind,accepted,rejected});
  }finally{await host.destroy();}
}
console.log(JSON.stringify({status:'PASS',authority:fixture.authority,tolerance:fixture.tolerance,results},null,2));

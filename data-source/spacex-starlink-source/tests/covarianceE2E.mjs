// Authority: SpaceX's published Modified ITC example (fixture provenance).
// No orbital computation in this host: compare source tokens exactly, then
// exercise independent native CA parsing and the built conjunction consumer.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {ByteBuffer} from 'flatbuffers';
import {OEM} from 'spacedatastandards.org/lib/js/OEM/main.js';
import {createBrowserModuleHarness} from 'space-data-module-sdk/host/browser-module';
import {loadModule} from 'space-data-module-sdk/host/isomorphic';
import {encodeHttpResponse,decodeHttpRequest,decodeFlowNotice} from 'space-data-module-sdk/runtime-contracts';
import {createConjunctionCommandHarness} from '../../../analysis/conjunction-assessment/tests/lib/conjunctionCommandHarness.mjs';
import {buildNativeWasiThreadsRunner} from '../../../analysis/conjunction-assessment/tests/lib/wasmedgeWasiThreadsRunner.mjs';
import {initCqrFlatc,publishedSchema,stringifyFlatcJson,parseFlatcJson,encodeCqr,decodeCqr,pairRequest,earthFrame,utcJd} from '../../../analysis/conjunction-assessment/tests/lib/cqr.mjs';
const pkg=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),artifact=path.join(pkg,'dist/isomorphic/module.wasm');
const text=fs.readFileSync(path.join(pkg,'tests/fixtures/itc-authority/spacex-published-example.txt'),'utf8');
const provenance=JSON.parse(fs.readFileSync(path.join(pkg,'tests/fixtures/itc-authority/provenance.json')));
assert.equal(createHash('sha256').update(text).digest('hex'),provenance.excerptSha256);
const covFields=['CX_X','CY_X','CY_Y','CZ_X','CZ_Y','CZ_Z','CX_DOT_X','CX_DOT_Y','CX_DOT_Z','CX_DOT_X_DOT','CY_DOT_X','CY_DOT_Y','CY_DOT_Z','CY_DOT_X_DOT','CY_DOT_Y_DOT','CZ_DOT_X','CZ_DOT_Y','CZ_DOT_Z','CZ_DOT_X_DOT','CZ_DOT_Y_DOT','CZ_DOT_Z_DOT'];
const pv=['X','Y','Z','X_DOT','Y_DOT','Z_DOT'];
const unpack=b=>OEM.getRootAsOEM(new ByteBuffer(b)).unpack();
const fixture=name=>fs.readFileSync(path.resolve(pkg,'../../analysis/conjunction-assessment/tests/fixtures/ephemeris-upload',name),'utf8');
const reference=JSON.parse(fixture('reference.json'));
const hr=(portId,url,body,context,status=200)=>({portId,typeRef:{schemaName:'HttpResponse.fbs',fileIdentifier:'HRSP',rootTypeName:'HttpResponse',wireFormat:'flatbuffer'},payload:encodeHttpResponse({url,status,body:Buffer.from(body),context,retrievedMs:0})});
const ok=r=>{assert.equal(r.statusCode,0,`${r.errorCode}: ${r.errorMessage}`);return r;};
function checkTokens(block,source){
  const lines=source.trimEnd().split(/\r?\n/),n=(lines.length-4)/4;assert.equal(n,Math.floor(n));
  assert.equal(block.EPHEMERIS_DATA_LINES.length,n);assert.equal(block.COVARIANCE_MATRIX_LINES.length,n);
  assert.equal(block.REFERENCE_FRAME.NAME,'EME2000');assert.equal(block.COV_REFERENCE_FRAME.NAME,lines[3]);assert.equal(block.TIME_SYSTEM,11);
  for(let i=0;i<n;i++){
    const a=lines[4+4*i].trim().split(/\s+/),expected=lines.slice(5+4*i,8+4*i).flatMap(x=>x.trim().split(/\s+/).map(Number));
    assert.deepEqual(pv.map(k=>block.EPHEMERIS_DATA_LINES[i][k]),a.slice(1).map(Number));
    assert.deepEqual(covFields.map(k=>block.COVARIANCE_MATRIX_LINES[i][k]),expected);
    assert.equal(block.COVARIANCE_MATRIX_LINES[i].EPOCH,block.EPHEMERIS_DATA_LINES[i].EPOCH);
  }
}
const results=[];
for(const runtimeKind of ['browser','wasmedge']){
  const host=runtimeKind==='browser'?await createBrowserModuleHarness({wasmSource:fs.readFileSync(artifact),surface:'direct'}):await loadModule({wasmSource:artifact,runtimeKind,wasmEdgeBinary:await buildNativeWasiThreadsRunner(),cwd:pkg});
  const ca=await createConjunctionCommandHarness({runtimeKind});
  try{
    const name='MEME_25544_AUTHORITY_0000000_Operational_0_UNCLASSIFIED.txt';
    const selected=ok(await host.invoke({methodId:'select_objects',inputs:[hr('manifest','https://api.starlink.com/public-files/ephemerides/MANIFEST.txt',name+'\n')]}));
    const jobs=selected.outputs.filter(x=>x.portId==='requests').map(x=>decodeHttpRequest(x.payload));assert.equal(jobs.length,1);
    async function emit(body,status=200){const r=ok(await host.invoke({methodId:'emit',inputs:[hr('ephemerides',jobs[0].url,body,jobs[0].context,status)]}));return {bytes:r.outputs.find(x=>x.portId==='oem')?.payload,notices:r.outputs.filter(x=>x.portId==='status').map(x=>decodeFlowNotice(x.payload))};}
    const raw=await emit(text);assert.ok(raw.bytes);const block=unpack(raw.bytes).EPHEMERIS_DATA_BLOCK[0];checkTokens(block,text);
    assert.equal(block.EPHEMERIS_DATA_LINES[0].EPOCH,'2024-02-19T15:17:42.000Z');
    assert.equal(block.OBJECT.NORAD_CAT_ID,25544);
    const sameFrame=text.replace('\nUVW\n','\nEME2000\n');checkTokens(unpack((await emit(sameFrame)).bytes).EPHEMERIS_DATA_BLOCK[0],sameFrame);
    // Explicitly nonuniform epochs must not be replaced by the header grid.
    const original=text.trimEnd().split('\n'),gap=[...original.slice(0,8),...original.slice(12)].join('\n')+'\n';
    const g=unpack((await emit(gap)).bytes).EPHEMERIS_DATA_BLOCK[0];assert.equal(g.EPHEMERIS_DATA_LINES[1].EPOCH,'2024-02-19T15:19:42.000Z');
    const emptyCov=original.filter((x,i)=>i<4||(i-4)%4===0).join('\n')+'\n';
    const no=unpack((await emit(emptyCov)).bytes).EPHEMERIS_DATA_BLOCK[0];assert.equal(no.COVARIANCE_MATRIX_LINES.length,0);assert.equal(no.COV_REFERENCE_FRAME,null);
    for(const changed of [text.replace('\nUVW\n','\nUNKNOWN\n'),text.replace('4.8636600485e-07','NaN'),text.replace('4.8636600485e-07','1.2junk'),original.slice(0,-1).join('\n')+'\n',text.replace('2024050151842.000','2024050151742.000')]){
      const bad=await emit(changed);assert.equal(bad.bytes,undefined);assert.ok(bad.notices.some(x=>x.kind==='missing'));
    }
    const partial=await emit(original.slice(0,11).join('\n')+' 1',206);assert.ok(partial.bytes);
    const p=unpack(partial.bytes).EPHEMERIS_DATA_BLOCK[0];assert.equal(p.EPHEMERIS_DATA_LINES.length,1);assert.equal(p.COVARIANCE_MATRIX_LINES.length,1);assert.match(p.COMMENT,/incomplete trailing/);
    const flatc=await initCqrFlatc();
    const encode=(schema,obj)=>flatc.generateBinary(publishedSchema(schema),stringifyFlatcJson(obj),{sizePrefix:false});
    const decode=(schema,bytes)=>parseFlatcJson(flatc.generateJSON(publishedSchema(schema),{path:'/read.bin',data:bytes}));
    async function parse(body){const r=ok(await ca.invoke({methodId:'parse_ephemeris',inputs:[{portId:'ephemeris',payload:encodeCqr(flatc,{NATIVE_DOCUMENT:{CONTENT:[...Buffer.from(body)]}})},{portId:'reference_epoch',payload:encode('TIM',{INSTANT:utcJd(reference.reference_jd)})}]}));return decode('OEM',r.outputs.find(x=>x.portId==='oem').payload);}
    const a=decode('OEM',(await emit(fixture('A-itc.txt'))).bytes),b=decode('OEM',(await emit(fixture('B-itc.txt'))).bytes);
    const authorityA=await parse(fixture('A-itc.txt')),authorityB=await parse(fixture('B-itc.txt'));
    async function assess(primary,secondary){const req=pairRequest({PRIMARY:{OBJECT_ID:'A',EPHEMERIS:primary},SECONDARY:{OBJECT_ID:'B',EPHEMERIS:secondary},EVALUATION_FRAME:earthFrame('EME2000'),startJd:reference.start_jd,durationSeconds:120,coarseStepSec:5,fineTolSec:.00005});req.PAIR_REQUEST.CONTROLS.ALGORITHM='LAAS_2015';const r=ok(await ca.invoke({methodId:'assess_conjunction',inputs:[{portId:'request',payload:encodeCqr(flatc,req)}]}));const bytes=r.outputs.find(x=>x.portId==='result').payload,event=decodeCqr(flatc,bytes).EVENT_RESULT;event.probabilityFieldPresent=Object.hasOwn(decode('CQR',bytes).EVENT_RESULT.PROBABILITY??{},'PROBABILITY');return event;}
    const actual=await assess(a,b),expected=await assess(authorityA,authorityB);
    assert.ok(Math.abs(actual.MISS_DISTANCE_M-50)<5,'Published analytic straight-line miss');
    assert.ok(Math.abs(actual.MISS_DISTANCE_M-expected.MISS_DISTANCE_M)<.001);
    assert.equal(actual.PROBABILITY.UNCERTAINTY_SOURCE,'SUPPLIED_COVARIANCE');assert.ok(actual.PROBABILITY.PROBABILITY>0);
    assert.ok(Math.abs(actual.PROBABILITY.PROBABILITY-expected.PROBABILITY.PROBABILITY)<=expected.PROBABILITY.PROBABILITY*1e-5);
    assert.equal(actual.PROBABILITY.ALGORITHM,expected.PROBABILITY.ALGORITHM);
    const without=fixture('A-itc.txt').trimEnd().split('\n').filter((x,i)=>i<4||(i-4)%4===0).join('\n')+'\n';
    const unavailable=await assess(decode('OEM',(await emit(without)).bytes),b);
    assert.equal(unavailable.PROBABILITY.UNCERTAINTY_SOURCE,'MAXIMUM_PROBABILITY_ONLY');
    assert.equal(unavailable.PROBABILITY.ALGORITHM,'ALFANO_MAXIMUM');
    assert.equal(unavailable.probabilityFieldPresent,false,'Unavailable Pc omitted from wire; displayed zero must not be inferred');
    results.push({runtimeKind,publishedStates:block.EPHEMERIS_DATA_LINES.length,covarianceValues:21*block.COVARIANCE_MATRIX_LINES.length,missM:actual.MISS_DISTANCE_M,probability:actual.PROBABILITY.PROBABILITY,algorithm:actual.PROBABILITY.ALGORITHM});
  }finally{await host.destroy();await ca.destroy();}
}
console.log(JSON.stringify({status:'PASS',source:provenance.url,results},null,2));

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import * as fb from 'flatbuffers';
import * as O from 'spacedatastandards.org/lib/js/OCM/main.js';
import * as E from 'spacedatastandards.org/lib/js/ERM/main.js';
import { OMM } from 'spacedatastandards.org/lib/js/OMM/OMM.js';
import { OEM } from 'spacedatastandards.org/lib/js/OEM/OEM.js';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import { createStandaloneHarness } from 'space-data-module-sdk/testing/isomorphic';
import { frame, ommBytes, flightPcf, fitPcf, weather, checkPcf } from '../../../flows/catalog-builder/tests/fixtures.mjs';
const bytes = url => fs.readFileSync(new URL(url, import.meta.url));
const pack = (r, code) => { const b = new fb.Builder(8192); b.finishSizePrefixed(r.pack(b), '$'+code); return b.asUint8Array().slice(); };
const decode = b => O.OCM.getSizePrefixedRootAsOCM(new fb.ByteBuffer(b));
const seed = OMM.getRootAsOMM(new fb.ByteBuffer(ommBytes)).unpack();
const seedBytes = pack(seed,'OMM');
const model = E.ERM.getSizePrefixedRootAsERM(new fb.ByteBuffer(bytes('../data/e14-s3-kc.erm'))).unpack();
const ages = model.MODEL.STRATA_SETTINGS.AGE_BINS.map(b=>(b.MIN_DAYS+b.MAX_DAYS)/2);
let h, ap, products;
test.before(async()=>{
  h=await createBrowserModuleHarness({wasmSource:bytes('../dist/isomorphic/module.wasm'),manifest:JSON.parse(bytes('../plugin-manifest.json')),surface:'direct',hostOptions:{config:{'object.source':{id:'synthetic',kind:'element-set',originator:'synthetic',provider:'synthetic',lineage:'synthetic',licence:{class:'reproducible',id:'synthetic'}}}}});
  const chain=await createStandaloneHarness('browser',new URL('../../../flows/catalog-builder/dist/isomorphic/module.wasm',import.meta.url).pathname,{surface:'direct',enableBrowserWasiThreads:false});
  try {
    const r=await chain.invoke({methodId:'run_chain',inputs:[frame('omm','OMM',ommBytes),frame('flight_config','PCF',flightPcf),frame('fit_config','PCF',fitPcf),frame('weather','SPW',weather)]});
    assert.equal(r.statusCode,0,r.errorMessage);
    products=['elements','fallback'].map(port=>{const raw=r.outputs.find(f=>f.portId===port)?.payload;assert.ok(raw,port);return pack(O.OCM.getRootAsOCM(new fb.ByteBuffer(raw)).unpack(),'OCM');});
  } finally {chain.destroy();}
  ap=await createStandaloneHarness('browser',process.env.SDNAP_WASM || new URL('../../../propagator/sdn-ap/dist/isomorphic/module.wasm',import.meta.url).pathname,{surface:'direct',enableBrowserWasiThreads:false});
});
test.after(()=>{h?.destroy();ap?.destroy();});
const annotate=async (ocm, elements=seedBytes, extra=[])=>h.invoke({methodId:'annotate_population',inputs:[frame('ocm','OCM',ocm),frame('elements','OMM',elements),...extra]});
const accepted=async (ocm, elements=seedBytes)=>{const r=await annotate(ocm,elements);assert.equal(r.statusCode,0,r.errorMessage);return r.outputs.find(f=>f.portId==='ocm').payload;};
const fly=async record=>{const r=await ap.invoke({methodId:'propagate',inputs:[frame('ocm','OCM',record.subarray(4)),frame('configuration','PCF',checkPcf)]});assert.equal(r.statusCode,0,r.errorMessage);return r.outputs.find(f=>f.portId==='ephemeris').payload;};

test('annotation retains the entire original buffer and every original root reference',async()=>{
  for(const original of products){
    const annotated=await accepted(original), before=decode(original), after=decode(annotated);
    const start=Buffer.from(annotated).indexOf(Buffer.from(original));assert.ok(start>=0,'all original byte ranges retained verbatim');
    const a=before.unpack(), b=after.unpack();
    for(const key of ['COVARIANCE_BLOCKS','COV_REALISM','COV_CALIBRATION']){delete a[key];delete b[key];}
    assert.deepEqual(b,a,'all other fields retained, including posterior and propagation block');
    // Independently follow every original pointer field: the new root must reference
    // the original copied table/vector/string, not a reconstructed equivalent.
    const scalar=new Set([8,12,14,42,46,54,56,76]);
    const replaced=new Set([46,64,68]);
    const v=before.bb_pos-before.bb.readInt32(before.bb_pos),n=before.bb.readUint16(v);
    for(let slot=4;slot<n;slot+=2){
      if(scalar.has(slot)||replaced.has(slot))continue;
      const x=before.bb.__offset(before.bb_pos,slot);if(!x)continue;
      const y=after.bb.__offset(after.bb_pos,slot);assert.ok(y);
      assert.equal(after.bb.__indirect(after.bb_pos+y),start+before.bb.__indirect(before.bb_pos+x),'original pointer slot '+slot);
    }
  }
});

test('AP states and formal covariance rows remain bit identical at ten epochs',async()=>{
  const original=products[0], annotated=await accepted(original);
  const before=await fly(original),after=await fly(annotated);
  assert.deepEqual(Buffer.from(after),Buffer.from(before),'entire OEM response is byte identical');
  const o=OEM.getRootAsOEM(new fb.ByteBuffer(before)).unpack();
  assert.equal(o.EPHEMERIS_DATA_BLOCK.reduce((n,b)=>n+b.COVARIANCE_MATRIX_LINES.length,0),10);
  const labels=decode(annotated).unpack().COV_REALISM;
  assert.ok(labels.some(l=>/Formal fit posterior/.test(l.EVIDENCE)));
  assert.ok(labels.every(l=>l.CALIBRATION!==O.covarianceCalibration.Calibrated));
});

test('seven full matrices use seed epoch and model midpoints and agree with the established population method',async()=>{
  assert.equal(ages.length,7);
  const request=Object.assign(new E.ERMT(),{CALIBRATED_COVARIANCES:Object.assign(new E.ERMCalibratedCovariancesT(),{OBJECTS:ages.map(age=>Object.assign(new E.ERMCalibrationObjectT(),{ID:'synthetic',SET_NORAD_CAT_ID:seed.NORAD_CAT_ID,SET_EPOCH:seed.EPOCH,AGE_DAYS:age}))})});
  const control=await h.invoke({methodId:'object_covariance',inputs:[frame('elements','OMM',seedBytes),frame('request','ERM',pack(request,'ERM'))]});
  assert.equal(control.statusCode,0,control.errorMessage);
  const c=decode(control.outputs.find(f=>f.portId==='ocm').payload).unpack();
  for(const original of products){
    const blocks=decode(await accepted(original)).unpack().COVARIANCE_BLOCKS;assert.equal(blocks.length,7);
    for(let i=0;i<7;i++){
      const b=blocks[i], [epoch,...values]=b.LINES[0].split(' '), matrix=values.map(Number);
      assert.equal(matrix.length,36);assert.equal(b.COV_ORDERING,O.covarianceOrdering.FULL);
      assert.equal(b.COV_REF_FRAME,'GCRF');assert.equal(b.COV_BASIS_ID,model.MODEL.ID);
      assert.equal(Date.parse(epoch.endsWith('Z')?epoch:epoch+'Z')-Date.parse(seed.EPOCH+'Z'),ages[i]*86400000);
      assert.equal(b.COV_REALISM[0].AGE_DAYS,ages[i]);assert.equal(b.COV_REALISM[0].CALIBRATION,O.covarianceCalibration.Uncalibrated);
      // Control: established population model, GCRF km/km/s, at seed UTC + age.
      // 1e-13 relative tolerance covers only its SI conversion and our full expansion.
      for(let row=0,k=0;row<6;row++)for(let col=0;col<=row;col++,k++){
        const expected=c.COVARIANCE_DATA[i*21+k];assert.ok(Math.abs(matrix[6*row+col]-expected)<=1e-13*Math.max(1e-30,Math.abs(expected)));
        assert.equal(matrix[6*row+col],matrix[6*col+row]);
      }
    }
  }
});

test('uncovered regime carries the reason and model identity with no fabricated block',async()=>{
  const uncovered=Object.assign(OMM.getRootAsOMM(new fb.ByteBuffer(ommBytes)).unpack(),{ECCENTRICITY:0.001,MEAN_MOTION:0.1});
  const raw=O.OCM.getSizePrefixedRootAsOCM(new fb.ByteBuffer(products[1])).unpack();
  const annotated=decode(await accepted(pack(raw,'OCM'),pack(uncovered,'OMM'))).unpack();
  assert.equal(annotated.COVARIANCE_BLOCKS.length,0);
  assert.ok(annotated.COV_REALISM.some(l=>/no population covariance \(OUTSIDE/.test(l.EVIDENCE)&&l.MODEL_ID===model.MODEL.ID));
});

test('malformed, mismatched, duplicate and repeated annotation inputs are refused',async()=>{
  for(const original of [products[0].subarray(0,20),Buffer.concat([products[0],products[0]])])assert.notEqual((await annotate(original)).statusCode,0);
  const other=Object.assign(OMM.getRootAsOMM(new fb.ByteBuffer(ommBytes)).unpack(),{NORAD_CAT_ID:999998});
  assert.equal((await annotate(products[0],pack(other,'OMM'))).errorCode,'seed-mismatch');
  assert.notEqual((await annotate(products[0],seedBytes,[frame('ocm','OCM',products[0])])).statusCode,0);
  assert.equal((await annotate(await accepted(products[0]))).errorCode,'already-annotated');
});

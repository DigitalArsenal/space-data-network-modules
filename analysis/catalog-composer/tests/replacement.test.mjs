import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import * as fb from 'flatbuffers';
import * as C from 'spacedatastandards.org/lib/js/CAT/main.js';
import * as O from 'spacedatastandards.org/lib/js/OCM/main.js';
import * as X from 'spacedatastandards.org/lib/js/XMT/main.js';
import * as Q from 'spacedatastandards.org/lib/js/QRP/main.js';
import {createBrowserModuleHarness} from 'space-data-module-sdk/host/browser-module';
import {cidOf} from './integrator-fixtures.mjs';
const pack=(r,code,prefix=true)=>{const b=new fb.Builder(1024);if(prefix)b.finishSizePrefixed(r.pack(b),'$'+code);else b.finish(r.pack(b),'$'+code);return b.asUint8Array().slice();};
const frame=(portId,code,payload)=>({portId,payload,typeRef:{schemaName:code+'.fbs',fileIdentifier:'$'+code,rootTypeName:code,wireFormat:'flatbuffer'}});
const epoch='2026-10-01T00:00:00Z',now=Date.parse(epoch)+86400000;
const catalog=pack(Object.assign(new C.CATT(),{NORAD_CAT_ID:999999,OBJECT_NAME:'SYNTHETIC',MANEUVERABLE:true}),'CAT');
const product=(theory,id=999999)=>pack(Object.assign(new O.OCMT(),{METADATA:Object.assign(new O.MetadataT(),{NORAD_CAT_ID:id}),MEAN_ELEMENTS:Object.assign(new O.OCMMeanElementsT(),{MEAN_ELEMENT_THEORY:theory,EPOCH:epoch}),PROVENANCE:Object.assign(new O.PVNT(),{SOURCE_ID:'synthetic'})}),'OCM');
const decode=b=>C.CAT.getSizePrefixedRootAsCAT(new fb.ByteBuffer(b));
let h;
test.before(async()=>{h=await createBrowserModuleHarness({wasmSource:fs.readFileSync(new URL('../dist/isomorphic/module.wasm',import.meta.url)),manifest:JSON.parse(fs.readFileSync(new URL('../plugin-manifest.json',import.meta.url))),surface:'direct'});});
test.after(()=>h?.destroy());
async function replace(cat,selected,asOf=now,extra=[]){
 const recipe=Object.assign(new X.XMTT(),{INTEGRATE_RECIPE:Object.assign(new X.XMTIntegrateRecipeT(),{AS_OF_MS:BigInt(asOf)})});
 const decision=Object.assign(new Q.QRPT(),{MESSAGE:'old-span fallback; no population covariance (OUTSIDE)'});
 return h.invoke({methodId:'replace_products',inputs:[frame('catalog','CAT',cat),frame('recipe','XMT',pack(recipe,'XMT',false)),frame('decision','QRP',pack(decision,'QRP',false)),...(selected?[frame('ocm_products','OCM',selected)]:[]),...extra]});
}
const output=r=>{assert.equal(r.statusCode,0,r.errorMessage);return r.outputs.find(f=>f.portId==='catalog').payload;};

test('AP to SGP4 replaces the whole list, exact published CID, and reason without marking maneuver retirement',async()=>{
 const ap=product(O.meanElementSource.AP),sgp4=product(O.meanElementSource.SGP4);
 const first=output(await replace(catalog,ap));assert.equal(decode(first).unpack().PRODUCTS[0].KIND,C.catalogProductKind.ApElements);
 const second=decode(output(await replace(first,sgp4,now+1000))).unpack();
 assert.equal(second.PRODUCTS.length,1);assert.equal(second.PRODUCTS[0].KIND,C.catalogProductKind.Sgp4Elements);
 assert.equal(second.PRODUCTS[0].RECORD_CID,cidOf(sgp4));assert.equal(second.PRODUCTS[0].SOURCE_ID,'synthetic');assert.equal(second.PRODUCTS[0].STALE,false);
 assert.equal(second.PRODUCTS[0].SELECTION_REASON,'old-span fallback; no population covariance (OUTSIDE)');
 assert.equal(Date.parse(second.PRODUCTS_AS_OF),now+1000);
 const before=decode(catalog).unpack();for(const key of ['PRODUCTS','PRODUCTS_AS_OF']){delete before[key];delete second[key];}assert.deepEqual(second,before);
});

test('removal emits an explicit empty product vector with an as-of time; replay is byte stable',async()=>{
 const first=output(await replace(catalog,product(O.meanElementSource.AP)));
 const removed=output(await replace(first,null,now+1000));const c=decode(removed);
 assert.equal(c.productsLength(),0);assert.ok(c.bb.__offset(c.bb_pos,56),'PRODUCTS is present, explicitly empty');
 assert.equal(Date.parse(c.PRODUCTS_AS_OF()),now+1000);assert.equal(c.MANEUVERABLE(),true);
 assert.deepEqual(output(await replace(first,null,now+1000)),removed);
});

test('older timestamps, mismatched objects, concatenated records, and repeated inputs fail without output',async()=>{
 const first=output(await replace(catalog,product(O.meanElementSource.AP)));
 const cases=[await replace(first,null,now-1),await replace(catalog,product(O.meanElementSource.AP,999998)),await replace(Buffer.concat([catalog,catalog]),null),await replace(catalog,null,now,[frame('catalog','CAT',catalog)])];
 for(const r of cases){assert.notEqual(r.statusCode,0);assert.equal(r.outputs.length,0);}
});

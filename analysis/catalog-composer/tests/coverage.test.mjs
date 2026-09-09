import test from 'node:test';
import assert from 'node:assert/strict';
import { Builder } from 'flatbuffers';
import { coverageDesignators, primarySources } from '../app/coverage.js';
const cat=(id,norad=0)=>{const b=new Builder();const text=b.createString(id);b.startObject(3);b.addFieldOffset(1,text,0);b.addFieldInt32(2,norad,0);b.finishSizePrefixed(b.endObject(),'$CAT');return b.asUint8Array();};
test('coverage uses only declared international designators, deduplicating without NORAD inference',()=>{
 const stream=Buffer.concat([cat('1998-067A',25544),cat('1998-067A',99999),cat('',25544),cat('25544',25544)]);
 assert.deepEqual(coverageDesignators(stream),{objects:['1998-067A'],unresolved:2});
 assert.throws(()=>coverageDesignators(stream.subarray(0,stream.length-1)));
});
test('every orbital provider is visible; only its own source catalog establishes membership',()=>{
 const base={provider:'provider',source:'ephemeris'};
 const result=primarySources([{...base,node:'one',schema:'NCD'},{...base,node:'two',schema:'CAT',manifest:'other-peer'},{...base,node:'one',source:'different',schema:'CAT',manifest:'other-source'},{...base,node:'three',schema:'OEM'},{...base,node:'three',schema:'CAT',manifest:'own-source'}]);
 assert.equal(result.length,2);assert.equal(result[0].published,false);assert.equal(result[1].published,true);
});

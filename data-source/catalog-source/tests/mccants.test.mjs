import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { ByteBuffer } from 'flatbuffers';
import { CAT } from 'spacedatastandards.org/lib/js/CAT/CAT.js';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';

// Source: https://mmccants.org/tles/classfd.zip, retrieved 2026-09-07.
// These checks concern catalog identity, not orbital-state accuracy. No frame,
// epoch or propagation tolerance is asserted for the resulting CAT metadata.
const canyon = ['Canyon 2',
  '1 03889U 69036A   22058.58164633 0.00000000  00000-0  00000-0 0    08',
  '2 03889  10.3920  54.5705 0924613 151.8146 208.1854  1.00414653    04'];
const prowler = ['Prowler',
  '1 90007U 90097E   21305.13119867 0.00000000  00000-0  00000-0 0    01',
  '2 90007  14.4403 350.3137 0040735 245.2740 114.3135  1.00206833    00'];
const manifest = JSON.parse(fs.readFileSync(new URL('../plugin-manifest.json',import.meta.url)));
async function harness(t) {
  const host = await createBrowserModuleHarness({wasmSource:fs.readFileSync(new URL('../dist/isomorphic/module.wasm',import.meta.url)),manifest,surface:'direct'});
  t.after(()=>host.destroy()); return host;
}
function request(source) {
  const payload = new TextEncoder().encode(source);
  return {methodId:'parse_mccants_tle_catalog',inputs:[{portId:'source',payload,typeRef:{wireFormat:'aligned-binary',requiredAlignment:1,byteLength:payload.length}}]};
}
function decode(result) {
  assert.equal(result.statusCode,0,result.errorMessage);
  const bytes=result.outputs.find(frame=>frame.portId==='catalog').payload, rows=[];
  for(let at=0;at<bytes.length;) {
    const length=new DataView(bytes.buffer,bytes.byteOffset+at,4).getUint32(0,true)+4;
    assert.ok(length>12 && at+length<=bytes.length);
    rows.push(CAT.getSizePrefixedRootAsCAT(new ByteBuffer(bytes.slice(at,at+length))).unpack()); at+=length;
  }
  return {rows,report:JSON.parse(new TextDecoder().decode(result.outputs.find(frame=>frame.portId==='report').payload))};
}
function withNumber(lines,number) {
  return lines.map((line,i)=> {
    if (!i) return line;
    const body=line.slice(0,2)+number+line.slice(7,68);
    const checksum=[...body].reduce((sum,c)=>sum+(/[0-9]/.test(c)?Number(c):c==='-'?1:0),0)%10;
    return body+checksum;
  });
}
test('extracts McCants names and canonical identifiers without inventing orbital data',async t=> {
  const host=await harness(t),{rows,report}=decode(await host.invoke(request(canyon.join('\r\n')+'\r\n')));
  assert.equal(rows[0].OBJECT_NAME,'Canyon 2'); assert.equal(rows[0].NORAD_CAT_ID,3889);
  assert.equal(rows[0].OBJECT_ID,'1969-036A'); assert.equal(rows[0].PERIOD,0);
  assert.equal(rows[0].INCLINATION,0); assert.equal(rows[0].LAUNCH_DATE,null);
  assert.deepEqual(report.nativeKeys,['03889']); assert.equal(report.unnumberedObjects,0);
});
test('keeps analyst numbers and designators out of globally joinable identity fields',async t=> {
  const host=await harness(t),{rows,report}=decode(await host.invoke(request(prowler.join('\n'))));
  assert.equal(rows[0].OBJECT_NAME,'Prowler'); assert.equal(rows[0].NORAD_CAT_ID,0);
  assert.equal(rows[0].OBJECT_ID,null); assert.deepEqual(report.nativeKeys,['90007']);
  assert.equal(report.unnumberedObjects,1); assert.equal(report.unrepresentedDesignators,1);
});
test('accepts two-line records and explicit three-line names',async t=> {
  const host=await harness(t);
  assert.equal(decode(await host.invoke(request(canyon.slice(1).join('\n')))).rows[0].OBJECT_NAME,null);
  assert.equal(decode(await host.invoke(request(['0 Canyon 2',...canyon.slice(1)].join('\n')))).rows[0].OBJECT_NAME,'Canyon 2');
});
test('uses Space-Track Alpha-5 numbering, excluding I and O',async t=> {
  // https://www.space-track.org/documentation#/tle-alpha5: A=10, J=18, Z=33.
  const host=await harness(t);
  for(const [encoded,norad] of [['A0000',100000],['H9999',179999],['J0000',180000],['Z9999',339999]]) {
    const {rows}=decode(await host.invoke(request(withNumber(canyon,encoded).join('\n'))));
    assert.equal(rows[0].NORAD_CAT_ID,norad);
  }
  for(const encoded of ['I0000','O0000','a0000','00000']) assert.notEqual((await host.invoke(request(withNumber(canyon,encoded).join('\n')))).statusCode,0);
});
test('rejects damaged, incomplete, duplicate and misordered editions without partial output',async t=> {
  const host=await harness(t);
  const different=withNumber(canyon,'04418');
  for(const source of [canyon.join('\n')+'\n'+canyon.join('\n'),canyon.slice(0,2).join('\n'),canyon[2],
    [canyon[0],canyon[1],different[2]].join('\n'),[canyon[0],canyon[1].slice(0,68)+'9',canyon[2]].join('\n'),
    ['unexpected',...canyon].join('\n'),canyon.join('\n')+'\ntruncated name',canyon.join('\n')+'\0','x'.repeat(1025)]) {
    const result=await host.invoke(request(source)); assert.notEqual(result.statusCode,0); assert.equal(result.outputs?.length??0,0);
  }
  assert.equal(decode(await host.invoke(request(canyon.join('\n')))).rows.length,1);
});
test('parses each complete upstream McCants edition when supplied',{skip:!process.env.MCCANTS_TEST_EDITION},async t=> {
  const source=fs.readFileSync(process.env.MCCANTS_TEST_EDITION,'utf8');
  const keys=source.split(/\r?\n/).filter(line=>line.startsWith('1 ')).map(line=>line.slice(2,7));
  const host=await harness(t),{rows,report}=decode(await host.invoke(request(source)));
  assert.equal(rows.length,keys.length); assert.deepEqual(report.nativeKeys,keys);
  assert.equal(report.unnumberedObjects,keys.filter(key=>key[0]==='9').length);
  assert.equal(new Set(report.nativeKeys).size,rows.length);
  console.log(JSON.stringify({records:rows.length,analystObjects:report.unnumberedObjects}));
});

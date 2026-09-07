import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ByteBuffer } from 'flatbuffers';
import { CAT } from 'spacedatastandards.org/lib/js/CAT/CAT.js';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import { validateArtifactWithStandards } from 'space-data-module-sdk/compliance';

const wasmPath = fileURLToPath(new URL('../dist/isomorphic/module.wasm', import.meta.url));
const wasm = fs.readFileSync(wasmPath);
const manifest = JSON.parse(fs.readFileSync(new URL('../plugin-manifest.json', import.meta.url)));
const columns = ['#JCAT','Satcat','Name','Piece','Type','LDate','Primary','Perigee','PF','Apogee','AF','Inc','IF','Status','State','Bus'];
const row = (overrides = {}) => columns.map(key => ({ '#JCAT':'S100000', Satcat:'100000', Name:'Saramago', Piece:'2026-067CY', Type:'P', LDate:'2026 Mar 30', Primary:'Earth', Perigee:'500', PF:'', Apogee:'508', AF:'', Inc:'97.46', IF:'', Status:'O', State:'PT', Bus:'Unstandardized bus', ...overrides })[key]).join('\t');
const source = (...rows) => columns.join('\t')+'\n# Updated 2026 Sep 6\n'+rows.join('\n')+'\n';
function request(text) {
  const payload = new TextEncoder().encode(text);
  return { methodId:'parse_gcat', inputs:[{ portId:'source', payload, typeRef:{wireFormat:'aligned-binary', requiredAlignment:1, byteLength:payload.length} }] };
}
async function harness(t) {
  const host = await createBrowserModuleHarness({wasmSource:wasm,manifest,surface:'direct'});
  t.after(() => host.destroy()); return host;
}
function records(result) {
  assert.equal(result.statusCode,0,result.errorMessage);
  const bytes = result.outputs.find(frame => frame.portId === 'catalog').payload;
  const rows = [];
  for(let offset=0; offset < bytes.length;) {
    assert.ok(offset+4 <= bytes.length);
    const length = new DataView(bytes.buffer, bytes.byteOffset+offset,4).getUint32(0,true)+4;
    assert.ok(length > 12 && offset+length <= bytes.length);
    rows.push(CAT.getSizePrefixedRootAsCAT(new ByteBuffer(bytes.slice(offset,offset+length))).unpack());
    offset += length;
  }
  return { rows, report:JSON.parse(new TextDecoder().decode(result.outputs.find(frame => frame.portId === 'report').payload)) };
}

test('the SDK artifact validates against the canonical standards', async () => {
  const result = await validateArtifactWithStandards({wasmPath,manifest,standardsRoot:process.env.SPACE_DATA_STANDARDS_ROOT});
  assert.equal(result.ok,true,JSON.stringify(result.issues));
});
test('maps published GCAT values and preserves native identity diagnostics', async t => {
  // Saramago, GCAT satcat100k.tsv retrieved 2026-09-07 from planet4589.org.
  // Descriptive catalog orbit: perigee/apogee km, inclination degrees; no state-vector epoch/frame is asserted.
  // Values are parsed, not propagated: exact km and 1e-12 degree tolerance covers binary64 conversion only.
  const host = await harness(t);
  const result = records(await host.invoke(request(source(row()))));
  assert.equal(result.rows[0].NORAD_CAT_ID,100000);
  assert.equal(result.rows[0].OBJECT_NAME,'Saramago');
  assert.equal(result.rows[0].OBJECT_ID,'2026-067CY');
  assert.equal(result.rows[0].LAUNCH_DATE,'2026-03-30');
  assert.equal(result.rows[0].PERIGEE,500); assert.equal(result.rows[0].APOGEE,508);
  assert.ok(Math.abs(result.rows[0].INCLINATION-97.46) < 1e-12);
  assert.equal(result.rows[0].BUS_ID,null);
  assert.equal(result.rows[0].OPS_STATUS_CODE,7);
  assert.deepEqual(result.report.nativeKeys,['S100000']);
});
test('omits uncertain or unrepresentable values instead of inventing precision', async t => {
  const host = await harness(t);
  const {rows,report} = records(await host.invoke(request(source(row({Piece:'1957ALP1',LDate:'2020 Feb 30',PF:'?',AF:'?',IF:'?'})))));
  assert.equal(rows[0].OBJECT_ID,null); assert.equal(rows[0].LAUNCH_DATE,null);
  assert.equal(rows[0].PERIGEE,0); assert.equal(rows[0].APOGEE,0); assert.equal(rows[0].INCLINATION,0);
  assert.equal(report.unrepresentedDesignators,1); assert.equal(report.unrepresentedLaunchDates,1);
});
test('does not infer a NORAD number from a native key when GCAT says none is assigned', async t => {
  const host = await harness(t);
  const {rows,report} = records(await host.invoke(request(source(row({Satcat:'NNA'})))));
  assert.equal(rows[0].NORAD_CAT_ID,0);
  assert.deepEqual(report.nativeKeys,['S100000']);
  assert.equal(report.unnumberedObjects,1);
});
test('rejects ambiguous identifiers, duplicate objects and damaged editions without partial output', async t => {
  const host = await harness(t);
  for(const text of [source(row({'#JCAT':'A100000'})),source(row({Satcat:'99999'})),source(row(),row()),source(row()).replace('Name','Satcat'),source(row())+'too\tfew\tcolumns\n',source(row())+'\0']) {
    const result = await host.invoke(request(text));
    assert.notEqual(result.statusCode,0); assert.equal(result.outputs?.length ?? 0,0);
  }
  assert.equal(records(await host.invoke(request(source(row())))).rows.length,1);
});
test('parses a complete upstream edition when provided', {skip:!process.env.GCAT_TEST_EDITION}, async t => {
  const text = fs.readFileSync(process.env.GCAT_TEST_EDITION,'utf8');
  const expected = text.split(/\r?\n/).filter(line => line.startsWith('S')).length;
  const host = await harness(t); const start = performance.now();
  const result = records(await host.invoke(request(text)));
  assert.equal(result.rows.length,expected); assert.equal(result.report.records,expected);
  const numbered = result.rows.filter(row => row.NORAD_CAT_ID !== 0);
  assert.equal(new Set(numbered.map(row => row.NORAD_CAT_ID)).size,numbered.length);
  assert.equal(new Set(result.report.nativeKeys).size,expected);
  console.log(JSON.stringify({records:expected,milliseconds:Math.round(performance.now()-start)}));
});

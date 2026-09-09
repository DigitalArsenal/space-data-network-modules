// Regenerate bounded parity inputs through the existing compiled native tile
// method. Numerical truth remains the independent analytic tests, not these
// frozen bytes. No source dataset or publication is represented by this fixture.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';
import { buildGeoTiff, buildWaterTiff, splitStream } from '../../helpers.mjs';

const manifest = JSON.parse(fs.readFileSync(new URL('../../../plugin-manifest.json', import.meta.url)));
const wasm = fs.readFileSync(new URL('../../../dist/isomorphic/module.wasm', import.meta.url));
const frame = (portId, payload) => ({portId, payload, typeRef: {
  wireFormat:'aligned-binary', requiredAlignment:1, byteLength:payload.length,
}});
const json = (port, value) => frame(port, Buffer.from(JSON.stringify(value)));
function raw(port, bytes, status = 200) {
  const out = Buffer.alloc(bytes.length + 8);
  out.write('$HRB'); out.writeUInt32LE(status,4); Buffer.from(bytes).copy(out,8);
  return frame(port,out);
}
function stream(records) {
  return Buffer.concat(records.map(record => {
    const size = Buffer.alloc(4); size.writeUInt32LE(record.length);
    return Buffer.concat([size,record]);
  }));
}
const geometry = {width:65,height:65,originLon:9.84375,originLat:46.40625,
  scaleLon:1.40625/64,scaleLat:1.40625/64};
const dem = buildGeoTiff({...geometry,heightFn:(x,y)=>-100+x+2*y});
const water = buildWaterTiff({...geometry,classFn:(_x,y)=>y<32?1:0});
const provenance = {datasetId:'parent-lod-analytic-fixture',datasetName:'Analytic terrain fixture',
  datasetEpoch:'2023-04-01T00:00:00.000Z',retrievedAt:'2026-09-09T12:00:00.000Z',
  license:'CC0 synthetic fixture',attribution:'Analytic test data, not published terrain'};
const runtime = await createBrowserModuleHarness({wasmSource:wasm,manifest,surface:'direct'});
const files = [];
try {
  for (const ocean of [false,true]) {
    const records=[];
    for(let q=0;q<4;q++) {
      const plan={tilesetId:'parent-lod-test',scheme:'GEOGRAPHIC_WGS84',rowOriginNorth:false,
        level:8,x:270+q%2,y:192+Math.floor(q/2),gridSize:9,minGridSize:9,maxGridSize:9,
        maxLevel:8,skipOceanTiles:false,measureAccuracy:true,verticalDatumName:'EGM2008',provenance};
      const response=await runtime.invoke({methodId:'tile',inputs:[json('plan',plan),
        raw('dem',ocean?Buffer.alloc(0):dem,ocean?404:200),
        raw('water',ocean?Buffer.alloc(0):water,ocean?404:200)]});
      if(response.statusCode!==0) throw new Error(`${response.errorCode}: ${response.errorMessage}`);
      const batch=splitStream(response.outputs.find(output=>output.portId==='records').payload);
      if(batch.length!==1) throw new Error('Expected one retained native child');
      records.push(Buffer.from(batch[0]));
    }
    for(const [name, selected] of [[ocean?'ocean.dttstream':'analytic.dttstream',records],
      ...(ocean?[]:[['missing-child.dttstream',records.slice(0,3)]])]) {
      const bytes=stream(selected);
      fs.writeFileSync(new URL(name,import.meta.url),bytes);
      files.push({name,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});
    }
  }
} finally {await runtime.destroy();}
fs.writeFileSync(new URL('inputs.json',import.meta.url),JSON.stringify({
  generator:'generate.mjs',fixtureKind:'synthetic native tile outputs; not source terrain',files,
},null,2)+'\n');
console.log(JSON.stringify(files));

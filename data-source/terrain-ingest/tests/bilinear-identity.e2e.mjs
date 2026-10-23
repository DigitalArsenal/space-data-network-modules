// Regression E2E against the pre-edit compiled candidate. Real NASA source
// products, identical typed input frames and retrieval epoch. No golden math.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createBrowserModuleHarness} from 'space-data-module-sdk/testing';
import {planInputs,granuleFrame} from '../../terrain-source/typed-frames.mjs';
import {moonPlan,lolaFrames} from '../../terrain-source/lola-frames.mjs';
const sourceRoot=new URL('../../terrain-source/',import.meta.url);
const manifest=JSON.parse(fs.readFileSync(new URL('plugin-manifest.json',sourceRoot)));
const variants=[process.argv[2],new URL('dist/isomorphic/module.wasm',sourceRoot)];
assert.ok(variants[0],'pass the saved pre-edit WASM');
const moon=moonPlan([{level:2,x:4,y:2}],{product:'ldem_4',options:{gridSize:33,maxGridSize:33,measureAccuracy:false,minGridSize:33}});
const mars={...moon,tilesetId:'nasa-mola-mars',centerName:'MARS',referenceRadiiM:[3396000],verticalDatumName:'MOLA reference sphere 3396 km',horizontalDatumName:'IAU Mars',provenance:{...moon.provenance,datasetId:'nasa-mola-megdr',attribution:'NASA MGS MOLA'}};
const data=process.env.TERRAIN_DATA_ROOT??'/Users/tj/software/terrain-work';
const cases=[{name:'Moon',inputs:[...planInputs(moon),...lolaFrames(`${data}/moon-data`,'ldem_4',0,720)]},
 {name:'Mars',inputs:[...planInputs(mars),granuleFrame('dem',fs.readFileSync(`${data}/mars-data/megr90n000cb.lbl`)),granuleFrame('dem',fs.readFileSync(`${data}/mars-data/megr90n000cb.img`))]}];
const reports=[];
for(const c of cases) {
 const results=[];
 for(const wasmSource of variants) {
  const h=await createBrowserModuleHarness({wasmSource:fs.readFileSync(wasmSource),manifest,surface:'direct'});
  try {const r=await h.invoke({methodId:'tile',inputs:c.inputs});assert.equal(r.statusCode,0,r.errorMessage);results.push(r.outputs.map(o=>({portId:o.portId,bytes:Buffer.from(o.payload)})));}finally{await h.destroy();}
 }
 assert.deepEqual(results[1],results[0],`${c.name}: bilinear outputs changed`);
 reports.push({body:c.name,identical:true,outputs:results[1].map(o=>({port:o.portId,bytes:o.bytes.length,sha256:createHash('sha256').update(o.bytes).digest('hex')}))});
}
console.log(JSON.stringify({pass:true,checks:reports}));

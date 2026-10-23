// Packed payload E2E: actual quantized vertices and explicit validity flags,
// sampled deterministically across the published pyramid. GDAL is the oracle.
import fs from 'node:fs';import path from 'node:path';import zlib from 'node:zlib';
import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';import {fileURLToPath} from 'node:url';
import {splitSized,dttOf} from '../../terrain-source/tools/body-lane.mjs';
import {decodeEdgeMatchedPlanes} from '../../terrain-source/tools/edge-matched-planes.mjs';
import {decodeQuantizedMesh} from '../../terrain-source/tests/helpers.mjs';
const [configPath,output,receipt]=process.argv.slice(2);assert.ok(receipt,'config out receipt required');
const cfg=JSON.parse(fs.readFileSync(configPath));const root=path.join(output,`terrain/${cfg.naif}`);
let state=20261023;const random=n=>{state^=state<<13;state^=state>>>17;state^=state<<5;return(state>>>0)%n;};
const files=[];
for(const e of fs.readdirSync(root,{withFileTypes:true})) {
 if(e.isDirectory()) {
  for(const name of fs.readdirSync(path.join(root,e.name)))if(name.endsWith('.dtts.gz'))files.push(`${e.name}/${name}`);
 } else if(e.name==='root.dtts.gz')files.push(e.name);
}
files.sort();
const inventory=files.map(name=>{const bytes=fs.readFileSync(path.join(root,name));return {key:`terrain/${cfg.naif}/${name}`,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};});
const expected=1+Array.from({length:cfg.maxLevel-2},(_,i)=>2**(2*(i+3)-3)).reduce((a,b)=>a+b,0);
assert.equal(files.length,expected,'complete pack pyramid required');
const queries=[];let tiles=0;const counts={sphere:0,source:0,feather:0};
// 1000 independent random packed posts, plus targeted coverage classes so a
// mostly unobserved body cannot pass using only its fallback sphere.
for(let k=0;k<20000&&(k<4000||counts.source<1000);k++) {
 const name=files[random(files.length)];const records=splitSized(zlib.gunzipSync(fs.readFileSync(path.join(root,name))));
 const t=dttOf(records[random(records.length)].subarray(4)).unpack();
 assert.equal(t.REFERENCE_RADII_M[0],cfg.radiusM);assert.equal(t.PAYLOAD.CONTENT_ENCODING,'qm-edge-matched-planes-v1');
 assert.equal(t.MAX_LEVEL,cfg.maxLevel);assert.equal(t.SOURCE_POST_SPACING_M,cfg.sourceResolutionM);
 const payload=Buffer.from(t.PAYLOAD.BYTES);const lattice=payload.readUInt16LE(88);
 const qm=decodeQuantizedMesh(decodeEdgeMatchedPlanes(payload));tiles++;
 const ext=qm.extensions.find(e=>e.id===4);assert.ok(ext,'explicit source mask required');
 const text=Buffer.from(ext.bytes);const metadata=JSON.parse(text.subarray(4,4+text.readUInt32LE(0)).toString());
 const flags=metadata.sourcePixelMask;assert.equal(flags.length,qm.vertexCount);assert.match(flags,/^[012]+$/);
 const v=random(qm.vertexCount),flag=Number(flags[v]);counts[['sphere','source','feather'][flag]]++;
 const c=Math.round(qm.u[v]/32767*(lattice-1)),r=Math.round(qm.v[v]/32767*(lattice-1));
 const lon=-180+(t.X*(lattice-1)+c)*360/(2**(t.LEVEL+1)*(lattice-1));
 const lat=-90+(t.Y*(lattice-1)+r)*180/(2**t.LEVEL*(lattice-1));
 const quantum=(qm.header.maxHeight-qm.header.minHeight)/32767;
 const height=qm.header.minHeight+qm.h[v]*quantum;
 queries.push({lon,lat,height,quantum,flag,level:t.LEVEL,x:t.X,y:t.Y,vertex:v});
}
assert.ok(counts.source>=1000,`need >=1000 measured posts, got ${counts.source}`);
assert.ok(counts.sphere>0);assert.ok(counts.feather>0);
const queryFile=receipt+'.queries.json';fs.writeFileSync(queryFile,JSON.stringify(queries));
const reference=fileURLToPath(new URL('reference-source.py',import.meta.url));
const oracle=JSON.parse(execFileSync('python3',[reference,configPath,queryFile],{encoding:'utf8',maxBuffer:4*1024*1024}));
assert.equal(oracle.failed,0,JSON.stringify(oracle.examples));
const wasmPath=fileURLToPath(new URL('../../terrain-source/dist/isomorphic/module.wasm',import.meta.url));
const report={pass:true,naif:cfg.naif,version:cfg.version,files:inventory.length,bytes:inventory.reduce((n,f)=>n+f.bytes,0),inventory,
 sourcePosts:{...oracle,tested:queries.length,classes:counts,moduleSha256:createHash('sha256').update(fs.readFileSync(wasmPath)).digest('hex')},
 sourceSha256:cfg.sourceSha256,decodedTiles:tiles};
fs.writeFileSync(receipt,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({...report,inventory:undefined,receipt}));

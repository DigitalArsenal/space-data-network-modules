// Real-source E2E: ledger -> DTT/JPEG -> independent full-resolution GDAL read.
// Registration evidence is separate and cannot be inferred from tile geometry.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import jpeg from 'jpeg-js';
import {readFile} from './runner.mjs';
const arg=(k,d)=>{const i=process.argv.indexOf('--'+k);return i<0?d:process.argv[i+1]};
const dir=path.resolve(arg('dir')),data=fs.readFileSync(path.join(dir,'ledger.jsonl'));
const entries=data.toString().trim().split('\n').filter(Boolean).map(JSON.parse),results=[];
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
fs.mkdirSync(path.join(dir,'verification'),{recursive:true});
const maxLevel=Math.max(...entries.map(e=>e.unit.level));
// Reproducible sampling spread by a path hash; read whole selected files but
// compare exactly 200 distinct max-level tiles. Every local file is hashed.
const selected=new Set();let selectedTiles=0;
for(const e of entries.filter(e=>e.unit.level===maxLevel).sort((a,b)=>sha(a.path).localeCompare(sha(b.path)))) {
  if(selectedTiles>=200)break;selected.add(e.path);selectedTiles+=e.unit.tiles;
}
let sum=0,pixels=0,energy=0,baseEnergy=0;
for(let i=0;i<entries.length;i++) {
  const e=entries[i],body=fs.readFileSync(path.join(dir,e.path));
  if(body.length!==e.bytes||sha(body)!==e.sha256) throw Error('ledger mismatch '+e.path);
  const tiles=readFile(body).map(t=>t.unpack());
  if(tiles.length!==e.unit.tiles) throw Error('missing tiles');
  if(!selected.has(e.path)) continue;
  const input=path.join(dir,'verification',`${i}.json`),ref=input+'.raw';fs.writeFileSync(input,JSON.stringify(e));
  const r=spawnSync('python3',[fileURLToPath(new URL('./hd-reference.py',import.meta.url)),input,ref],{stdio:'inherit'});
  if(r.status!==0) throw Error('independent source read failed');
  const reference=fs.readFileSync(ref),w=e.unit.tiles*256;
  for(let k=0;k<tiles.length;k++) {
    if(results.length>=200)break;
    const t=tiles[k];
    if(t.X!==e.unit.x+k||t.Y!==e.unit.row||t.LEVEL!==e.unit.level) throw Error('tile geometry mismatch');
    const img=jpeg.decode(Buffer.from(t.PAYLOAD.BYTES),{useTArray:true,formatAsRGBA:true});
    let abs=0;
    for(let y=0;y<256;y++) for(let x=0;x<256;x++) abs+=Math.abs(img.data[4*(y*256+x)]-reference[y*w+k*256+x]);
    sum+=abs;pixels+=65536;results.push({x:t.X,y:t.Y,level:t.LEVEL,meanAbs:abs/65536});
  }
  energy+=e.provenance.highFrequencyEnergy*tiles.length;baseEnergy+=e.provenance.baseHighFrequencyEnergy*tiles.length;
  fs.unlinkSync(ref);
}
const report={ledgerSha256:sha(data),sampledTiles:results.length,meanAbs:sum/pixels,sharpnessRatio:energy/baseEnergy,
  independentReference:'GDAL ReadAsArray full-resolution source pixels + independent NumPy pixel-center interpolation; no encoder Warp',
  featuresRegistered:0,maxFeatureErrorPixels:null,boundarySeamMeanAbs:null,pass:false,results};
report.sourcePass=results.length>=200&&report.meanAbs<=1.5;
fs.writeFileSync(path.join(dir,'verification.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({...report,results:undefined}));
process.exit(report.sourcePass?0:1);

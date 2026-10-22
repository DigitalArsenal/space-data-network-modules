// Conditional, level-scoped publication. Each local tile is deleted only after
// its complete remote bytes pass SHA256. No root or base manifest is rewritten.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {HD_SOURCES,validateKey} from './hd-scope.mjs';
const exec=promisify(execFile),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const arg=(k,d)=>{const i=process.argv.indexOf('--'+k);return i<0?d:process.argv[i+1]};
if(!arg('dir')||!arg('prefix')||!arg('gate')||!process.env.R2_AWS) throw Error('usage: R2_AWS=wrapper hd-publish --dir DIR --prefix PREFIX --gate verification.json');
const dir=path.resolve(arg('dir')),prefix=arg('prefix'),plan=JSON.parse(fs.readFileSync(path.join(dir,'PLAN.json'))),s=HD_SOURCES[plan.source];
const data=fs.readFileSync(path.join(dir,'ledger.jsonl')),entries=data.toString().trim().split('\n').filter(Boolean).map(JSON.parse);
const gate=JSON.parse(fs.readFileSync(arg('gate'))),digest=sha(data);
const staging=prefix.startsWith('staging/imagery-hd/');
const boundedError=(value,maximum)=>Number.isFinite(value)&&value>=0&&value<=maximum;
if(!entries.length||gate.ledgerSha256!==digest||gate.sourcePass!==true||!Number.isInteger(gate.sampledTiles)||gate.sampledTiles<200||!boundedError(gate.meanAbs,1.5))
  throw Error('staging requires 200 independent source comparisons and a matching ledger');
if(!staging&&(gate.pass!==true||!Number.isInteger(gate.featuresRegistered)||gate.featuresRegistered<10||!boundedError(gate.maxFeatureErrorPixels,1)||
   !boundedError(gate.boundarySeamMeanAbs,255)||(s.naif===301&&!(Number.isFinite(gate.sharpnessRatio)&&gate.sharpnessRatio>1))))
  throw Error('served publication requires registration, seam and sharpness evidence');
const commands=process.env.R2_AWS.split(' ').filter(Boolean);
const aws=async args=>(await exec(commands[0],[...commands.slice(1),...args],{maxBuffer:64*1024*1024,encoding:'buffer'})).stdout;
if(entries.length!==plan.windows.length) throw Error('ledger does not cover the exact requested plan');
const keys=new Set();
for(const e of entries) {
  if(!e.path.startsWith(`imagery/${s.naif}/`)) throw Error('ledger path belongs to another source');
  e.key=prefix+e.path.slice(`imagery/${s.naif}`.length);
  validateKey(e.key,s.naif,plan.levels,prefix);
  if(keys.has(e.key)) throw Error('duplicate ledger key');keys.add(e.key);
  if(!plan.windows.some(w=>w.level===e.unit.level&&w.row===e.unit.row&&w.x===e.unit.x&&w.tiles===e.unit.tiles)) throw Error('ledger window outside requested region');
  const file=path.join(dir,e.path);
  if(fs.existsSync(file)&&(fs.statSync(file).size!==e.bytes||sha(fs.readFileSync(file))!==e.sha256)) throw Error(`local ledger mismatch ${e.path}`);
}
async function read(key) {
  try { return await aws(['s3','cp',`s3://spaceaware/${key}`,'-','--only-show-errors']); }
  catch(e) {if(/NoSuchKey|Not Found|404/.test(String(e.stderr))) return null;throw e;}
}
// One fixed pool; no respawning workers. The wrapper owns adaptive retries.
async function pool(items,fn) {
  let next=0,failed;
  await Promise.all(Array.from({length:Math.min(64,items.length)},async()=>{
    while(!failed&&next<items.length){const i=next++;try{await fn(items[i]);}catch(e){failed??=e;}}
  }));
  if(failed) throw failed;
}
// Preflight every existing object before issuing a PUT. A concurrent writer is
// still protected by If-None-Match: *. Existing identical bytes are never PUT.
await pool(entries,async e=>{
  const old=await read(e.key);
  if(old&&sha(old)!==e.sha256) throw Error(`refusing overwrite ${e.key}`);
  e.exists=!!old;
  if(!old&&!fs.existsSync(path.join(dir,e.path))) throw Error(`missing local and remote tile ${e.path}`);
});
let verified=0;
await pool(entries,async e=>{
  const file=path.join(dir,e.path);
  if(!e.exists) await aws(['s3api','put-object','--bucket','spaceaware','--key',e.key,'--body',file,'--if-none-match','*','--content-type','application/octet-stream']);
  const back=await read(e.key);
  if(!back||back.length!==e.bytes||sha(back)!==e.sha256) throw Error(`round-trip failed ${e.key}`);
  fs.appendFileSync(path.join(dir,'uploaded.jsonl'),JSON.stringify({key:e.key,bytes:e.bytes,sha256:e.sha256})+'\n');
  if(fs.existsSync(file)) fs.unlinkSync(file);
  verified++;
});
const polygons=plan.windows.map(w=>{const d=180/2**w.level,a=-180+w.x*d,b=-90+w.row*d;return [[a,b],[a+w.tiles*d,b],[a+w.tiles*d,b+d],[a,b+d],[a,b]];});
const manifest={naif:s.naif,source:s,levels:plan.levels,coverage:{type:'MultiPolygon',coordinates:polygons.map(p=>[p])},
  jpegQuality:plan.jpegQuality,
  credit:s.credit,license:s.license,licenseUrl:s.licenseUrl,files:entries.length,bytes:entries.reduce((a,e)=>a+e.bytes,0),ledgerSha256:digest,
  staging,publicationApproved:!staging,verification:gate,baseManifest:`imagery/${s.naif}/MANIFEST.json`};
// Extension metadata stays with this immutable release; the served base
// manifest and root remain byte-for-byte intact. Reader discovery is separate.
for(const [name,body] of [['MANIFEST.json',JSON.stringify(manifest,null,2)+'\n'],['SHA256SUMS',entries.map(e=>`${e.sha256}  ${e.key}`).join('\n')+'\n']]) {
  const key=`${prefix}/releases/${digest}/${name}`,file=path.join(dir,name);fs.writeFileSync(file,body);
  const old=await read(key);
  if(old&&sha(old)!==sha(body)) throw Error(`immutable metadata collision ${key}`);
  if(!old) await aws(['s3api','put-object','--bucket','spaceaware','--key',key,'--body',file,'--if-none-match','*']);
  if(sha(await read(key))!==sha(body)) throw Error('metadata round-trip mismatch');
}
console.log(JSON.stringify({verified,bytes:manifest.bytes,ledgerSha256:digest,prefix}));

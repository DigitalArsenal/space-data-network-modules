// Storage/encoding E2E, isolated filesystem S3 transport. Synthetic receipt is
// exclusively a test fixture; this test does not certify planetary imagery.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {openHdRunner} from '../tools/big/hd-runner.mjs';
import {readFile} from '../tools/big/runner.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const work=process.env.HD_E2E_WORK;
if(!work) throw Error('HD_E2E_WORK must name persistent scratch');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
test('HD WASM, CLI scopes, conditional publication and verified cleanup',async()=>{
  fs.mkdirSync(work,{recursive:true});
  const dir=fs.mkdtempSync(path.join(work,'e2e-')),bucket=path.join(dir,'bucket');fs.mkdirSync(bucket);
  const aws=path.join(dir,'aws.mjs');
  fs.writeFileSync(aws,`#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';
const a=process.argv.slice(2),get=k=>a[a.indexOf(k)+1],root=process.env.TEST_BUCKET;
const key=p=>path.join(root,p.replace('s3://spaceaware/',''));
if(a[0]==='s3'&&a[1]==='cp'){const p=key(a[2]);if(!fs.existsSync(p)){console.error('404 NoSuchKey');process.exit(1)}process.stdout.write(fs.readFileSync(p));}
else if(a[1]==='put-object'){const p=key(get('--key'));if(get('--if-none-match')!=='*')throw Error('unconditional put');fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,fs.readFileSync(get('--body')),{flag:'wx'});fs.appendFileSync(path.join(root,'puts.log'),get('--key')+'\\n');process.stdout.write('{}');}
else if(a[1]==='list-objects-v2')process.stdout.write(JSON.stringify({KeyCount:1,Contents:[{Key:'imagery/301/root.dtts',Size:8}]}));
else throw Error('unexpected command '+a.join(' '));
`,{mode:0o700});
  const runner=await openHdRunner();
  const unit={source:'moon-lo-uvvis',level:9,row:280,x:448,tiles:16};
  const raster=Buffer.from(Array.from({length:16*65536},(_,i)=>32+(i%192)));
  let files;
  try {
    files=await runner.encode(unit,raster);
    assert.deepEqual(files,await runner.encode(unit,raster),'repeat invocation byte determinism');
    assert.equal(files.length,1);assert.equal(readFile(files[0].bytes).length,16);
    for(const bad of [{...unit,level:8},{...unit,x:449},{...unit,tiles:17},{...unit,row:-1},{...unit,source:'mars-ctx-mc13',level:9}])
      await assert.rejects(runner.encode(bad,raster));
  } finally {await runner.destroy();}
  const output=path.join(dir,'out');fs.mkdirSync(output);
  const f=files[0],local=path.join(output,f.path);fs.mkdirSync(path.dirname(local),{recursive:true});fs.writeFileSync(local,f.bytes);
  const ledger=JSON.stringify({path:f.path,bytes:f.bytes.length,sha256:sha(f.bytes),unit})+'\n';
  fs.writeFileSync(path.join(output,'ledger.jsonl'),ledger);
  fs.writeFileSync(path.join(output,'PLAN.json'),JSON.stringify({source:unit.source,levels:[9],bbox:[-22.5,8.4375,-16.875,8.7890625],windows:[unit]}));
  const gate=path.join(dir,'synthetic-storage-gate.json');
  fs.writeFileSync(gate,JSON.stringify({testFixture:true,ledgerSha256:sha(ledger),pass:true,sampledTiles:200,meanAbs:0,featuresRegistered:10,maxFeatureErrorPixels:0,boundarySeamMeanAbs:0,sharpnessRatio:2}));
  const env={...process.env,R2_AWS:aws,TEST_BUCKET:bucket};
  const run=(script,args)=>spawnSync(process.execPath,[path.join(root,'tools/big',script),...args],{env,encoding:'utf8'});
  const prefix='staging/imagery-hd/e2e/301',remote=path.join(bucket,prefix,'9/28_280.dtts');
  const args=['--dir',output,'--prefix',prefix,'--gate',gate];
  fs.mkdirSync(path.dirname(remote),{recursive:true});fs.writeFileSync(remote,'foreign object');
  assert.notEqual(run('hd-publish.mjs',args).status,0);assert.equal(fs.readFileSync(remote,'utf8'),'foreign object');assert.ok(fs.existsSync(local));
  fs.unlinkSync(remote);
  const first=run('hd-publish.mjs',args);assert.equal(first.status,0,first.stderr);
  assert.equal(sha(fs.readFileSync(remote)),sha(f.bytes));assert.equal(fs.existsSync(local),false,'delete only verified local tile');
  const puts=fs.readFileSync(path.join(bucket,'puts.log'),'utf8');
  assert.equal(run('hd-publish.mjs',args).status,0,'resume reads already published objects');
  assert.equal(fs.readFileSync(path.join(bucket,'puts.log'),'utf8'),puts,'resume issues no PUT');
  const rejected=run('run.mjs',['--source','mercury-mdis-bdr','--out',output]);
  assert.notEqual(rejected.status,0);assert.match(rejected.stderr,/already contains published/);
  console.log(JSON.stringify({deterministicInvokes:2,rejectedInvalidWindows:5,conflictingObjectsPreserved:1,roundTripFiles:1,resumePuts:0,fullPyramidRefusals:1,scope:'synthetic storage E2E only'}));
});

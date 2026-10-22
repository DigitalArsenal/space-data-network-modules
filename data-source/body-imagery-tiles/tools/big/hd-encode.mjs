// Explicit levels/region only: no reductions, roots, manifest updates or remote writes.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {planWindows,HD_SOURCES} from './hd-scope.mjs';
import {openHdRunner} from './hd-runner.mjs';
const arg=(k,d)=>{const i=process.argv.indexOf('--'+k);return i<0?d:process.argv[i+1]};
if(!arg('out')||!arg('levels')||!arg('bbox')) throw Error('usage: hd-encode --source KEY --out DIR --levels 9 --bbox west,south,east,north [--stretch low,high]');
const source=arg('source'),out=path.resolve(arg('out')),levels=arg('levels').split(',').map(Number),bbox=arg('bbox').split(',').map(Number);
const windows=planWindows({source,levels,bbox}),s=HD_SOURCES[source];
const stretch=arg('stretch')?.split(',').map(Number);
const plan={source,levels,bbox,stretch:stretch??null,etag:s.etag,windows};
fs.mkdirSync(out,{recursive:true});
const planFile=path.join(out,'PLAN.json'),planText=JSON.stringify(plan,null,2)+'\n';
if(fs.existsSync(planFile)&&fs.readFileSync(planFile,'utf8')!==planText) throw Error('output directory belongs to a different plan');
fs.writeFileSync(planFile,planText);
const ledgerPath=path.join(out,'ledger.jsonl');
const ledger=fs.existsSync(ledgerPath)?fs.readFileSync(ledgerPath,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const runner=await openHdRunner();
try {
  for(const unit of windows) {
    const name=`imagery/${s.naif}/${unit.level}/${unit.x>>4}_${unit.row}.dtts`,file=path.join(out,name);
    const prior=ledger.find(e=>e.path===name);
    if(prior&&fs.existsSync(file)&&sha(fs.readFileSync(file))===prior.sha256) continue;
    if(prior&&!fs.existsSync(file)) throw Error('verified/deleted output requires a new run directory; refusing ambiguous resume');
    if(os.loadavg()[0]>=30) throw Error('load average >=30; resume when load permits');
    const raw=path.join(out,'sources',source,`${unit.level}-${unit.x}-${unit.row}.raw`);
    const args=[fileURLToPath(new URL('./hd-prepare.py',import.meta.url)),...Object.entries(unit).flatMap(([k,v])=>['--'+k,String(v)]),'--out',raw,...(stretch?['--stretch',...stretch.map(String)]:[])];
    const r=spawnSync('python3',args,{stdio:'inherit',env:{...process.env,TMPDIR:out}});
    if(r.status!==0) throw Error('bounded source preparation failed');
    const provenance=JSON.parse(fs.readFileSync(raw.replace(/\.raw$/,'.json')));
    for(const f of await runner.encode(unit,fs.readFileSync(raw))) {
      if(f.path!==name) throw Error('module wrote outside selected window');
      fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.part',f.bytes);fs.renameSync(file+'.part',file);
      const e={path:f.path,bytes:f.bytes.length,sha256:sha(f.bytes),md5:crypto.createHash('md5').update(f.bytes).digest('hex'),unit,provenance};
      const existing=ledger.findIndex(q=>q.path===e.path);
      if(existing<0) ledger.push(e); else ledger[existing]=e;
      fs.writeFileSync(ledgerPath+'.part',ledger.map(q=>JSON.stringify(q)).join('\n')+'\n');
      fs.renameSync(ledgerPath+'.part',ledgerPath);
      console.log(JSON.stringify({encoded:f.path,bytes:e.bytes,sha256:e.sha256}));
    }
    fs.unlinkSync(raw);
  }
} finally { await runner.destroy(); }

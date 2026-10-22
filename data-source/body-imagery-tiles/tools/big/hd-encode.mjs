// Explicit levels/region only: no reductions, roots, manifest updates or remote writes.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {planWindows,HD_SOURCES} from './hd-scope.mjs';
import {openHdRunner} from './hd-runner.mjs';
const arg=(k,d)=>{const i=process.argv.indexOf('--'+k);return i<0?d:process.argv[i+1]};
if(!arg('out')||!arg('levels')||!arg('bbox')) throw Error('usage: hd-encode --source KEY --out DIR --levels 9 --bbox west,south,east,north [--stretch low,high]');
const source=arg('source'),out=path.resolve(arg('out')),levels=arg('levels').split(',').map(Number),bbox=arg('bbox').split(',').map(Number);
const windows=planWindows({source,levels,bbox}),s=HD_SOURCES[source];
const stretch=arg('stretch')?.split(',').map(Number);
const plan={source,levels,bbox,stretch:stretch??null,etag:s.etag,jpegQuality:95,windows};
fs.mkdirSync(out,{recursive:true});
const planFile=path.join(out,'PLAN.json'),planText=JSON.stringify(plan,null,2)+'\n';
if(fs.existsSync(planFile)&&fs.readFileSync(planFile,'utf8')!==planText) throw Error('output directory belongs to a different plan');
if(!fs.existsSync(planFile))fs.writeFileSync(planFile,planText,{flag:'wx'});
const workers=Number(arg('workers',1)),slice=arg('worker');
if(!Number.isInteger(workers)||workers<1||workers>6)throw Error('workers must be 1..6');
const parts=path.join(out,'worker-ledgers');fs.mkdirSync(parts,{recursive:true});
const readLedger=p=>fs.existsSync(p)?fs.readFileSync(p,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
const mergeLedgers=()=>{
  const byPath=new Map(readLedger(path.join(out,'ledger.jsonl')).map(e=>[e.path,e]));
  for(const name of fs.readdirSync(parts).filter(n=>n.endsWith('.jsonl')).sort())for(const e of readLedger(path.join(parts,name)))byPath.set(e.path,e);
  return [...byPath.values()].sort((a,b)=>a.path.localeCompare(b.path));
};
if(workers>1&&!slice){
  // One fixed process set. Workers never launch workers or restart themselves.
  const results=await Promise.all(Array.from({length:workers},(_,k)=>new Promise(resolve=>{
    const child=spawn(process.execPath,[fileURLToPath(import.meta.url),...process.argv.slice(2),'--worker',`${k}/${workers}`],{stdio:'inherit'});
    child.on('error',()=>resolve(1));child.on('exit',code=>resolve(code??1));
  })));
  const dest=path.join(out,'ledger.jsonl');fs.writeFileSync(dest+'.part',mergeLedgers().map(e=>JSON.stringify(e)).join('\n')+'\n');fs.renameSync(dest+'.part',dest);
  process.exit(results.some(c=>c!==0)?1:0);
}
const [worker,count]=slice?slice.split('/').map(Number):[0,1];
if(!Number.isInteger(worker)||!Number.isInteger(count)||worker<0||worker>=count||count!==workers)throw Error('invalid worker slice');
const ledgerPath=slice?path.join(parts,`${worker}-of-${count}.jsonl`):path.join(out,'ledger.jsonl');
const known=new Map(mergeLedgers().map(e=>[e.path,e])),ledger=readLedger(ledgerPath);
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const runner=await openHdRunner();
try {
  for(const [index,unit] of windows.entries()) {
    if(index%count!==worker)continue;
    const name=`imagery/${s.naif}/${unit.level}/${unit.x>>4}_${unit.row}.dtts`,file=path.join(out,name);
    const prior=known.get(name);
    if(prior&&fs.existsSync(file)&&sha(fs.readFileSync(file))===prior.sha256) continue;
    if(prior&&!fs.existsSync(file)) throw Error('verified/deleted output requires a new run directory; refusing ambiguous resume');
    if(os.loadavg()[0]>=30) throw Error('load average >=30; resume when load permits');
    const raw=path.join(out,'sources',source,`${unit.level}-${unit.x}-${unit.row}.raw`);
    const args=[fileURLToPath(new URL('./hd-prepare.py',import.meta.url)),...Object.entries(unit).flatMap(([k,v])=>['--'+k,String(v)]),'--out',raw,...(stretch?['--stretch',...stretch.map(String)]:[])];
    const r=spawnSync('python3',args,{stdio:'inherit',env:{...process.env,TMPDIR:out}});
    if(r.status!==0) throw Error('bounded source preparation failed');
    const provenance=JSON.parse(fs.readFileSync(raw.replace(/\.raw$/,'.json')));
    provenance.jpegQuality=95;
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

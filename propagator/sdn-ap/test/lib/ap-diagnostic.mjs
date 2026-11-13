// Build a test-only module from the checkout's sources, adding read-only probes.
// The production module still supplies every fitted and propagated test state.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {scratchRoot} from './scratch.mjs';
const moduleRoot=fileURLToPath(new URL('../../',import.meta.url));
const modulesRoot=path.resolve(moduleRoot,'../..');
// `others`: { 'file.inc': (text) => text } for source parts other than xp_theory.inc (a test build's own seams)
export function buildDiagnostic(name,extra,transform=s=>s,others={}){
 // a fresh tree each time: nothing of an earlier build (sources, links, outputs) is read
 const root=path.join(scratchRoot,name);fs.rmSync(root,{recursive:true,force:true});
 const dir=path.join(root,'propagator/sdn-ap');fs.mkdirSync(dir,{recursive:true});
 const foundation=path.join(root,'foundation');fs.symlinkSync(path.join(modulesRoot,'foundation'),foundation,'dir');
 for(const f of ['build.mjs','package.json','plugin-manifest.json','LICENSE','NOTICE'])fs.copyFileSync(path.join(moduleRoot,f),path.join(dir,f));
 for(const d of ['src','LICENSES'])fs.cpSync(path.join(moduleRoot,d),path.join(dir,d),{recursive:true});
 // the checkout's own packages
 fs.symlinkSync(path.join(moduleRoot,'node_modules'),path.join(dir,'node_modules'),'dir');
 const p=path.join(dir,'src/xp_theory.inc');fs.writeFileSync(p,transform(fs.readFileSync(p,'utf8')));
 for(const [f,t] of Object.entries(others)){const q=path.join(dir,'src',f);const before=fs.readFileSync(q,'utf8'),after=t(before);if(after===before)throw new Error(`buildDiagnostic ${name}: ${f} unchanged`);fs.writeFileSync(q,after);}
 fs.appendFileSync(path.join(dir,'src/sdn_ap_module.cpp'),'\n'+extra+'\n');
 const log=fs.openSync(path.join(root,'build.log'),'w');
 // a test build is never signed, whatever the caller's environment holds
 const env={...process.env,SDM_MODULE_UNSIGNED_BUILD:'1',SPACE_DATA_NETWORK_MODULES_ROOT:modulesRoot};delete env.SDM_MODULE_SIGNING_KEYPAIR_PATH;
 try{execFileSync(process.execPath,['build.mjs'],{cwd:dir,env,stdio:['ignore',log,log]});}finally{fs.closeSync(log);}
 return path.join(dir,'dist/isomorphic/module.wasm');
}

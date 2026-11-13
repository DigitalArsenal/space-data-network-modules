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
 try{execFileSync(process.execPath,['build.mjs'],{cwd:dir,env:{...process.env,SDNAP_DIAGNOSTIC_BUILD:'1',SPACE_DATA_NETWORK_MODULES_ROOT:modulesRoot},stdio:['ignore',log,log]});}finally{fs.closeSync(log);}
 return path.join(dir,'dist/isomorphic/module.wasm');
}

// The test-only seam of the counted allocator (src/constants.inc): the Nth counted allocation of a call fails, counted as a failed allocation, and the count of
// a call is exported. Every replace must match: one that matched nothing (the source moved under it) throws, so a seam never silently stops failing a site.
const replacing=(...pairs)=>s=>{for(const [a,b] of pairs){if(!s.includes(a))throw new Error(`failureSeam: no match for ${JSON.stringify(a.slice(0,70))}`);s=s.replace(a,b);}return s;};
export const failureSeam={'constants.inc':replacing(
 ['inline uint32_t g_failures = 0;','inline uint32_t g_failures = 0;\ninline uint32_t g_test_fail_at = 0, g_test_count = 0;\ninline bool test_should_fail() { ++g_test_count; return g_test_fail_at != 0 && g_test_count == g_test_fail_at; }'],
 ['inline void* malloc(size_t n) {\n  void* p = std::malloc(n);','inline void* malloc(size_t n) {\n  if (test_should_fail()) { note_failure(n); return nullptr; }\n  void* p = std::malloc(n);'],
 ['inline void* calloc(size_t k, size_t n) {\n  void* p = std::calloc(k, n);','inline void* calloc(size_t k, size_t n) {\n  if (test_should_fail()) { note_failure(k * n); return nullptr; }\n  void* p = std::calloc(k, n);'],
 ['inline T* counted(T* p, size_t n = sizeof(T)) {\n  if (p == nullptr) note_failure(n);','inline T* counted(T* p, size_t n = sizeof(T)) {\n  if (p != nullptr && test_should_fail()) { if (n == sizeof(T)) { p->~T(); ::operator delete(p); } else ::operator delete[](p); p = nullptr; }\n  if (p == nullptr) note_failure(n);'])};
export const failureProbe=`
SDNAP_EXPORT("sdnap_test_fail_at") void sdnap_test_fail_at(uint32_t n) { sdnap::mem::g_test_fail_at = n; sdnap::mem::g_test_count = 0; }
SDNAP_EXPORT("sdnap_test_alloc_count") uint32_t sdnap_test_alloc_count(void) { return sdnap::mem::g_test_count; }`;

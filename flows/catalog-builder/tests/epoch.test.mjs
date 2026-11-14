import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
// UTC civil arithmetic: exact integer nanoseconds, no orbital reference frame.
// The policy is strictly below 1 ms; boundary fixtures use decimal UTC values.
test('shared UTC interval policy rejects exact millisecond boundaries',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'catalog-epoch-'));
 try{
  const header=fileURLToPath(new URL('../../../common/catalog_epoch.hpp',import.meta.url));
  const code=fs.readFileSync(header,'utf8')+`
#include <cassert>
int main(){
   using catalog_epoch::matches;
   assert(matches("2026-01-01T00:00:00Z","2026-01-06T00:00:00.000999999Z",432000));
   assert(!matches("2026-01-01T00:00:00Z","2026-01-06T00:00:00.001Z",432000));
   assert(matches("2026-01-01T00:00:00.000000001Z","2026-01-06T00:00:00.001Z",432000));
   assert(!matches("2026-01-01T00:00:00.001Z","2026-01-06T00:00:00Z",432000));
   assert(matches("2026-01-01T00:00:00.0005Z","2025-12-29T12:00:00.001Z",-216000));
  }`;
  const src=path.join(dir,'test.cpp'),bin=path.join(dir,'test');fs.writeFileSync(src,code);
  let p=spawnSync('clang++',['-std=c++17',src,'-o',bin],{encoding:'utf8'});assert.equal(p.status,0,p.stderr);
  p=spawnSync(bin,[],{encoding:'utf8'});assert.equal(p.status,0,p.stderr);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

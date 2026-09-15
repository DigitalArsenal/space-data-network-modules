// JavaScript only compiles and runs C++; physics and independent references
// are in finite_burn_native.cpp. Native results supplement WASM/runtime parity.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
const here=dirname(fileURLToPath(import.meta.url));
const repo=resolve(here,'../../..');
test('HPOP finite burns: Orekit, rocket equation, spiral, impulsive limit, frames, STM and events',t=>{
 if(spawnSync('c++',['--version'],{stdio:'ignore'}).status!==0)return t.skip('host C++ compiler unavailable; numerical evidence not produced');
 const work=mkdtempSync(join(tmpdir(),'sdn-hpop-finite-'));
 const lib=join(here,'../lib'),nrl=join(repo,'third_party/nrlmsise00');
 try {
  const objects=[];
  for(const name of ['nrlmsise-00.c','nrlmsise-00_data.c']){
   const object=join(work,`${name}.o`);objects.push(object);
   execFileSync('cc',['-std=c11','-O2','-c',join(nrl,name),'-o',object],{stdio:'pipe'});
  }
  const binary=join(work,'finite-burn');
  execFileSync('c++',['-std=c++17','-O2','-I',lib,'-I',nrl,join(here,'finite_burn_native.cpp'),
   ...['astrodynamics','coords','ephemeris','environment_models','force_models','force_partials','finite_burn','variational','integrators','nrlmsise00','time_convert','us76','atmosphere_plugin'].map(n=>join(lib,`${n}.cpp`)),
   ...objects,'-o',binary],{stdio:'pipe'});
  const run=spawnSync(binary,[],{encoding:'utf8',timeout:240000});
  process.stdout.write(run.stdout??'');
  assert.equal(run.status,0,`${run.stdout}\n${run.stderr}\n${run.error??''}`);
  assert.match(run.stdout,/PASS HPOP finite burns .*failures=0/);
  for(const name of ['Orekit_mass_kg','Orekit_inclination_deg','Orekit_semimajor_km','Tsiolkovsky_deltaV_km_s','Edelbaum_spiral_semimajor_km','impulsive_limit_final_balanced_km'])
   assert.match(run.stdout,new RegExp(`RESULT ${name} .* PASS`));
 } finally {rmSync(work,{recursive:true,force:true});}
});

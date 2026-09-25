// Host orchestration only. Independent expected physics and actual HPOP forces
// are evaluated in C++; source/units/frame/time/tolerances are in the harness.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
const here=dirname(fileURLToPath(import.meta.url));
const repo=resolve(here,'../../..');
test('HPOP third-body and SRP forces consume authoritative DE440 vectors',(t)=>{
  if(spawnSync('c++',['--version'],{stdio:'ignore'}).status!==0) return t.skip('host C++ compiler unavailable');
  const work=mkdtempSync(join(tmpdir(),'sdn-de440-force-'));
  const lib=join(here,'../lib'),nrl=join(repo,'third_party/nrlmsise00');
  try {
    const objects=[];
    for(const name of ['nrlmsise-00.c','nrlmsise-00_data.c']) {
      const object=join(work,`${name}.o`);objects.push(object);
      execFileSync('cc',['-std=c11','-O2','-c',join(nrl,name),'-o',object],{stdio:'pipe'});
    }
    const binary=join(work,'de440-force');
    execFileSync('c++',['-std=c++17','-O2','-I',lib,'-I',nrl,'-I',join(repo,'third_party/hwm14'),join(repo,'third_party/hwm14/hwm14.cpp'),join(repo,'third_party/hwm14/hwm14_data.cpp'),join(here,'de440_force_native.cpp'),
      ...['astrodynamics','coords','ephemeris','environment_models','force_models','atmosphere_winds','integrators','nrlmsise00','time_convert','us76','atmosphere_plugin'].map(name=>join(lib,`${name}.cpp`)),
      ...objects,'-o',binary],{stdio:'pipe'});
    const run=spawnSync(binary,[join(repo,'files/orbit-products/tests/fixtures/de440')],{encoding:'utf8'});
    process.stdout.write(run.stdout??'');
    assert.equal(run.status,0,`${run.stdout}\n${run.stderr}`);
    const rows=run.stdout.split('\n').filter(line=>line.startsWith('RESULT '));
    assert.equal(rows.length,10);
    for(const row of rows) {const [,,error,tolerance,status]=row.split(' ');assert.equal(status,'PASS');assert.equal(Number(tolerance),1e-18);assert.ok(Number(error)<=1e-18);}
    assert.match(run.stdout,/PASS DE440 force cases=10 failures=0/);
  } finally {rmSync(work,{recursive:true,force:true});}
});

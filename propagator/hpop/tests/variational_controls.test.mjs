// Host orchestration only. The C++ executable checks rejection and dispatch.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here=dirname(fileURLToPath(import.meta.url));
const repo=resolve(here,'../../..');
test('STM controls reject invalid input, preserve dispatch and restore context',()=>{
  const work=mkdtempSync(join(tmpdir(),'sdn-hpop-variational-controls-'));
  const lib=join(here,'../lib'),nrl=join(repo,'third_party/nrlmsise00');
  try {
    const objects=[];
    for(const name of ['nrlmsise-00.c','nrlmsise-00_data.c']) {
      const object=join(work,`${name}.o`);objects.push(object);
      execFileSync('cc',['-std=c11','-O2','-c',join(nrl,name),'-o',object],{stdio:'pipe'});
    }
    const binary=join(work,'controls');
    execFileSync('c++',['-std=c++17','-O2','-I',lib,'-I',nrl,'-I',join(repo,'third_party/hwm14'),join(repo,'third_party/hwm14/hwm14.cpp'),join(repo,'third_party/hwm14/hwm14_data.cpp'),
      join(here,'variational_controls_native.cpp'),
      ...['astrodynamics','coords','ephemeris','environment_models','force_models','atmosphere_winds',
        'force_partials','variational','integrators','nrlmsise00','time_convert',
        'us76','atmosphere_plugin'].map(name=>join(lib,`${name}.cpp`)),
      ...objects,'-o',binary],{stdio:'pipe'});
    const run=spawnSync(binary,[],{encoding:'utf8',timeout:30_000});
    process.stdout.write(run.stdout??'');
    assert.equal(run.status,0,`${run.stdout}\n${run.stderr}\n${run.error??''}`);
    assert.match(run.stdout,/PASS HPOP variational controls cases=16 failures=0/);
  } finally {rmSync(work,{recursive:true,force:true});}
});

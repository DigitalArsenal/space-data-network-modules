// Host test orchestration only: all ephemeris calculations run in C++.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here=dirname(fileURLToPath(import.meta.url));
const fixtures=join(here,'fixtures/de440');
const kernels=[
  {filename:'de440s.bsp',sha256:'c1c7feeab882263fc493a9d5a5b2ddd71b54826cdf65d8d17a76126b260a49f2',args:[],count:238},
  {filename:'de440-2026.bsp',sha256:'e612a95953ca8211c629bdb632d4c7483cc339f0e963592bd8cae4a7d24ad7ef',args:['--excerpt'],count:221},
];

for(const fixture of kernels) test(`${fixture.filename} states match independent CSPICE and JPL Horizons references`, (t) => {
  const kernel=join(fixtures,fixture.filename);
  if(!existsSync(kernel)) return t.skip('DE440s fixture absent: python3 files/orbit-products/tests/fixtures/de440/download.py');
  assert.equal(createHash('sha256').update(readFileSync(kernel)).digest('hex'),fixture.sha256,'kernel must be pinned public NAIF DE440s bytes');
  if(spawnSync('c++',['--version'],{stdio:'ignore'}).status!==0) return t.skip('host C++ compiler unavailable');
  const work=mkdtempSync(join(tmpdir(),'sdn-de440-reference-'));
  try {
    const binary=join(work,'de440-reference');
    execFileSync('c++',['-std=c++17','-O2','-I',join(here,'../src'),join(here,'de440_reference_native.cpp'),'-o',binary],{stdio:'pipe'});
    const run=spawnSync(binary,[fixtures,...fixture.args],{encoding:'utf8'});
    process.stdout.write(run.stdout??'');
    assert.equal(run.status,0,`${run.stdout}\n${run.stderr}`);
    for(const [name,bound] of [['de440_cspice_position_km',1e-6],['de440_cspice_velocity_km_s',1e-9],['horizons_de441_position_km',.01],['horizons_de441_velocity_km_s',1e-7]]) {
      const result=run.stdout.split('\n').find(line=>line.startsWith(`RESULT ${name} `));
      assert.ok(result,`missing ${name}`);
      const [, , measured, actualBound, pass]=result.split(' ');
      assert.equal(Number(actualBound),bound);
      assert.equal(pass,'PASS');
      assert.ok(Number(measured)<=bound,`${name}: ${measured} > ${bound}`);
    }
    assert.ok(run.stdout.includes(`PASS DE440 authoritative states=${fixture.count} Horizons states=48 failures=0`));
  } finally { rmSync(work,{recursive:true,force:true}); }
});

test('HPOP uses DE440 input buffer and reports monthly analytic error', (t) => {
  if(spawnSync('c++',['--version'],{stdio:'ignore'}).status!==0) return t.skip('host C++ compiler unavailable');
  const repo=join(here,'../../..');
  const hpop=join(repo,'propagator/hpop/lib');
  const nrl=join(repo,'third_party/nrlmsise00');
  if(!existsSync(join(nrl,'nrlmsise-00.c'))) return t.skip('third_party/nrlmsise00 source missing');
  const work=mkdtempSync(join(tmpdir(),'sdn-de440-hpop-'));
  try {
    const objects=[];
    for(const name of ['nrlmsise-00.c','nrlmsise-00_data.c']) {
      const output=join(work,`${name}.o`);
      execFileSync('cc',['-std=c11','-O2','-c',join(nrl,name),'-o',output],{stdio:'pipe'});
      objects.push(output);
    }
    const binary=join(work,'de440-hpop');
    execFileSync('c++',['-std=c++17','-O2','-DDE440_WITH_HPOP','-I',join(here,'../src'),'-I',hpop,'-I',nrl,
      join(here,'de440_reference_native.cpp'),
      ...['astrodynamics','coords','ephemeris','environment_models','force_models','integrators','nrlmsise00','time_convert','us76','atmosphere_plugin'].map(name=>join(hpop,`${name}.cpp`)),
      ...objects,'-o',binary],{stdio:'pipe'});
    const run=spawnSync(binary,[fixtures,'--excerpt'],{encoding:'utf8'});
    process.stdout.write(run.stdout??'');
    assert.equal(run.status,0,`${run.stdout}\n${run.stderr}`);
    assert.equal(run.stdout.split('\n').filter(line=>line.startsWith('ANALYTIC ')).length,24);
    for(const name of ['hpop_de440_position_km','hpop_de440_velocity_km_s'])
      assert.match(run.stdout,new RegExp(`RESULT ${name} [^\\n]+ PASS`));
  } finally {rmSync(work,{recursive:true,force:true});}
});

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {getFlatbuffersCppRuntimeHeaders} from 'space-data-module-sdk/compiler';
const root=fileURLToPath(new URL('../src/cpp/',import.meta.url));
const generated=fileURLToPath(new URL('../../../licensing/core/src/cpp/generated/sds/',import.meta.url));
for(const fastMath of [false,true]) test(`OCM covariance publication rejects fabricated uncertainty (fast-math=${fastMath})`,async()=>{
    const temp=await fs.mkdtemp(path.join(os.tmpdir(),'sdn-od-covariance-'));
    try {
        for(const [name,content] of Object.entries(await getFlatbuffersCppRuntimeHeaders())) {
            const p=path.join(temp,name);await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,content);
        }
        const exe=path.join(temp,'covariance-test');
        const args=['-std=c++17','-O2',...(fastMath?['-ffast-math']:[]),'-I'+path.join(root,'include'),'-I'+generated,'-I'+temp,
          path.join(root,'tests/test_covariance_publication.cpp'),path.join(root,'src/ocm_fb_builder.cpp'),'-o',exe];
        const build=spawnSync(process.env.CXX??'clang++',args,{encoding:'utf8',timeout:60000});
        assert.equal(build.status,0,build.error?.message??build.stderr);
        const run=spawnSync(exe,[],{encoding:'utf8',timeout:10000});
        assert.equal(run.status,0,run.error?.message??run.stderr);assert.match(run.stdout,/rank gates PASS/);
    } finally {await fs.rm(temp,{recursive:true,force:true});}
});

// Build the candidate C++ library in isolation and exercise public full-state
// reference encounters, then its built CQR artifact through both SDK runtimes.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {values}=parseArgs({options:{'native-only':{type:'boolean',default:false}}});
const build=fs.mkdtempSync(path.join(os.tmpdir(),'ca-nc-cascade-e2e-'));
const cache=path.join(os.homedir(),'.cache/sdn-tools');
const headers=fs.existsSync(cache)?fs.readdirSync(cache).filter(x=>x.startsWith('flatbuffers-include-')).map(x=>path.join(cache,x)).filter(x=>fs.existsSync(path.join(x,'flatbuffers/flatbuffers.h'))):[];
const include=process.env.SDN_FLATBUFFERS_INCLUDE_DIR||(headers.length===1?headers[0]:null);
if(!include)throw Error('Set SDN_FLATBUFFERS_INCLUDE_DIR to the FlatBuffers C++ headers used by the module build');
// Darwin's obsolete math.h SING macro collides with the SDS country enum.
// As in scripts/e2e/sds-1261-consumers.mjs, suppress only that macro after
// loading cmath; neither generated schema bindings nor math are replaced.
const prefix=path.join(build,'native-platform.h');
fs.writeFileSync(prefix,'#include <cmath>\n#ifdef SING\n#undef SING\n#endif\n');
async function run(command,args){
  await new Promise((resolve,reject)=>{const p=spawn(command,args,{cwd:root,stdio:'inherit'});p.once('error',reject);p.once('exit',(code,signal)=>code===0?resolve():reject(Error(`${command}: exit ${code}, signal ${signal}`)));});
}
await run('cmake',['-S','src/cpp','-B',build,'-DCMAKE_BUILD_TYPE=Release',`-DFLATBUFFERS_INCLUDE_DIR=${include}`,`-DCMAKE_CXX_FLAGS=-include "${prefix}"`]);
await run('cmake',['--build',build,'--target','conjunction_assessment','-j','6']);
const executable=path.join(build,'nc-cascade');
await run(process.env.CXX||'c++',['-std=c++17','-O2','-Isrc/cpp/include','tests/native/nc_cascade.cpp',path.join(build,'libconjunction_assessment.a'),path.join(build,'liberfa_lib.a'),'-pthread','-o',executable]);
await run(executable,[path.join(root,'src/cpp/tests/fixtures')]);
if(!values['native-only'])await run(process.execPath,['--test','tests/lowVelocityCovariance.test.mjs']);
console.log(`NC CASCADE E2E PASS${values['native-only']?' (native reference leg only)':''}; build ${build}`);

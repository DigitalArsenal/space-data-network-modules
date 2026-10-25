// Builds tests/gps_srp_accuracy_native.cpp natively (host C++), with the same
// sources, include paths and defines build.mjs gives the WASM artifact, and
// the FlatBuffers C++ runtime headers the SDK compiles it with. Evidence
// tooling for the GPS radiation-pressure experiment (gps-srp-accuracy-*.mjs);
// run `node build.mjs` first (it writes .sdk-build/erfa-amalgamation.cpp).
//   node tests/gps-srp-accuracy-build.mjs <work dir>   -> <work dir>/gps-srp-accuracy
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFlatbuffersCppRuntimeHeaders } from 'space-data-module-sdk';
import { physicsUnits } from '../lib/units.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ffm = path.resolve(here, '..'), repo = path.resolve(ffm, '../..');
const work = path.resolve(process.argv[2] ?? 'gps-srp-accuracy-build');
const manifest = JSON.parse(fs.readFileSync(path.join(ffm, 'plugin-manifest.json'), 'utf8'));
for (const [name, text] of Object.entries(await getFlatbuffersCppRuntimeHeaders())) {
  fs.mkdirSync(path.dirname(path.join(work, 'fb', name)), { recursive: true });
  fs.writeFileSync(path.join(work, 'fb', name), text);
}
const includes = [path.join(ffm, 'lib'), path.join(ffm, 'src'), path.join(ffm, 'src/cpp/include'), path.join(ffm, 'src/cpp/generated'),
  path.join(ffm, 'src/cpp/generated/sds'), path.join(repo, 'third_party/nrlmsise00'), path.join(repo, 'third_party/hwm14'),
  path.join(repo, 'foundation/frames/src'), path.join(repo, 'higherpop/third_party/erfa'), path.join(work, 'fb')].map((p) => `-I${p}`);
const defines = [`-DFFM_MODULE_ID="${manifest.pluginId}"`, `-DFFM_MODULE_VERSION="${manifest.version}"`];
const objects = [];
const compile = (compiler, source, flags) => {
  const object = path.join(work, `${path.basename(source)}.o`);
  execFileSync(compiler, [...flags, '-O2', ...includes, ...defines, '-c', source, '-o', object], { stdio: 'inherit' });
  objects.push(object);
};
for (const name of ['nrlmsise-00.c', 'nrlmsise-00_data.c']) compile('cc', path.join(repo, 'third_party/nrlmsise00', name), ['-std=c11']);
const units = physicsUnits.map((n) => path.join(ffm, 'lib', `${n}.cpp`));
units.push(path.join(repo, 'third_party/hwm14/hwm14.cpp'), path.join(repo, 'third_party/hwm14/hwm14_data.cpp'),
  path.join(ffm, '.sdk-build/erfa-amalgamation.cpp'), path.join(here, 'gps_srp_accuracy_native.cpp'));
for (const unit of units) compile('c++', unit, ['-std=c++17']);
execFileSync('c++', [...objects, '-o', path.join(work, 'gps-srp-accuracy')], { stdio: 'inherit' });
console.log(path.join(work, 'gps-srp-accuracy'));

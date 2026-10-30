// Builds the candidate C++ library natively and checks the radial gate's bound
// on densely sampled SGP4 trajectories (tests/native/radial_gate_bound.cpp).
// Run: node tests/radialGateBound.e2e.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const build = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-radial-gate-'));
const cache = path.join(os.homedir(), '.cache/sdn-tools');
const headers = fs.existsSync(cache) ? fs.readdirSync(cache).filter((x) => x.startsWith('flatbuffers-include-')).map((x) => path.join(cache, x))
  .filter((x) => fs.existsSync(path.join(x, 'flatbuffers/flatbuffers.h'))) : [];
const include = process.env.SDN_FLATBUFFERS_INCLUDE_DIR || (headers.length === 1 ? headers[0] : null);
if (!include) throw Error('Set SDN_FLATBUFFERS_INCLUDE_DIR to the FlatBuffers C++ headers used by the module build');
// Darwin's obsolete math.h SING macro collides with the SDS country enum (as in ncCascade.e2e.mjs).
const prefix = path.join(build, 'native-platform.h');
fs.writeFileSync(prefix, '#include <cmath>\n#ifdef SING\n#undef SING\n#endif\n');
async function run(command, args) {
  await new Promise((resolve, reject) => {
    const p = spawn(command, args, { cwd: root, stdio: 'inherit' });
    p.once('error', reject);
    p.once('exit', (code, signal) => (code === 0 ? resolve() : reject(Error(`${command}: exit ${code}, signal ${signal}`))));
  });
}
await run('cmake', ['-S', 'src/cpp', '-B', build, '-DCMAKE_BUILD_TYPE=Release', `-DFLATBUFFERS_INCLUDE_DIR=${include}`, `-DCMAKE_CXX_FLAGS=-include "${prefix}"`]);
await run('cmake', ['--build', build, '--target', 'conjunction_assessment', '-j', '6']);
const executable = path.join(build, 'radial-gate-bound');
await run(process.env.CXX || 'c++', ['-std=c++17', '-O2', '-include', prefix, '-Isrc/cpp/include', `-I${include}`, 'tests/native/radial_gate_bound.cpp',
  path.join(build, 'libconjunction_assessment.a'), path.join(build, 'liberfa_lib.a'), '-pthread', '-o', executable]);
await run(executable, []);
fs.rmSync(build, { recursive: true, force: true });
console.log('RADIAL GATE BOUND E2E PASS');

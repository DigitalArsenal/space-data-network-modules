#!/usr/bin/env node
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { compileModuleFromSource, cleanupCompilation } from 'space-data-module-sdk/compiler';
import { generateSdsHeaders, packageRoot, standardsRoot } from './generate-sds-headers.mjs';

const cppRoot = path.join(packageRoot, 'src/cpp');
const manifestPath = path.join(packageRoot, 'plugin-manifest.json');
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
// Both generation and SDK standards validation consume this installed release.
process.env.SPACE_DATA_STANDARDS_ROOT = standardsRoot;
const {version, provenance} = await generateSdsHeaders();

// Reuse a repo-local LLVM toolchain via the SDK's public compiler hook, as in
// the HPOP PRW build. Outputs stay in this worktree. No emcc is invoked.
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
  {cwd:packageRoot, encoding:'utf8'}).trim();
let configuredWorktree = '';
try { configuredWorktree = execFileSync('git', ['config', '--get', 'core.worktree'],
  {cwd:packageRoot, encoding:'utf8'}).trim(); } catch {}
const originalRoot = configuredWorktree ? path.resolve(common, configuredWorktree) : path.dirname(common);
const toolchainRoots = [process.env.SDN_LOCAL_EMSDK_DIR, path.join(packageRoot,'deps/emsdk'),
  path.join(originalRoot,'analysis/conjunction-assessment/deps/emsdk'),
  path.join(originalRoot,'propagator/hpop/deps/emsdk')].filter(Boolean);
const llvmRoot = toolchainRoots.find(root => fsSync.existsSync(path.join(root,'upstream/bin/clang++')));
const compiler = process.env.SDN_WASI_CLANGXX || (llvmRoot && path.join(llvmRoot,'upstream/bin/clang++'));
if (!compiler) throw new Error('Set SDN_LOCAL_EMSDK_DIR or SDN_WASI_CLANGXX to a local LLVM/WASI SDK compiler.');
process.env.CQR_SDK_CLANGXX = compiler;
process.env.SDN_WASI_CLANGXX = path.join(packageRoot,'build-driver.mjs');
process.env.SDN_WASI_CLANG = process.env.SDN_WASI_CLANGXX;
await fs.chmod(process.env.SDN_WASI_CLANGXX, 0o755);

// The canonical SDK owns compilation, link, command/PIV bridge and manifest
// exports. Its source API accepts one translation unit, so resolve local
// includes into that unit; all numerical implementation remains C++.
const includeRoots = [path.join(cppRoot,'include'), path.join(cppRoot,'generated/sds'),
  path.join(cppRoot,'generated'), path.join(cppRoot,'deps/sgp4/libsgp4')];
const emitted = new Set();
async function sourceWithIncludes(file) {
  file = path.resolve(file);
  if (emitted.has(file)) return '';
  emitted.add(file);
  const source = await fs.readFile(file,'utf8');
  const lines = [];
  for (const line of source.split('\n')) {
    if (/^\s*#\s*pragma\s+once\s*$/.test(line)) continue;
    const match = /^\s*#\s*include\s+"([^"]+)"\s*(?:\/\/.*)?$/.exec(line);
    if (!match || match[1] === 'space_data_module_invoke.h' || match[1].startsWith('flatbuffers/')) {
      lines.push(line); continue;
    }
    const candidate = [path.dirname(file),...includeRoots].map(root=>path.resolve(root,match[1])).find(p=>fsSync.existsSync(p));
    if (!candidate) throw new Error(`Unresolved module include ${match[1]} from ${path.relative(packageRoot,file)}`);
    lines.push(await sourceWithIncludes(candidate));
  }
  return `\n// Source: ${path.relative(packageRoot,file)}\n${lines.join('\n')}\n`;
}
const caSources = ['conjunction_assessment.cpp','gp_json.cpp','kdtree.cpp',
  'resident_screening_index.cpp','screening_internal.cpp','screening.cpp','screening_tight.cpp',
  'cdm_output.cpp','csm_output.cpp','pc_method.cpp','ephemeris_source.cpp',
  'conjunction_engine.cpp','plugin_invoke_bridge.cpp'];
// sgp4_propagator.cpp is the unused alternate implementation: the historical
// static archive selected conjunction_assessment.cpp for those same symbols.
const sgp4Root = path.join(cppRoot,'deps/sgp4/libsgp4');
const sgp4Sources = (await fs.readdir(sgp4Root)).filter(p=>p.endsWith('.cc')).sort();
const pieces = [];
for(const file of [...sgp4Sources.map(p=>path.join(sgp4Root,p)), ...caSources.map(p=>path.join(cppRoot,'src',p))]) {
  pieces.push(await sourceWithIncludes(file));
}
const sourceCode = pieces.join('\n');
const outputPath = path.join(packageRoot,'dist/isomorphic/module.wasm');
await fs.mkdir(path.dirname(outputPath),{recursive:true});
const result = await compileModuleFromSource({manifest, sourceCode, language:'c++',
  outputPath, standardsRoot, threadModel:'emscripten-pthreads', stackSize:2097152});
try {
  if (!result.report?.ok) throw new Error(`Artifact validation failed: ${JSON.stringify(result.report?.issues)}`);
  if (result.threadModel !== 'emscripten-pthreads') throw new Error('Unexpected canonical thread model');

  const guestDir = path.join(packageRoot, 'dist/guest-link');
  await fs.mkdir(guestDir, {recursive:true});
  await fs.writeFile(path.join(guestDir,'module-link.o'), result.guestLink.objectBytes);
  await fs.writeFile(path.join(guestDir,'metadata.json'), JSON.stringify({
    version:1,format:result.guestLink.format,language:result.guestLink.language,
    threadModel:result.guestLink.threadModel,symbolPrefix:result.guestLink.symbolPrefix,
    methodSymbols:result.guestLink.methodSymbols,capabilities:manifest.capabilities
  },null,2)+'\n');
  await fs.copyFile(manifestPath,path.join(packageRoot,'dist/plugin-manifest.json'));
  await fs.writeFile(path.join(packageRoot,'dist/build-provenance.json'),JSON.stringify({
    standards:{package:provenance.package,version,schemas:provenance.schemas},
    sdk:JSON.parse(await fs.readFile(path.join(packageRoot,'node_modules/space-data-module-sdk/package.json'),'utf8')).version,
    compiler:result.compiler,threadModel:result.threadModel,runtimeTargets:manifest.runtimeTargets,
    sourceSha256:createHash('sha256').update(sourceCode).digest('hex'),
    wasmSha256:createHash('sha256').update(result.wasmBytes).digest('hex'),
    threadFeatures:result.threadFeatures,
    initialization:'Once per resident instance; static destruction deferred to instance teardown',
    compilerVersion:execFileSync(compiler, ['--version'], {encoding:'utf8'}).trim(),
    buildSupportSha256:Object.fromEntries(await Promise.all(
      ['build-driver.mjs','src/cpp/src/cqr_initialization.cpp'].map(async file =>
        [file,createHash('sha256').update(await fs.readFile(path.join(packageRoot,file))).digest('hex')]))),
  },null,2)+'\n');
  console.log(`Built dist/isomorphic/module.wasm (${result.wasmBytes.length} bytes), SDS ${version}; SDK validation PASS`);
} finally { await cleanupCompilation(result); }

// Hosts that require a trusted signer refuse an unsigned artifact
// (missing_signature), so the build signs it with the repo's shared module
// signing step. wasmSha256 above names the unsigned module the signature covers.
execFileSync(process.execPath, [path.join(packageRoot, '../../scripts/sign-module-artifact.mjs'), outputPath],
  {stdio:'inherit'});

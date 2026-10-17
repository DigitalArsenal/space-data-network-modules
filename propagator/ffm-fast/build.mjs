import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { compileModuleFromSource, cleanupCompilation } from 'space-data-module-sdk/compiler';
import { composeErfaTranslationUnit } from '../../foundation/frames/erfa-amalgamation.mjs';
import { STANDARD, packageRoot, standardRoot } from './standard.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, 'plugin-manifest.json'), 'utf8'));
const standardsRoot = path.join(packageRoot, 'node_modules/spacedatastandards.org');
const buildDir = path.join(packageRoot, '.sdk-build');
await fs.mkdir(buildDir, { recursive: true });
const scratchDir = path.join(buildDir, 'tmp');
await fs.mkdir(scratchDir, { recursive: true });
// The SDK and clang both honor these paths; all generated files stay here.
process.env.TMPDIR = scratchDir;
process.env.TMP = scratchDir;
process.env.TEMP = scratchDir;
process.env.CLANG_MODULE_CACHE_PATH = path.join(buildDir, 'clang-module-cache');
const marker = path.join(buildDir, 'standard-read-only.marker');
await fs.writeFile(marker, 'The standard source directory is read-only.\n');

// Use the provisioned local SDK explicitly. Never discover a system compiler,
// invoke emcc, generate bindings in the standard tree, or consult repository state.
const emsdk = process.env.SDN_LOCAL_EMSDK_DIR ?? path.join(packageRoot, 'deps/emsdk');
if (!fsSync.existsSync(path.join(emsdk, 'upstream/bin/clang++')))
  throw new Error('A repo-local emsdk LLVM toolchain is required; set SDN_LOCAL_EMSDK_DIR. This build never invokes emcc.');
const libDir = path.join(emsdk, 'upstream/emscripten/cache/sysroot/lib/wasm32-emscripten/lto');
const exceptionLibraries = ['libc++abi-ww-wasmexcept.a', 'libunwind-ww-wasmexcept.a'].map(n => path.join(libDir, n));
for (const file of exceptionLibraries)
  if (!fsSync.existsSync(file)) throw new Error(`Missing LLVM standard Wasm EH runtime archive ${file}`);

const forkSource = await fs.readFile(path.join(packageRoot, 'lib/force_models.cpp'), 'utf8');
const forkBase = forkSource.match(/^\/\/\s*FFM Fast fork base:\s*(.+)$/m)?.[1]?.trim();
const forkBaseSha256 = forkSource.match(/^\/\/\s*Fork base sha256:\s*([a-f0-9]{64})$/mi)?.[1];
const standardForceSha256 = sha256(await fs.readFile(path.join(standardRoot, 'lib/force_models.cpp')));
if (!forkBase || forkBaseSha256 !== standardForceSha256)
  throw new Error('The standard lib/force_models.cpp changed; merge the standard changes into the FFM Fast fork and update its fork base SHA-256.');
const standardWasmSha256 = sha256(await fs.readFile(path.join(standardRoot, 'dist/isomorphic/module.wasm')));

const units = ['astrodynamics', 'integrators', 'variational', 'finite_burn', 'force_partials', 'coords', 'atmosphere_plugin', 'environment_models', 'ephemeris', 'force_models', 'atmosphere_winds', 'nrlmsise00', 'time_convert', 'us76']
  .map(n => path.join(n === 'force_models' ? packageRoot : standardRoot, `lib/${n}.cpp`));
units.push(path.join(packageRoot, 'lib/ffm_gravity.cpp'));
units.push(...[
  '../../third_party/hwm14/hwm14.cpp', '../../third_party/hwm14/hwm14_data.cpp',
  '../../third_party/nrlmsise00/nrlmsise-00.c', '../../third_party/nrlmsise00/nrlmsise-00_data.c',
  'src/hpop_plugin.cpp', 'src/cpp/src/prw_execution.cpp', 'src/cpp/src/prw_dynamics.cpp',
  'src/cpp/src/resident_dynamics.cpp', 'src/cpp/src/kernel_store.cpp',
].map(p => path.resolve(standardRoot, p)));
const erfa = await composeErfaTranslationUnit();
const erfaUnit = path.join(buildDir, 'erfa-amalgamation.cpp');
await fs.writeFile(erfaUnit, erfa.source);
units.push(erfaUnit);

const pluginSource = await fs.readFile(path.join(standardRoot, 'src/hpop_plugin.cpp'), 'utf8');
const diagnosticExports = [...new Set([...pluginSource.matchAll(/^(?:int|void|double|const char\*)\s+((?:plugin_|get_)[A-Za-z0-9_]+)\s*\(/gm)]
  .map(m => m[1]).filter(n => n !== 'plugin_stream_invoke')), 'malloc', 'free', 'hpop_initialize'];
const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.resolve('space-data-module-sdk/compiler'))), '../..');
const sdkVersion = JSON.parse(await fs.readFile(path.join(sdkRoot, 'package.json'), 'utf8')).version;
const defines = {
  HPOP_MODULE_ID: manifest.pluginId, HPOP_MODULE_VERSION: manifest.version,
  FFM_MODULE_ID: manifest.pluginId, FFM_MODULE_VERSION: manifest.version,
};
const config = {
  clangxx: path.join(emsdk, 'upstream/bin/clang++'), linker: path.join(emsdk, 'upstream/bin/wasm-ld'),
  units, exceptionLibraries, diagnosticExports, defines,
  includes: [path.join(packageRoot, 'lib'), ...[
    'lib', 'src', 'src/cpp/include', 'src/cpp/generated', 'src/cpp/generated/sds',
    '../../third_party/nrlmsise00', '../../third_party/hwm14', '../../foundation/frames/src', '../../higherpop/third_party/erfa',
  ].map(p => path.resolve(standardRoot, p))],
};
const configPath = path.join(buildDir, 'compiler.json');
await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n');
process.env.HPOP_SDK_BUILD_CONFIG = configPath;
process.env.SDN_WASI_CLANGXX = path.join(packageRoot, 'build-driver.mjs');
process.env.SDN_WASI_CLANG = process.env.SDN_WASI_CLANGXX;
process.env.SPACE_DATA_STANDARDS_ROOT = standardsRoot;
await fs.chmod(process.env.SDN_WASI_CLANGXX, 0o755);
const outputPath = path.join(packageRoot, 'dist/isomorphic/module.wasm');
await fs.mkdir(path.dirname(outputPath), { recursive: true });
let result;
try {
  result = await compileModuleFromSource({
    manifest, standardsRoot,
    sourceCode: `#include ${JSON.stringify(path.join(standardRoot, 'src/cpp/src/prw_sdk_adapter.cpp'))}\n`,
    language: 'c++', outputPath, threadModel: 'wasi-sequential', stackSize: 2 * 1024 * 1024,
  });
  if (!result.report?.ok) throw new Error(JSON.stringify(result.report?.issues));
  const bytes = await fs.readFile(outputPath);
  await fs.mkdir(path.join(packageRoot, 'dist/browser'), { recursive: true });
  await fs.writeFile(path.join(packageRoot, 'dist/browser/module.wasm'), bytes);
  await fs.copyFile(path.join(standardRoot, 'browser-factory.mjs'), path.join(packageRoot, 'dist/browser/module.js'));
  await fs.writeFile(path.join(packageRoot, 'dist/plugin-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const simd128 = (await fs.readFile(path.join(packageRoot, 'build-driver.mjs'), 'utf8')).includes("process.argv.push('-msimd128')");
  const provenance = {
    sdk: sdkVersion,
    spacedatastandards: JSON.parse(await fs.readFile(path.join(standardsRoot, 'package.json'), 'utf8')).version,
    threadModel: result.threadModel, target: 'wasm32-wasip1-threads', sharedMemory: true,
    sha256: sha256(bytes), bytes: bytes.length, compiler: result.compiler,
    flags: simd128 ? ['-msimd128'] : [],
    standardSources: STANDARD, standardWasmSha256,
    forkBase: { path: forkBase, sha256: forkBaseSha256 },
    clangVersion: execFileSync(config.clangxx, ['--version'], { encoding: 'utf8' }).trim(),
    exceptionRuntimeArchives: exceptionLibraries.map(p => ({ name: path.basename(p), sha256: sha256(fsSync.readFileSync(p)) })),
    units: [path.relative(packageRoot, path.join(standardRoot, 'src/cpp/src/prw_sdk_adapter.cpp')), ...units.map(p => path.relative(packageRoot, p))],
    erfa: { sourceFiles: erfa.fileCount, root: path.relative(packageRoot, path.resolve(standardRoot, '../../higherpop/third_party/erfa')) },
    standardWasmExceptions: true, legacyRuntimeCompiled: false, debugInfo: 'stripped',
    sdkAccommodation: 'Delegates to the unchanged standard module build driver. SDK owns PIV, allocation, command framing, direct-surface initialization, manifest embedding, and validation.',
  };
  await fs.writeFile(path.join(packageRoot, 'dist/build-provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
  console.log(`Built ${bytes.length} bytes; canonical SDK artifact validation passed.`);
} finally {
  if (result) await cleanupCompilation(result);
  const changed = execFileSync('find', [standardRoot, '-newer', marker, '-print'], { encoding: 'utf8' }).trim();
  if (changed) throw new Error(`The standard module was modified during the build:\n${changed}`);
  if (sha256(await fs.readFile(path.join(standardRoot, 'dist/isomorphic/module.wasm'))) !== standardWasmSha256)
    throw new Error('The standard module.wasm changed during the build.');
  console.log('Standard sources and module.wasm remained unchanged.');
}

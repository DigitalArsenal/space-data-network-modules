#!/usr/bin/env node
// The client-decrypt build approach: local Crypto++ archive + SDK-generated
// typed invoke glue and embedded PLG. No compiler or source downloads.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { encodePlgManifest, legacyManifestToPlg } from 'space-data-module-sdk/manifest';
import { assertArtifactThreadModel } from '../../scripts/lib/thread-model.mjs';
import { activateLaneToolchain, recordLaneToolchain, resolveVendoredSource, REPO_ROOT } from '../../scripts/lib/emsdk-toolchain.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const build = path.join(dir, '.build');
const typed = path.join(build, 'typed');
const dist = path.join(dir, 'dist');
const sds = path.resolve(dir, '../core/src/cpp/generated/sds');
const runtime = path.resolve(dir, '../core/src/cpp/generated/typed');
const manifestPath = path.join(dir, 'plugin-manifest.json');
const flags = ['-O2', '-std=c++17', '-fwasm-exceptions', '-sWASM_LEGACY_EXCEPTIONS=0',
  '-DCRYPTOPP_DISABLE_ASM=1', '-DCRYPTOPP_DISABLE_SSSE3=1', '-DCRYPTOPP_DISABLE_AESNI=1'];

function run(tool, args) { execFileSync(tool, args, { stdio: 'inherit' }); }
function localCrypto() {
  const source = process.env.CRYPTOPP_SOURCE_DIR;
  const candidates = source ? [source, path.join(source, 'cryptopp')] :
    [path.join(dir, 'deps/cryptopp'), path.join(REPO_ROOT, 'deps/cryptopp')];
  const found = source ? candidates.find(p => fs.existsSync(path.join(p, 'aes.h'))) :
    resolveVendoredSource('cryptopp', { candidates, sentinel: 'aes.h' }).root;
  if (!found) throw new Error('Local Crypto++ source missing; set CRYPTOPP_SOURCE_DIR. This build never fetches sources.');
  const version = fs.readFileSync(path.join(found, 'config_ver.h'), 'utf8');
  if (!/^#define CRYPTOPP_VERSION 890\s*$/m.test(version)) throw new Error('Crypto++ 8.9.0 is required.');
  // The include alias belongs to this build, never to the external source tree.
  const include = path.join(build, 'include'); fs.mkdirSync(include, { recursive: true });
  const alias = path.join(include, 'cryptopp');
  if (fs.existsSync(alias)) fs.unlinkSync(alias);
  fs.symlinkSync(fs.realpathSync(found), alias);
  return { source: fs.realpathSync(found), include };
}
async function stageRuntime(manifest) {
  const sdk = path.resolve(path.dirname(fileURLToPath(import.meta.resolve('space-data-module-sdk'))), '..');
  const { generateInvokeSupportHeader, generateInvokeSupportSource } = await import(pathToFileURL(path.join(sdk, 'src/compiler/invokeGlue.js')));
  const { getInvokeCppSchemaHeaders } = await import(pathToFileURL(path.join(sdk, 'src/compiler/flatcSupport.js')));
  fs.rmSync(typed, { recursive: true, force: true }); fs.mkdirSync(typed, { recursive: true });
  const write = (name, value) => {
    const target = path.join(typed, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, value);
  };
  write('space_data_module_invoke.h', generateInvokeSupportHeader());
  write('plugin_invoke_glue.cpp', generateInvokeSupportSource({ manifest, includeCommandMain: true }));
  for (const [name, value] of Object.entries(await getInvokeCppSchemaHeaders()))
    write(name, value.replace(/static_assert\(FLATBUFFERS_VERSION_MAJOR[\s\S]*?\);\n/, ''));
  const bytes = encodePlgManifest(legacyManifestToPlg(manifest));
  if (Buffer.from(bytes.subarray(4, 8)).toString() !== '$PLG') throw new Error('Expected embedded PLG');
  write('plugin_manifest_bytes.h', '#include <cstdint>\n' +
    `static const uint8_t publication_seal_plugin_manifest_bytes[] = {${Array.from(bytes).join(',')}};\n` +
    `static const uint32_t publication_seal_plugin_manifest_bytes_len = ${bytes.length};\n`);
}
async function main() {
  if (['system', 'path'].includes(process.env.SDN_WASM_TOOLCHAIN)) throw new Error('Use a repo-local deps/emsdk toolchain.');
  // Crypto++ source files compile serially; cap compiler/linker helper workers.
  process.env.EMCC_CORES = String(Math.min(8, Math.max(1, Number.parseInt(process.env.EMCC_CORES, 10) || 4)));
  fs.mkdirSync(build, { recursive: true });
  const lane = activateLaneToolchain({ moduleDir: 'licensing/publication-seal', emCache: path.join(dir, '.emcache') });
  const emxx = path.join(lane.root, 'upstream/emscripten/em++');
  const emar = path.join(lane.root, 'upstream/emscripten/emar');
  const crypto = localCrypto();
  const flatbuffers = process.env.FLATBUFFERS_INCLUDE_DIR ?? path.resolve(dir, '../../../flatbuffers/include');
  if (!fs.existsSync(path.join(flatbuffers, 'flatbuffers/base.h'))) throw new Error('Set FLATBUFFERS_INCLUDE_DIR to the local FlatBuffers include directory.');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  await stageRuntime(manifest);
  const archive = path.join(build, 'libcryptopp.a');
  const objects = path.join(build, 'cryptopp-obj');
  const stamp = path.join(build, 'crypto-build.json');
  const identity = JSON.stringify({ compiler: lane.identity, source: crypto.source, flags });
  if (!fs.existsSync(stamp) || fs.readFileSync(stamp, 'utf8') !== identity) {
    fs.rmSync(objects, { recursive: true, force: true }); fs.rmSync(archive, { force: true });
    fs.writeFileSync(stamp, identity);
  }
  if (!fs.existsSync(archive)) {
    fs.mkdirSync(objects, { recursive: true });
    const skip = /^(adhoc|bench[123]|cryptest|cryptestcwd|datatest|dlltest|fipsalgt|fipstest|regtest\d+|test|validat\d+)\.cpp$/;
    const units = fs.readdirSync(crypto.source).filter(f => f.endsWith('.cpp') && !skip.test(f)).sort();
    const outputs = units.map(unit => path.join(objects, unit.replace('.cpp', '.o')));
    for (let i = 0; i < units.length; i++) if (!fs.existsSync(outputs[i])) {
      console.log(`Crypto++ ${i + 1}/${units.length}: ${units[i]}`);
      run(emxx, [...flags, `-I${crypto.include}`, `-I${crypto.source}`, '-c', path.join(crypto.source, units[i]), '-o', outputs[i]]);
    }
    run(emar, ['rcs', archive, ...outputs]);
  }
  const output = path.join(dist, 'isomorphic/module.wasm');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  run(emxx, [...flags, ...[crypto.include, crypto.source, typed, runtime, sds, flatbuffers].map(p => `-I${p}`),
    path.join(dir, 'src/publication_seal.cpp'), path.join(typed, 'plugin_invoke_glue.cpp'), archive,
    '-sSTANDALONE_WASM=1', '-sPURE_WASI=1', '-sINITIAL_MEMORY=16777216', '-sALLOW_MEMORY_GROWTH=1', '-sFILESYSTEM=0',
    "-sEXPORTED_FUNCTIONS=['_plugin_alloc','_plugin_free','_plugin_invoke_stream','_plugin_get_manifest_flatbuffer','_plugin_get_manifest_flatbuffer_size','__initialize']",
    '-o', output]);
  assertArtifactThreadModel(output, 'single-thread', 'licensing/publication-seal');
  recordLaneToolchain(dist, lane);
  fs.copyFileSync(manifestPath, path.join(dist, 'plugin-manifest.json'));
  const bytes = fs.readFileSync(output);
  console.log(`Built ${bytes.length} bytes; sha256 ${createHash('sha256').update(bytes).digest('hex')}`);
}
main().catch(error => { console.error(`Build failed: ${error.message}`); process.exitCode = 1; });

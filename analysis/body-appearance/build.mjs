import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import os from 'node:os';
import {inspect} from 'node:util';
import {cppString,buildRecord} from './build-support.mjs';
import createFlatc from 'flatc-wasm/module';
import {compileModuleFromSource, cleanupCompilation} from 'space-data-module-sdk/compiler';
import {generateSdsHeaders} from '../../scripts/lib/sds-cpp-headers.mjs';
import {assertArtifactThreadModel} from '../../scripts/lib/thread-model.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const scratch = path.join(root, '.build');
await fs.mkdir(scratch, {recursive: true});
process.env.TMPDIR = scratch;
process.env.EMCC_CORES = '2';
if (os.loadavg()[0] >= 30) throw new Error('Load average >= 30; defer the build until load falls.');
const emsdk = path.join(root, 'deps/emsdk');
await fs.access(path.join(emsdk, 'emsdk_env.sh'));
// The pinned SDK's native compile path uses the WASI driver from repo-local
// Emscripten. single-thread currently selects emception unconditionally; do
// not force Emscripten -pthread (browser-only hooks) to select a native driver.
process.env.SDN_WASI_CLANG = path.join(emsdk, 'upstream/bin/clang');
process.env.SDN_WASI_CLANGXX = path.join(emsdk, 'upstream/bin/clang++');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'plugin-manifest.json'), 'utf8'));
const installedSdk=JSON.parse(await fs.readFile(path.join(root,'node_modules/space-data-module-sdk/package.json'),'utf8')).version;
const requiredSdk=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8')).devDependencies['space-data-module-sdk'];
if(installedSdk!==requiredSdk)throw new Error(`SDK ${installedSdk} does not match the pinned ${requiredSdk}`);
const table = JSON.parse(await fs.readFile(path.join(root, 'data/parameters.json'), 'utf8'));
const keys = new Set();
for (const entry of table) {
  if (!Number.isFinite(entry.value) || !/^10\./.test(entry.doi) || !entry.locator || !entry.unit || !entry.scope)
    throw new Error(`Uncited or invalid parameter ${entry.model}/${entry.parameter}`);
  const key = `${entry.model}/${entry.parameter}`;
  if (keys.has(key)) throw new Error(`Duplicate parameter ${key}`);
  keys.add(key);
}
const quote = cppString;
const rows = table.map(p => `{${quote(p.model)},${quote(p.parameter)},${p.value},${quote(p.unit)},${quote(p.doi)},${quote(p.locator)},${quote(p.scope)}}`);
const data = `namespace appearance { struct Parameter {const char *model,*name; double value; const char *unit,*doi,*locator,*scope;};\nconstexpr Parameter parameters_table[]={${rows.join(',\n')}};\n}`;
const {header, version} = await generateSdsHeaders(['PCE'], import.meta.url, createFlatc);
const names = ['wire.hpp', 'models.hpp', 'photometry.hpp', 'disk_photometry.hpp', 'band_photometry.hpp', 'placement.hpp', 'module.cpp'];
const sources = await Promise.all(names.map(async name => (await fs.readFile(path.join(root, 'src', name), 'utf8'))
  .replace(/^#pragma once\s*$/gm, '').replace(/^#include "[^"]+"\s*$/gm, '')));
const outputPath = path.join(root, 'dist/isomorphic/module.wasm');
await fs.mkdir(path.dirname(outputPath), {recursive: true});
const result = await compileModuleFromSource({manifest, language:'c++', outputPath,
  sourceCode: ['#include "space_data_module_invoke.h"', header, data, ...sources].join('\n'),
  threadModel:'wasi-sequential'});
try {
  if (!result.report?.ok) throw new Error(inspect(result.report?.issues));
  const threading = assertArtifactThreadModel(outputPath, 'wasi-sequential');
  await fs.copyFile(path.join(root, 'plugin-manifest.json'), path.join(root, 'dist/plugin-manifest.json'));
  await fs.writeFile(path.join(root, 'dist/build-provenance.md'), buildRecord({
    sdk:installedSdk, standards:version, sources:names, threadModel:'wasi-sequential',
    sharedMemory:threading.sharedMemory, threadSpawnImport:threading.threadSpawnImport,
    threadStartExport:threading.threadStartExport, trailingBytes:threading.trailingBytes,
    importModules:threading.importModules,
    compiler:'deps/emsdk/upstream/bin/clang++ --target=wasm32-wasip1-threads',
    emsdkRelease:(await fs.readFile(path.join(emsdk, 'upstream/.emsdk_version'),'utf8')).trim(),
    tableSha256:createHash('sha256').update(await fs.readFile(path.join(root,'data/parameters.json'))).digest('hex'),
    wasmSha256:createHash('sha256').update(await fs.readFile(outputPath)).digest('hex'),
  }));
  console.log('Built dist/isomorphic/module.wasm; SDK validation passed.');
} finally { await cleanupCompilation(result); }

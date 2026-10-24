import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileModuleFromSource } from 'space-data-module-sdk/compiler';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { computeCanonicalModuleHash, createSingleFileBundle } from 'space-data-module-sdk/bundle';
import { encodeAppManifest } from 'space-data-module-sdk/app';
import { encodePluginManifest } from 'space-data-module-sdk/manifest';
import { bundleXmt, generateSdsHeaders } from './sds-headers.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const repo = path.resolve(root, '../..');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'plugin-manifest.json'), 'utf8'));
// The SDS headers are generated from the standards' schema files, every family the module reads or writes at one
// release, with internal linkage (scripts/lib/sds-cpp-headers.mjs). $XMT (with the $OIL, $CVR, $MNV and $PRW it
// includes) carries the recipes, requests and reports; SPACE_DATA_STANDARDS_ROOT names the standards tree that holds it.
const sds = await generateSdsHeaders(['CAT', 'OEM', 'OPM', 'NCD', 'OMM', 'OCM', 'MNV', 'XMT'], import.meta.url);
// The $XMT JavaScript binding (from the standards' TypeScript) for the editor and the tests: dist/sds/xmt.mjs.
await bundleXmt(process.env.SPACE_DATA_STANDARDS_ROOT, path.join(root, 'dist/sds/xmt.mjs'));
const headers = [sds.header];
headers.push(await fs.readFile(path.join(repo,'files/orbit-products/src/sha256.hpp'),'utf8'));
headers.push(await fs.readFile(path.join(repo,'common/sds_cid.hpp'),'utf8'));
headers.push(await fs.readFile(path.join(repo,'files/orbit-products/src/vimpel.hpp'),'utf8'));
// estimation.hpp includes the recovery policy header: both go in, the policy first and its include dropped.
headers.push(await fs.readFile(path.join(repo,'analysis/estimation/src/recovery.hpp'),'utf8'));
headers.push((await fs.readFile(path.join(repo,'analysis/estimation/src/estimation.hpp'),'utf8')).replace('#include "recovery.hpp"\n',''));
headers.push((await fs.readFile(path.join(repo,'analysis/estimation/src/estimation.cpp'),'utf8')).replace('#include "estimation.hpp"',''));
const json = await fs.readFile(path.join(repo, 'propagator/sgp4/src/cpp/include/nlohmann/json.hpp'), 'utf8');
// The module's sources in dependency order, one translation unit: composition, matching, epoch fitting, then the integrator
// (records, maneuvers, selection, identity, and the method that calls them).
const implementation = (await Promise.all(['catalog_composer.cpp', 'catalog_match.cpp', 'epoch_fit.cpp', 'integrator_records.cpp', 'integrator_maneuvers.cpp',
  'integrator_selection.cpp', 'integrator_identity.cpp', 'catalog_integrator.cpp'].map((file) => fs.readFile(path.join(root, 'src', file), 'utf8')))).join('\n\n');
const outputPath = path.join(root, 'dist/isomorphic/module.wasm');
await fs.mkdir(path.dirname(outputPath), { recursive: true });
const result = await compileModuleFromSource({
  manifest, sourceCode: [...headers, json, implementation].join('\n\n'),
  language: 'c++', outputPath,
  // Composition is inherently sequential; still use the SDK's canonical
  // wasm32-wasip1-threads toolchain and identical bytes in every runtime.
  threadModel: 'wasi-sequential',
});
if (!result.report?.ok) throw new Error(JSON.stringify(result.report?.issues));
await fs.writeFile(path.join(root, 'dist/build-provenance.json'), `${JSON.stringify({ spacedatastandards: sds.version, sdsFamilies: sds.families }, null, 2)}\n`);
const canonical = await computeCanonicalModuleHash(await fs.readFile(outputPath));
// Dependencies are loaded by the generic APP bridge with exact artifact hashes.
const matchingModules = [];
for (const [role, relative] of [['normalizer','files/orbit-products'],['frames','foundation/frames'],['time','foundation/time'],['propagator','propagator/ffm']]) {
  const dependency = JSON.parse(await fs.readFile(path.join(repo,relative,'plugin-manifest.json'),'utf8'));
  const artifact = await computeCanonicalModuleHash(await fs.readFile(path.join(repo,relative,'dist/isomorphic/module.wasm')));
  matchingModules.push({role,pluginId:dependency.pluginId,name:dependency.name,manifest:dependency,hash:artifact.hashHex});
}
const searchWasm = await fs.readFile(path.join(root,'node_modules/flatsql/wasm/flatsql.wasm'));
const editor = await build({
  entryPoints: [path.join(root, 'app/editor.js')], bundle: true, write: false,
  platform: 'browser', format: 'esm', minify: true, target: 'es2022',
  alias: { 'catalog-search-wasm-factory':path.join(root,'node_modules/flatsql/wasm/flatsql.js') },
  external:['node:*','fs','path','url','module'],
  define: { __PLUGIN_MANIFEST__: JSON.stringify(manifest), __MATCHING_MODULES__:JSON.stringify(matchingModules), __SEARCH_WASM__:JSON.stringify(searchWasm.toString('base64')) },
});
const script = editor.outputFiles[0].text.replaceAll('__MODULE_HASH__', canonical.hashHex).replaceAll('</script', '<\\/script');
const page = (await fs.readFile(path.join(root, 'app/index.html'), 'utf8')).replace('__EDITOR_SCRIPT__', () => script);
const app = encodeAppManifest({
  id: 'catalog-editor', name: 'Catalog Editor', version: manifest.version,
  description: manifest.description,
  modules: [{ id: 'composer', pluginId: manifest.pluginId, contentHash: canonical.hashHex, version: manifest.version, role: 'primary', runtimeTarget: 'both' }, ...matchingModules.map(m=>({id:m.role,pluginId:m.pluginId,contentHash:m.hash,version:m.manifest.version,role:'dependency',runtimeTarget:'both'}))],
  data: ['CAT', 'MPE', 'OMM', 'OEM', 'OCM', 'MNV', 'NCD', 'PPE', 'OPM'].map(code => ({ id: code.toLowerCase(), sdsType: code, direction: code === 'CAT' ? 'both' : 'consumes', moduleId: 'composer' })),
  pages: [{ id: 'editor', title: 'Catalog Editor', mediaType: 'text/html', entry: true, encoding: 'base64_gzip', content: gzipSync(page, { level: 9 }).toString('base64'), contentSha256: createHash('sha256').update(page).digest('hex') }],
});
const bundle = await createSingleFileBundle({ wasmBytes: canonical.canonicalWasmBytes, manifestBytes: encodePluginManifest(manifest),
  entries: [{ entryId: 'app.app', role: 'auxiliary', sectionName: 'sdn.app.record', payloadEncoding: 'flatbuffer', typeRef: { schemaName: 'APP.fbs', fileIdentifier: '$APP' }, payload: app }],
});
await fs.writeFile(outputPath, bundle.wasmBytes);
console.log(`Catalog Editor compiled: ${outputPath}`);

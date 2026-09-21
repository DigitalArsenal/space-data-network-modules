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

const root = fileURLToPath(new URL('.', import.meta.url));
const repo = path.resolve(root, '../..');
process.env.SPACE_DATA_STANDARDS_ROOT ??= path.resolve(repo, '../spacedatastandards.org');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'plugin-manifest.json'), 'utf8'));
// Use the repository's pinned generated SDS headers, including CAT's actual
// dependency graph. The SDK supplies matching FlatBuffers runtime headers.
const headers = [];
const seen = new Set();
async function addHeader(code) {
  if (seen.has(code)) return;
  seen.add(code);
  const header = await fs.readFile(path.join(repo, 'licensing/core/src/cpp/generated/sds', `${code}_generated.h`), 'utf8');
  for (const match of header.matchAll(/^#include "([A-Za-z0-9_]+)_generated.h"/gm)) await addHeader(match[1]);
  headers.push(header.replace(/^#include "[A-Za-z0-9_]+_generated.h"\s*$/gm, ''));
}
await addHeader('CAT');
await addHeader('OEM');
const json = await fs.readFile(path.join(repo, 'propagator/sgp4/src/cpp/include/nlohmann/json.hpp'), 'utf8');
const implementation = await fs.readFile(path.join(root, 'src/catalog_composer.cpp'), 'utf8');
const outputPath = path.join(root, 'dist/isomorphic/module.wasm');
await fs.mkdir(path.dirname(outputPath), { recursive: true });
const result = await compileModuleFromSource({
  manifest, sourceCode: [...headers, json, implementation, await fs.readFile(path.join(root, 'src/catalog_match.cpp'), 'utf8')].join('\n\n'),
  language: 'c++', outputPath,
  // Composition is inherently sequential; still use the SDK's canonical
  // wasm32-wasip1-threads toolchain and identical bytes in every runtime.
  threadModel: 'wasi-sequential',
});
if (!result.report?.ok) throw new Error(JSON.stringify(result.report?.issues));
const canonical = await computeCanonicalModuleHash(await fs.readFile(outputPath));
const searchWasm = await fs.readFile(path.join(root,'node_modules/flatsql/wasm/flatsql.wasm'));
const editor = await build({
  entryPoints: [path.join(root, 'app/editor.js')], bundle: true, write: false,
  platform: 'browser', format: 'esm', minify: true, target: 'es2022',
  alias: { 'catalog-search-wasm-factory':path.join(root,'node_modules/flatsql/wasm/flatsql.js') },
  external:['node:*','fs','path','url','module'],
  define: { __PLUGIN_MANIFEST__: JSON.stringify(manifest), __SEARCH_WASM__:JSON.stringify(searchWasm.toString('base64')) },
});
const script = editor.outputFiles[0].text.replaceAll('__MODULE_HASH__', canonical.hashHex).replaceAll('</script', '<\\/script');
const page = (await fs.readFile(path.join(root, 'app/index.html'), 'utf8')).replace('__EDITOR_SCRIPT__', () => script);
const app = encodeAppManifest({
  id: 'catalog-editor', name: 'Catalog Editor', version: manifest.version,
  description: manifest.description,
  modules: [{ id: 'composer', pluginId: manifest.pluginId, contentHash: canonical.hashHex, version: manifest.version, role: 'primary', runtimeTarget: 'both' }],
  data: ['CAT', 'MPE', 'OMM', 'OEM', 'OCM', 'NCD', 'PPE'].map(code => ({ id: code.toLowerCase(), sdsType: code, direction: code === 'CAT' ? 'both' : 'consumes', moduleId: 'composer' })),
  pages: [{ id: 'editor', title: 'Catalog Editor', mediaType: 'text/html', entry: true, encoding: 'base64_gzip', content: gzipSync(page, { level: 9 }).toString('base64'), contentSha256: createHash('sha256').update(page).digest('hex') }],
});
const bundle = await createSingleFileBundle({ wasmBytes: canonical.canonicalWasmBytes, manifestBytes: encodePluginManifest(manifest),
  entries: [{ entryId: 'app.app', role: 'auxiliary', sectionName: 'sdn.app.record', payloadEncoding: 'flatbuffer', typeRef: { schemaName: 'APP.fbs', fileIdentifier: '$APP' }, payload: app }],
});
await fs.writeFile(outputPath, bundle.wasmBytes);
console.log(`Catalog Editor compiled: ${outputPath}`);

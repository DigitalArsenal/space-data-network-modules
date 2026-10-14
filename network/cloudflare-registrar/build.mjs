import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileModuleFromSource } from 'space-data-module-sdk/compiler';

const root = fileURLToPath(new URL('.', import.meta.url));
const repo = path.resolve(root, '../..');
const standardsRoot = process.env.SPACE_DATA_STANDARDS_ROOT
  ? path.resolve(process.env.SPACE_DATA_STANDARDS_ROOT)
  : fileURLToPath(new URL('../../../spacedatastandards.org/', import.meta.url));
process.env.SPACE_DATA_STANDARDS_ROOT = standardsRoot;
// The SDS records this node reads and writes: $NST (peers), $PNV (verifications), $APR (each request's CONTEXT). Each
// generated header is inlined with its include guard renamed and the flatc version static_assert dropped, as
// hostcap/clock does. The runtime types (HREQ, HRSP, FNTC, MCFG) are staged by the SDK compiler. nlohmann/json parses
// Cloudflare's external API body and renders the external API request body only.
async function sdsHeader(code) {
  const header = await fs.readFile(path.join(standardsRoot, 'lib', 'cpp', code, 'main_generated.h'), 'utf8');
  return header
    .replaceAll('FLATBUFFERS_GENERATED_MAIN_H_', `FLATBUFFERS_GENERATED_SDS_${code}_MAIN_H_`)
    .replace(/static_assert\(FLATBUFFERS_VERSION_MAJOR[\s\S]*?\);\n/, '')
    .replace(/#include "main_generated\.h"\n/g, '');
}
const manifest = JSON.parse(await fs.readFile(path.join(root, 'plugin-manifest.json'), 'utf8'));
const json = await fs.readFile(path.join(repo, 'propagator/sgp4/src/cpp/include/nlohmann/json.hpp'), 'utf8');
const sds = await Promise.all(['NST', 'PNV', 'APR'].map(sdsHeader));
const source = await fs.readFile(path.join(root, 'src/registrar.cpp'), 'utf8');
const outputPath = path.join(root, 'dist/isomorphic/module.wasm');
await fs.mkdir(path.dirname(outputPath), { recursive: true });
const result = await compileModuleFromSource({
  manifest,
  sourceCode: [json, ...sds, source].join('\n\n'),
  language: 'c++',
  outputPath,
  threadModel: 'wasi-sequential',
  // the sync space_data_module_host hostcall bridge for plugin.getConfig (typedHostcall.hpp); resolved at instantiation
  allowUndefinedImports: true,
});
if (!result.report?.ok) throw new Error(JSON.stringify(result.report?.issues));
console.log(`Built ${outputPath}`);

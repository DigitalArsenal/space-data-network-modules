import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileModuleFromSource } from 'space-data-module-sdk/compiler';

const root = fileURLToPath(new URL('.', import.meta.url));
const distRoot = path.join(root, 'dist');
// The SDS checkout that supplies the generated C++ headers: SPACE_DATA_STANDARDS_ROOT, else the sibling checkout.
const standardsRoot = process.env.SPACE_DATA_STANDARDS_ROOT ??= fileURLToPath(new URL('../../../spacedatastandards.org/', import.meta.url));
const manifest = JSON.parse(await fs.readFile(path.join(root, 'plugin-manifest.json'), 'utf8'));
// flatc gives every SDS header the same include guard and a self-named include; strip both to inline several.
const inline = source => source
  .replace(/#ifndef FLATBUFFERS_GENERATED_MAIN_H_\s*\n#define FLATBUFFERS_GENERATED_MAIN_H_\s*\n/, '')
  .replace(/#include "main_generated\.h"\s*\n/g, '')
  .replace(/#endif\s*\/\/ FLATBUFFERS_GENERATED_MAIN_H_\s*$/, '');
// IDM -> PLD and LCC feed CAT. The runtime types (HttpResponse, FlowNotice) are staged by the SDK compiler.
const headers = [];
for (const code of ['IDM', 'PLD', 'LCC', 'CAT'])
  headers.push(inline(await fs.readFile(path.join(standardsRoot, 'lib/cpp', code, 'main_generated.h'), 'utf8')));
const source = await fs.readFile(path.join(root, 'src/catalog_source.cpp'), 'utf8');
const outputPath = path.join(distRoot, 'isomorphic/module.wasm');
await fs.rm(distRoot, { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });
const result = await compileModuleFromSource({ manifest, sourceCode: [...headers, source].join('\n\n'),
  language: 'c++', outputPath, threadModel: 'wasi-sequential' });
if (!result.report?.ok) throw new Error(JSON.stringify(result.report?.issues));
// Retain the SDK link object so a host can compose this pure parser with its HTTP and storage capability nodes.
if (result.guestLink) {
  const dir = path.join(distRoot, 'guest-link');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'module-link.o'), result.guestLink.objectBytes);
  const { format, language, threadModel, symbolPrefix, methodSymbols } = result.guestLink;
  await fs.writeFile(path.join(dir, 'metadata.json'), JSON.stringify({ version:1, format, language, threadModel, symbolPrefix, methodSymbols }, null, 2)+'\n');
}
await fs.copyFile(path.join(root, 'plugin-manifest.json'), path.join(distRoot, 'plugin-manifest.json'));
console.log(`Catalog Source compiled: ${outputPath}`);

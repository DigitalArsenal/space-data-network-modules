import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileModuleFromSource } from 'space-data-module-sdk/compiler';

const root = fileURLToPath(new URL('.', import.meta.url));
const repo = path.resolve(root, '../..');
process.env.SPACE_DATA_STANDARDS_ROOT ??= path.resolve(repo, '../spacedatastandards.org');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'plugin-manifest.json'), 'utf8'));
const headers = [];
for (const code of ['IDM', 'PLD', 'LCC', 'CAT']) {
  const header = await fs.readFile(path.join(repo, 'licensing/core/src/cpp/generated/sds', `${code}_generated.h`), 'utf8');
  headers.push(header.replace(/^#include "(?:IDM|PLD|LCC)_generated.h"\s*$/gm, ''));
}
const json = await fs.readFile(path.join(repo, 'propagator/sgp4/src/cpp/include/nlohmann/json.hpp'), 'utf8');
const source = await fs.readFile(path.join(root, 'src/catalog_source.cpp'), 'utf8');
const outputPath = path.join(root, 'dist/isomorphic/module.wasm');
await fs.mkdir(path.dirname(outputPath), { recursive: true });
const result = await compileModuleFromSource({ manifest, sourceCode: [...headers, json, source].join('\n\n'),
  language: 'c++', outputPath, threadModel: 'wasi-sequential' });
if (!result.report?.ok) throw new Error(JSON.stringify(result.report?.issues));
// Retain the SDK link object so a host can compose this pure parser with its
// HTTP and storage capability nodes without adding provider code to the host.
if (result.guestLink) {
  const dir = path.join(root, 'dist/guest-link');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'module-link.o'), result.guestLink.objectBytes);
  const { format, language, threadModel, symbolPrefix, methodSymbols } = result.guestLink;
  await fs.writeFile(path.join(dir, 'metadata.json'), JSON.stringify({ version:1, format, language, threadModel, symbolPrefix, methodSymbols }, null, 2)+'\n');
}
console.log(`Catalog Source compiled: ${outputPath}`);

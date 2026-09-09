import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileModuleFromSource } from 'space-data-module-sdk/compiler';

const root = fileURLToPath(new URL('.', import.meta.url));
const repo = path.resolve(root, '../..');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'plugin-manifest.json'), 'utf8'));
const json = await fs.readFile(path.join(repo, 'propagator/sgp4/src/cpp/include/nlohmann/json.hpp'), 'utf8');
const source = await fs.readFile(path.join(root, 'src/registrar.cpp'), 'utf8');
const outputPath = path.join(root, 'dist/isomorphic/module.wasm');
await fs.mkdir(path.dirname(outputPath), { recursive: true });
const result = await compileModuleFromSource({ manifest, sourceCode: `${json}\n${source}`, language: 'c++', outputPath, threadModel: 'wasi-sequential' });
if (!result.report?.ok) throw new Error(JSON.stringify(result.report?.issues));
console.log(`Built ${outputPath}`);

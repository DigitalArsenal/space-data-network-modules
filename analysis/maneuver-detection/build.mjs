import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileModuleFromSource } from 'space-data-module-sdk/compiler';
import { generateSdsHeader } from './sds-header.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const oem = await generateSdsHeader('OEM', import.meta.url);
const mnv = await generateSdsHeader('MNV', import.meta.url);
if (!mnv.header.includes('struct MNV ')) throw new Error(`spacedatastandards.org@${mnv.version} has no MNV table.`);
// Two self-contained flatc headers share one include-guard name; they share no
// types (MNV includes nothing), so the second guard is renamed.
const mnvHeader = mnv.header.replaceAll('FLATBUFFERS_GENERATED_MAIN_H_', 'FLATBUFFERS_GENERATED_MNV_MAIN_H_');
const json = await fs.readFile(path.resolve(root, '../../propagator/sgp4/src/cpp/include/nlohmann/json.hpp'), 'utf8');
const source = await fs.readFile(path.join(root, 'src/maneuver_detection.cpp'), 'utf8');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'plugin-manifest.json'), 'utf8'));
const outputPath = path.join(root, 'dist/isomorphic/module.wasm');
await fs.mkdir(path.dirname(outputPath), { recursive: true });
const result = await compileModuleFromSource({ manifest, sourceCode: `${oem.header}\n${mnvHeader}\n${json}\n${source}`, language: 'c++', outputPath, threadModel: 'single-thread' });
if (!result.report?.ok) throw new Error(JSON.stringify(result.report?.issues));
await fs.copyFile(path.join(root, 'plugin-manifest.json'), path.join(root, 'dist/plugin-manifest.json'));
await fs.writeFile(path.join(root, 'dist/build-provenance.json'), `${JSON.stringify({ spacedatastandards: oem.version, schemas: ['OEM', 'MNV'], threadModel: 'single-thread' }, null, 2)}\n`);
console.log(`Built ${outputPath} against spacedatastandards.org@${oem.version}`);

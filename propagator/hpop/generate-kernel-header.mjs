// Generate the existing ratified $NCD descriptor from this package's SDS pin.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import createFlatc from 'flatc-wasm/module';
const root = path.dirname(fileURLToPath(import.meta.url));
const schema = await fs.readFile(path.join(root, 'node_modules/spacedatastandards.org/schema/NCD/main.fbs'), 'utf8');
const compiler = await createFlatc();
compiler.FS.mkdir('/schema');
compiler.FS.mkdir('/output');
compiler.FS.writeFile('/schema/main.fbs', schema);
const status = compiler.callMain(['--cpp', '--cpp-std', 'c++17', '--gen-object-api', '--preserve-case', '--no-warnings', '-o', '/output', '/schema/main.fbs']);
if (status) throw new Error(`flatc NCD generation failed: ${status}`);
const generated = compiler.FS.readFile('/output/main_generated.h', { encoding: 'utf8' }).replaceAll('FLATBUFFERS_GENERATED_MAIN_H_', 'FLATBUFFERS_GENERATED_NCD_MAIN_H_');
await fs.writeFile(path.join(root, 'src/cpp/generated/sds/NCD_generated.h'), generated);
console.log('Generated NCD kernel descriptor header from pinned SDS schema.');

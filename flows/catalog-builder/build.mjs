import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {compileModuleFromSource, ModuleThreadModel} from 'space-data-module-sdk/compiler';
import {generateSdsHeaders} from '../../scripts/lib/sds-cpp-headers.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const out = path.resolve(process.env.CATALOG_BUILD_DIR || path.join(root, 'dist'));
const apSource = path.resolve(root, '../../propagator/sdn-ap/.build/module.cpp');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'plugin-manifest.json'), 'utf8'));
const {header} = await generateSdsHeaders(['OEM', 'QRP'], import.meta.url);
const wire = 'namespace catalog_wire {\n' + header
  .replace(/static_assert\(FLATBUFFERS_VERSION_MAJOR[\s\S]*?\);\n/g, '')
  .replaceAll('FLATBUFFERS_GENERATED_', 'CATALOG_FLATBUFFERS_GENERATED_') + '\n}\n';
const sourceCode = await fs.readFile(path.join(root, 'src/chain_inputs.cpp'), 'utf8') +
  await fs.readFile(apSource, 'utf8') + '\n' + wire + await fs.readFile(path.join(root, 'src/chain.cpp'), 'utf8');
await fs.mkdir(path.join(out, 'isomorphic'), {recursive: true});
const built = await compileModuleFromSource({manifest, sourceCode, language: 'c++',
  outputPath: path.join(out, 'isomorphic/module.wasm'), threadModel: ModuleThreadModel.EMSCRIPTEN_PTHREADS});
if (!built.report?.ok) throw new Error(JSON.stringify(built.report));
await fs.mkdir(path.join(out, 'guest-link'), {recursive: true});
await fs.writeFile(path.join(out, 'guest-link/module-link.o'), built.guestLink.objectBytes);
const {objectBytes, ...metadata} = built.guestLink;
await fs.writeFile(path.join(out, 'guest-link/metadata.json'), JSON.stringify(metadata, null, 2) + '\n');
await fs.writeFile(path.join(out, 'plugin-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

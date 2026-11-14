import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {compileModuleFromSource, ModuleThreadModel} from 'space-data-module-sdk/compiler';
import {generateSdsHeaders} from '../../scripts/lib/sds-cpp-headers.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const out = path.resolve(process.env.CATALOG_BUILD_DIR || path.join(root, 'dist'));
const apSource = path.resolve(root, '../../propagator/sdn-ap/.build/module.cpp');
export const manifest = JSON.parse(await fs.readFile(path.join(root, 'plugin-manifest.json'), 'utf8'));
const {header} = await generateSdsHeaders(['OEM', 'QRP'], import.meta.url);
const wire = 'namespace catalog_wire {\n' + header
  .replace(/static_assert\(FLATBUFFERS_VERSION_MAJOR[\s\S]*?\);\n/g, '')
  .replaceAll('FLATBUFFERS_GENERATED_', 'CATALOG_FLATBUFFERS_GENERATED_') + '\n}\n';
const apSourceCode = await fs.readFile(apSource, 'utf8');
const sourceCode = await fs.readFile(path.join(root, 'src/chain_inputs.cpp'), 'utf8') +
  apSourceCode + '\n' + wire + await fs.readFile(path.join(root, 'src/chain.cpp'), 'utf8');
await fs.mkdir(path.join(out, 'isomorphic'), {recursive: true});
export const built = await compileModuleFromSource({manifest, sourceCode, language: 'c++',
  outputPath: path.join(out, 'isomorphic/module.wasm'), threadModel: ModuleThreadModel.EMSCRIPTEN_PTHREADS});
if (!built.report?.ok) throw new Error('Catalog chain refused by the SDK', {cause: built.report});

const require = createRequire(import.meta.url);
const packageVersion = async name => {
  for (let dir = path.dirname(require.resolve(name)); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    try {
      const metadata = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
      if (metadata.name === name) return metadata.version;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw new Error('Cannot locate installed package metadata: ' + name);
};
const propagator = JSON.parse(await fs.readFile(path.resolve(root, '../../propagator/sdn-ap/plugin-manifest.json'), 'utf8'));
const provenance = {
  spacedatastandards: await packageVersion('spacedatastandards.org'),
  spaceDataModuleSDK: await packageVersion('space-data-module-sdk'),
  propagatorVersion: propagator.version,
  propagatorSourceSHA256: createHash('sha256').update(apSourceCode).digest('hex'),
  threadModel: ModuleThreadModel.EMSCRIPTEN_PTHREADS,
  unsigned: process.env.SDM_MODULE_UNSIGNED_BUILD === '1',
};
for (const [key, value] of Object.entries(provenance)) console.log(`Catalog build ${key}=${value}`);

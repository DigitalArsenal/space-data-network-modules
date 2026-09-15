import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileModuleFromSource, cleanupCompilation } from 'space-data-module-sdk/compiler';
import { generateSdsHeaders } from './generate-sds-headers.mjs';

const packageRoot = fileURLToPath(new URL('.', import.meta.url));
const manifestPath = path.join(packageRoot, 'plugin-manifest.json');
const distRoot = path.join(packageRoot, 'dist');
const outputPath = path.join(distRoot, 'isomorphic', 'module.wasm');
const standardsRoot = process.env.SPACE_DATA_STANDARDS_ROOT ??
  fileURLToPath(new URL('.', import.meta.resolve('spacedatastandards.org')));
process.env.SPACE_DATA_STANDARDS_ROOT = standardsRoot;
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
const [headers, ...sources] = await Promise.all([
  generateSdsHeaders(standardsRoot),
  ...['include/lambert_izzo/solver.hpp', 'include/lambert_izzo/grid.hpp',
    'src/lambert_module.cpp', 'src/grid_module.cpp'].map(p=>fs.readFile(path.join(packageRoot,p),'utf8')),
]);
await fs.mkdir(path.dirname(outputPath), {recursive:true});
const compilation = await compileModuleFromSource({
  manifest, sourceCode:[headers,...sources].join('\n\n'), language:'c++', outputPath,
  // Bounded row streaming; caller concurrency can partition departure ranges.
  threadModel:'wasi-sequential',
});
try {
  if (!compilation.report?.ok)
    throw new Error(`Compiled artifact failed SDK validation: ${JSON.stringify(compilation.report?.issues)}`);
  await fs.copyFile(manifestPath, path.join(distRoot,'plugin-manifest.json'));
  console.log('Built dist/isomorphic/module.wasm — SDK validation PASS');
} finally {
  await cleanupCompilation(compilation);
}

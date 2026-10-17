import fs from 'node:fs/promises';
import { compileModuleFromSource, cleanupCompilation } from 'space-data-module-sdk/compiler';
import { generateHeaders } from './generate-headers.mjs';
const root = new URL('.', import.meta.url);
const standardsRoot = new URL('.', import.meta.resolve('spacedatastandards.org')).pathname;
process.env.SPACE_DATA_STANDARDS_ROOT = standardsRoot;
const manifest = JSON.parse(await fs.readFile(new URL('plugin-manifest.json',root)));
const sourceCode = [await generateHeaders(standardsRoot,['PCE']),
  await fs.readFile(new URL('src/budget.hpp',root),'utf8'),
  await fs.readFile(new URL('src/module.cpp',root),'utf8')].join('\n');
await fs.mkdir(new URL('dist/isomorphic/',root),{recursive:true});
const result = await compileModuleFromSource({manifest,sourceCode,language:'c++',
  threadModel:'wasi-sequential',outputPath:new URL('dist/isomorphic/module.wasm',root).pathname});
try {
  if (!result.report?.ok) throw Error(JSON.stringify(result.report));
  await fs.copyFile(new URL('plugin-manifest.json',root),new URL('dist/plugin-manifest.json',root));
  console.log('Mission screening WASM: SDK validation PASS');
} finally { await cleanupCompilation(result); }

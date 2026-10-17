import fs from 'node:fs/promises';
import {compileModuleFromSource,cleanupCompilation} from 'space-data-module-sdk/compiler';
import {generateHeaders} from '../../analysis/mission-screening/generate-headers.mjs';
import {verifyVendor} from './scripts/verify-vendor.mjs';
const root=new URL('.',import.meta.url);
const standardsRoot=new URL('.',import.meta.resolve('spacedatastandards.org')).pathname;
process.env.SPACE_DATA_STANDARDS_ROOT=standardsRoot;
await verifyVendor({quiet:true});
const manifest=JSON.parse(await fs.readFile(new URL('plugin-manifest.json',root)));
const {order}=JSON.parse(await fs.readFile(new URL('src/amalgamation.json',root)));
const parts=[await generateHeaders(standardsRoot,['SLP','PSS','OEM']),
 await fs.readFile(new URL('../../analysis/mission-screening/src/budget.hpp',root),'utf8')];
for(const file of order) {
 let source=await fs.readFile(new URL('src/'+file,root),'utf8');
 source=source.replace(/^\s*#\s*include\s+"([^"\n]+)"\s*$/gm,(line,name)=>
   name==='space_data_module_invoke.h'||name==='typedHostcall.hpp'?line:'/* amalgamated local include */');
 parts.push(source);
}
await fs.mkdir(new URL('dist/isomorphic/',root),{recursive:true});
const result=await compileModuleFromSource({manifest,sourceCode:parts.join('\n'),language:'c++',
 threadModel:'emscripten-pthreads',stackSize:4*1024*1024,outputPath:new URL('dist/isomorphic/module.wasm',root).pathname});
try {
 if(!result.report?.ok)throw Error(JSON.stringify(result.report));
 await fs.copyFile(new URL('plugin-manifest.json',root),new URL('dist/plugin-manifest.json',root));
 console.log('Star typed WASM: SDK validation PASS');
}finally{await cleanupCompilation(result);}

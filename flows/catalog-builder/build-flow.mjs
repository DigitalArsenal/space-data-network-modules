import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {compileModuleFromSource} from 'space-data-module-sdk/compiler';
import {compileFlowProgram,resolveFlowDependencies} from 'space-data-module-sdk/flow/compiler';
import {generateSdsHeaders,inlineSdsHeaders} from '../../scripts/lib/sds-cpp-headers.mjs';
const root=fileURLToPath(new URL('.',import.meta.url)),repo=path.resolve(root,'../..');
const out=path.resolve(process.env.CATALOG_FLOW_BUILD_DIR||path.join(root,'dist/flow'));
const require=createRequire(import.meta.url);
const standardsRoot=path.dirname(require.resolve('spacedatastandards.org/package.json'));
const read=(p)=>fs.readFile(path.join(repo,p),'utf8');
// Authoring manifests use the compiler's plain port and method representation.
const dependency=(manifest,result,dir)=>({pluginId:manifest.pluginId,dir,manifest,normalized:manifest,wasmPath:result.outputPath,guestLink:{objectBytes:result.guestLink.objectBytes,metadata:result.guestLink}});
async function compile(folder,source,codes=[],inline=[]){
 const manifest=JSON.parse(await read(folder+'/plugin-manifest.json'));
 const target=path.join(out,folder.split('/').at(-1));
 await fs.mkdir(path.join(target,'dist/isomorphic'),{recursive:true});
 if(!manifest.sequentialJustification)manifest.sequentialJustification={kind:'caller-level-parallelism',detail:'One bounded operation per invocation; the service serializes reconciliation.'};
 const {header}=codes.length?await generateSdsHeaders(codes,import.meta.url):{header:''};
 const sourceCode=header.replace(/static_assert\(FLATBUFFERS_VERSION_MAJOR[\s\S]*?\);\n/g,'')+'\n'+await inlineSdsHeaders(source,inline,import.meta.url);
 const result=await compileModuleFromSource({manifest,sourceCode,language:'c++',outputPath:path.join(target,'dist/isomorphic/module.wasm'),threadModel:'wasi-sequential',allowUndefinedImports:true});
 if(!result.report?.ok)throw new Error('Flow dependency refused by the SDK',{cause:result.report});
 return dependency(manifest,result,path.join(repo,folder));
}
const source=await read('common/catalog_epoch.hpp')+'\n'+await read('files/orbit-products/src/sha256.hpp')+'\n'+await read('common/sds_cid.hpp')+'\n'+await read('flows/catalog-builder/control/control.cpp');
const control=await compile('flows/catalog-builder/control',source,['OMM','OCM','SPW','PCF','CAT','XMT','QRP','NEV']);
if(process.argv.includes('--control-only'))process.exit(0);
const dependencies=new Map([[control.manifest.pluginId,control]]);
const chain=await import('./build.mjs');
const {compileCatalogComposer}=await import('../../analysis/catalog-composer/build.mjs');
const composer=await compileCatalogComposer({outputPath:path.join(out,'catalog-composer/dist/isomorphic/module.wasm')});
for(const [manifest,result,folder] of [[chain.manifest,chain.built,'flows/catalog-builder'],[composer.manifest,composer,'analysis/catalog-composer']])dependencies.set(manifest.pluginId,dependency(manifest,result,path.join(repo,folder)));
for(const [id,entry]of await resolveFlowDependencies({depsPath:path.join(repo,'analysis/gp-error-model')}))if(!dependencies.has(id))dependencies.set(id,entry);
for(const [folder,file,inline] of [['hostcap/flatsql-query','flatsql_query_module.cpp',['FSO','FSB','QRP']],['hostcap/storage-ingest','storage_ingest_module.cpp',[]]]){
 const entry=await compile(folder,await read(folder+'/src/'+file),[],inline);dependencies.set(entry.manifest.pluginId,entry);
}
const flow=JSON.parse(await read('flows/catalog-builder.flow.json'));
await compileFlowProgram({flow,dependencies,outDir:path.join(out,'runtime'),standardsRoot});

const partitions=Number(process.env.CATALOG_FLOW_PARTITIONS||1);
if(!Number.isInteger(partitions)||partitions<1||partitions>8)throw Error('CATALOG_FLOW_PARTITIONS must be an integer from 1 through 8');
if(partitions>1)for(let index=0;index<partitions;index++){
 const partitionFlow={...flow,programId:flow.programId+'.partition-'+index,name:flow.name+' partition '+index};
 await compileFlowProgram({flow:partitionFlow,dependencies,outDir:path.join(out,'partitions',String(index)),standardsRoot});
}

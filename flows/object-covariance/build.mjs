// The object covariance reactor flow (sdn-object-covariance-reactor-20261022): the controller built here, gp-error-model's
// object_covariance, and the generic storage query and ingest hooks, linked by the SDK into one flow artifact. Every
// guest is wasi-sequential (one family: the SDK cannot link single-thread and wasi guests into one artifact), so the hooks
// are compiled again here, as flows/open-dca does.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {compileModuleFromSource,resolveWasiThreadsToolchain} from 'space-data-module-sdk/compiler';
import {compileFlowProgram,resolveFlowDependencies} from 'space-data-module-sdk/flow/compiler';
import {generateSdsHeaders,inlineSdsHeaders} from '../../scripts/lib/sds-cpp-headers.mjs';
const root=fileURLToPath(new URL('.',import.meta.url)),modules=path.resolve(root,'../..'),out=path.join(root,'dist');
const require=createRequire(import.meta.url);
process.env.SPACE_DATA_STANDARDS_ROOT=path.dirname(require.resolve('spacedatastandards.org/package.json'));
const sdsVersion=JSON.parse(await fs.readFile(path.join(process.env.SPACE_DATA_STANDARDS_ROOT,'package.json'),'utf8')).version;
// One module of the flow: compiled from `source`, then its flow dependency entry (the package directory's manifest and flow
// metadata, with this build's artifact and guest-link object). A source names its standards through the object-API
// header of `codes` ahead of it (scoped enumerators), or `inline` standards' own headers in place of their includes.
async function compile({folder,manifest,source,codes=[],inline=[],target,justification}) {
 const original=path.join(modules,folder);
 manifest=JSON.parse(JSON.stringify(manifest));
 if(justification)manifest.sequentialJustification=justification;
 await fs.mkdir(path.join(target,'dist/isomorphic'),{recursive:true});
 const {header}=codes.length?await generateSdsHeaders(codes,import.meta.url):{header:''};
 const sourceCode=header.replace(/static_assert\(FLATBUFFERS_VERSION_MAJOR[\s\S]*?\);\n/g,'')+'\n'+await inlineSdsHeaders(source,inline,import.meta.url);
 const result=await compileModuleFromSource({manifest,sourceCode,language:'c++',
  outputPath:path.join(target,'dist/isomorphic/module.wasm'),threadModel:'wasi-sequential',allowUndefinedImports:true});
 if(!result.report?.ok)throw new Error(`${manifest.pluginId} refused by the SDK`,{cause:result.report?.issues});
 const entries=await resolveFlowDependencies({depsPath:original});
 return {...entries.get(manifest.pluginId),manifest,wasmPath:result.outputPath,guestLink:{objectBytes:result.guestLink.objectBytes,metadata:result.guestLink}};
}
const read=(...p)=>fs.readFile(path.join(modules,...p),'utf8');
const manifestOf=async folder=>JSON.parse(await read(folder,'plugin-manifest.json'));
const hook={kind:'caller-level-parallelism',detail:'One bounded host call per input frame; the cron owns concurrency.'};
await fs.rm(out,{recursive:true,force:true});
const control=await compile({folder:'flows/object-covariance',manifest:await manifestOf('flows/object-covariance'),source:await read('flows/object-covariance/src/control.cpp'),
 codes:['FSO','FSB','OMM','OCM','ERM'],target:path.join(out,'transport/control')});
if(process.argv.includes('--control-only'))process.exit(0);
const gp=JSON.parse(await read('analysis/gp-error-model/plugin-manifest.json'));
if(!gp.methods.find(m=>m.methodId==='object_covariance')?.outputPorts.some(p=>p.portId==='ocm'))
 throw new Error('analysis/gp-error-model object_covariance has no ocm output port');
const dependencies=new Map();
dependencies.set(control.manifest.pluginId,control);
for(const [id,entry] of await resolveFlowDependencies({depsPath:path.join(modules,'analysis/gp-error-model')}))dependencies.set(id,entry);
const query=await compile({folder:'hostcap/flatsql-query',manifest:await manifestOf('hostcap/flatsql-query'),source:await read('hostcap/flatsql-query/src/flatsql_query_module.cpp'),
 inline:['FSO','FSB','QRP'],target:path.join(out,'transport/flatsql-query'),justification:hook});
const ingest=await compile({folder:'hostcap/storage-ingest',manifest:await manifestOf('hostcap/storage-ingest'),source:await read('hostcap/storage-ingest/src/storage_ingest_module.cpp'),
 target:path.join(out,'transport/storage-ingest'),justification:hook});
dependencies.set(query.manifest.pluginId,query);
dependencies.set(ingest.manifest.pluginId,ingest);
const flow=JSON.parse(await fs.readFile(path.join(modules,'flows/object-covariance.flow.json'),'utf8'));
resolveWasiThreadsToolchain({force:true});
await compileFlowProgram({flow,dependencies,outDir:path.join(out,'runtime'),standardsRoot:process.env.SPACE_DATA_STANDARDS_ROOT});
await fs.copyFile(path.join(out,'runtime/flow.json'),path.join(out,'flow.json'));
console.log(`Built ${path.join(out,'runtime')} against spacedatastandards.org@${sdsVersion}`);

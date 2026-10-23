// The Earth-orientation publication flow (modules-eop-publication-flow-20261023): eop-request, the generic HTTP hook,
// eop-parser, this flow's lane glue and the generic storage ingest hook, linked by the SDK into one flow artifact.
// Every guest is wasi-sequential (one family: the SDK cannot link single-thread and wasi guests into one artifact), so
// eop-request, eop-parser and the hooks are compiled again here from their own sources, exactly as flows/open-dca does.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {compileModuleFromSource,resolveWasiThreadsToolchain} from 'space-data-module-sdk/compiler';
import {compileFlowProgram,resolveFlowDependencies} from 'space-data-module-sdk/flow/compiler';
import {generateSdsHeaders} from '../../scripts/lib/sds-cpp-headers.mjs';
const root=fileURLToPath(new URL('.',import.meta.url)),modules=path.resolve(root,'../..'),out=path.join(root,'dist');
const require=createRequire(import.meta.url);
process.env.SPACE_DATA_STANDARDS_ROOT=path.dirname(require.resolve('spacedatastandards.org/package.json'));
const sdsVersion=JSON.parse(await fs.readFile(path.join(process.env.SPACE_DATA_STANDARDS_ROOT,'package.json'),'utf8')).version;
const read=(...p)=>fs.readFile(path.join(modules,...p),'utf8');
// One module of the flow: compiled from `source`, then its flow dependency entry (the package directory's manifest and flow
// metadata, with this build's artifact and guest-link object). A module that calls the host leaves its imports undefined.
async function compile({folder,source,justification,hostcalls=false}) {
 const manifest=JSON.parse(await read(folder,'plugin-manifest.json')),target=path.join(out,'transport',path.basename(folder));
 manifest.sequentialJustification=justification;
 await fs.mkdir(path.join(target,'dist/isomorphic'),{recursive:true});
 const result=await compileModuleFromSource({manifest,sourceCode:source,language:'c++',outputPath:path.join(target,'dist/isomorphic/module.wasm'),
  threadModel:'wasi-sequential',...(hostcalls?{allowUndefinedImports:true}:{})});
 if(!result.report?.ok)throw new Error(`${manifest.pluginId} refused by the SDK`,{cause:result.report?.issues});
 const entries=await resolveFlowDependencies({depsPath:path.join(modules,folder)});
 return {...entries.get(manifest.pluginId),manifest,wasmPath:result.outputPath,guestLink:{objectBytes:result.guestLink.objectBytes,metadata:result.guestLink}};
}
// eop-request and eop-parser share the job's wire header; the parser also hashes the file. The SDS standards they name come
// from the object-API headers of the pinned package, with their enumerators scoped.
const {header}=await generateSdsHeaders(['ICN','FIL','EOP'],import.meta.url);
const standards=header.replace(/static_assert\(FLATBUFFERS_VERSION_MAJOR[\s\S]*?\);\n/g,'')+'\n';
const eop=async kind=>compile({folder:`data-source/eop-${kind}`,justification:{kind:'pure-transform',detail:'Existing bounded IERS parser; no host calls or concurrency.'},
 source:standards+(await Promise.all(['data-source/eop-request/src/eop_wire.hpp','files/orbit-products/src/sha256.hpp',`data-source/eop-${kind}/src/module.cpp`].map(p=>read(p))))
  .join('\n').replace(/^#include "(?:ICN|FIL|EOP)_generated\.h".*$/gm,'').replace(/\b(DataType|eopSeries|iauPrecessionNutationModel|icnConnectorKind|icnPostIngestAction)_([A-Za-z0-9_]+)/g,'$1::$2')});
await fs.rm(out,{recursive:true,force:true});
const request=await eop('request'),parser=await eop('parser');
const lane=await compile({folder:'flows/eop',hostcalls:true,source:(await read('files/orbit-products/src/sha256.hpp'))+'\n'+await read('flows/eop/src/lane.cpp'),
 justification:{kind:'pure-transform',detail:'Bounded rewrite of one typed frame per invocation; the host owns I/O and the cron owns concurrency.'}});
const hook={kind:'caller-level-parallelism',detail:'Serial generic host I/O; host owns concurrency.'};
const http=await compile({folder:'hostcap/http-request',hostcalls:true,justification:hook,source:await read('hostcap/http-request/src/http_request_module.cpp')});
const storage=await compile({folder:'hostcap/storage-ingest',hostcalls:true,justification:hook,source:await read('hostcap/storage-ingest/src/storage_ingest_module.cpp')});
const dependencies=new Map();
for(const entry of [request,parser,lane,http,storage])dependencies.set(entry.manifest.pluginId,entry);
const flow=JSON.parse(await read('flows/eop.flow.json'));
resolveWasiThreadsToolchain({force:true});
await compileFlowProgram({flow,dependencies,outDir:path.join(out,'runtime'),standardsRoot:process.env.SPACE_DATA_STANDARDS_ROOT});
await fs.copyFile(path.join(out,'runtime/flow.json'),path.join(out,'flow.json'));
console.log(`Built ${path.join(out,'runtime')} against spacedatastandards.org@${sdsVersion}`);

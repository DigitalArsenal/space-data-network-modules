import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
const modules=fileURLToPath(new URL('../../',import.meta.url));
const out=path.resolve(process.argv[2] || path.join(modules,'flows/space-weather/dist'));
const packageDir=path.join(modules,'data-source/space-weather');
const require=createRequire(path.join(packageDir,'package.json'));
process.env.SPACE_DATA_STANDARDS_ROOT=path.dirname(require.resolve('spacedatastandards.org/package.json'));
const sdkRoot=path.dirname(path.dirname(require.resolve('space-data-module-sdk')));
const {compileModuleFromSource}=await import(pathToFileURL(require.resolve('space-data-module-sdk/compiler')));
const source='com.digitalarsenal.data-source.space-weather',http='com.digitalarsenal.hostcap.http-request',storage='com.digitalarsenal.hostcap.storage-ingest';
const node=(nodeId,pluginId,methodId,kind='transform')=>({nodeId,pluginId,methodId,kind,drainPolicy:'single-shot'});
const edge=(fromNodeId,fromPortId,toNodeId,toPortId)=>({edgeId:[fromNodeId,fromPortId,toNodeId,toPortId].join('-'),fromNodeId,fromPortId,toNodeId,toPortId,backpressurePolicy:'queue',queueDepth:1});
const flow={programId:'com.digitalarsenal.flows.space-weather',name:'Licensed space weather',version:'0.1.0',engineLinkage:'bridge',
 description:'Hourly GFZ/NOAA licensed space weather for NRLMSISE-00, parsed in WASM and published as attributed SPW. No SET/CSSI or sunspot numbers.',
 nodes:[node('plan',source,'plan_weather'),node('fetch',http,'request'),node('parse',source,'parse_weather'),node('ingest',storage,'ingest'),node('egress','sdn.flow.egress','emit','sink')],
 edges:[edge('plan','request','fetch','request'),edge('fetch','response','parse','response'),edge('parse','records','ingest','spw_records'),edge('parse','meta','ingest','meta'),edge('parse','report','egress','result'),edge('ingest','result','egress','result')],
 triggers:[{triggerId:'hourly',kind:'timer',source:'host-cron',defaultIntervalMs:3600000,description:'Refresh observed and forecast drivers hourly.'}],
 triggerBindings:[{triggerId:'hourly',targetNodeId:'plan',targetPortId:'tick',backpressurePolicy:'queue',queueDepth:1}],requiredPlugins:[source,http,storage]};
await fs.mkdir(out,{recursive:true});
// Build existing generic host hooks in this flow's own output tree, with the same SDK/toolchain.
async function transport(folder,sourceFile) {
 const original=path.join(modules,'hostcap',folder),target=path.join(out,'transport',folder);
 const manifest=JSON.parse(await fs.readFile(path.join(original,'plugin-manifest.json'),'utf8'));
 manifest.sequentialJustification={kind:'caller-level-parallelism',detail:'Serial host I/O per input frame; host owns concurrency.'};
 await fs.mkdir(path.join(target,'dist/guest-link'),{recursive:true});
 await fs.mkdir(path.join(target,'dist/isomorphic'),{recursive:true});
 await fs.writeFile(path.join(target,'plugin-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
 const result=await compileModuleFromSource({manifest,sourceCode:await fs.readFile(path.join(original,'src',sourceFile),'utf8'),language:'c++',outputPath:path.join(target,'dist/isomorphic/module.wasm'),threadModel:'wasi-sequential',allowUndefinedImports:true});
 if(!result.report?.ok)throw new Error(JSON.stringify(result.report?.issues));
 const {format,language,threadModel,symbolPrefix,methodSymbols,objectBytes}=result.guestLink;
 await fs.writeFile(path.join(target,'dist/guest-link/module-link.o'),objectBytes);
 await fs.writeFile(path.join(target,'dist/guest-link/metadata.json'),JSON.stringify({version:1,format,language,threadModel,symbolPrefix,methodSymbols},null,2)+'\n');
 return target;
}
const deps={[source]:packageDir,[http]:await transport('http-request','http_request_module.cpp'),[storage]:await transport('storage-ingest','storage_ingest_module.cpp')};
const file=path.join(out,'flow.json'),depfile=path.join(out,'dependencies.json');
await fs.writeFile(file,JSON.stringify(flow,null,2)+'\n');await fs.writeFile(depfile,JSON.stringify(deps,null,2)+'\n');
for(const command of ['check','compile']) {
 const result=spawnSync(process.execPath,[path.join(sdkRoot,'bin/space-data-module.js'),'flow',command,file,'--deps',depfile,'--out',path.join(out,'runtime')],{stdio:'inherit',env:process.env});
 if(result.status!==0)throw new Error(`Flow ${command} failed (${result.status})`);
}

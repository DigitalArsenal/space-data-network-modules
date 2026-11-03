import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const modules=fileURLToPath(new URL('../../',import.meta.url));
if(!process.argv.includes('--unsigned'))throw new Error('Explicit --unsigned required');
const replay=process.argv.includes('--fixtures');
const out=path.join(modules,replay?'data-source/swpc-realtime/tests/fixture-flow':'flows/swpc-realtime/dist');
const packageDir=path.join(modules,'data-source/swpc-realtime');
const require=createRequire(path.join(packageDir,'package.json'));
process.env.SPACE_DATA_STANDARDS_ROOT=path.dirname(require.resolve('spacedatastandards.org/package.json'));
const {compileModuleFromSource}=await import(pathToFileURL(require.resolve('space-data-module-sdk/compiler')));
const {compileFlowProgram,resolveFlowDependencies}=await import(pathToFileURL(require.resolve('space-data-module-sdk/flow/compiler')));
const {compilation}=await import('../../data-source/swpc-realtime/build.mjs');
const source='com.digitalarsenal.data-source.swpc-realtime',http='com.digitalarsenal.hostcap.http-request',storage='com.digitalarsenal.hostcap.storage-ingest';
const node=(nodeId,pluginId,methodId,kind='transform')=>({nodeId,pluginId,methodId,kind,drainPolicy:'single-shot'});
const edge=(fromNodeId,fromPortId,toNodeId,toPortId)=>({edgeId:[fromNodeId,fromPortId,toNodeId,toPortId].join('-'),fromNodeId,fromPortId,toNodeId,toPortId,backpressurePolicy:'queue',queueDepth:1});
const flow={programId:'com.digitalarsenal.flows.swpc-realtime',name:'NOAA SWPC real-time',version:'0.1.0',engineLinkage:'bridge',
 description:'NOAA public-domain SWS and SWA; flares disabled pending SDS 1.274.0.',nodes:[],edges:[],
 triggers:[{triggerId:'minute',kind:'timer',source:'host-cron',defaultIntervalMs:60000}],triggerBindings:[],requiredPlugins:[source,http,storage]};
for(const code of ['sws','swa']) {
 flow.nodes.push(node('plan-'+code,source,'plan_'+code),node('fetch-'+code,http,'request'),node('parse-'+code,source,'parse_'+code),node('ingest-'+code,storage,'ingest'),node('egress-'+code,'sdn.flow.egress','emit','sink'));
 flow.edges.push(edge('plan-'+code,'request','fetch-'+code,'request'),edge('fetch-'+code,'response','parse-'+code,'response'),edge('parse-'+code,'records','ingest-'+code,code+'_records'),edge('parse-'+code,'meta','ingest-'+code,'meta'),edge('ingest-'+code,'result','egress-'+code,'result'));
 flow.triggerBindings.push({triggerId:'minute',targetNodeId:'plan-'+code,targetPortId:'tick',backpressurePolicy:'queue',queueDepth:1});
}
await fs.mkdir(out,{recursive:true});
// Build existing generic host hooks in this flow's own output tree, with the same SDK/toolchain.
async function transport(folder,sourceFile) {
 const original=path.join(modules,'hostcap',folder),target=path.join(out,'transport',folder);
 const manifest=JSON.parse(await fs.readFile(path.join(original,'plugin-manifest.json'),'utf8'));
 if(folder==='storage-ingest')for(const code of ['SWS','SWA']) {
  const port=structuredClone(manifest.methods[0].inputPorts.find(p=>p.portId==='spw_records'));
  port.portId=code.toLowerCase()+'_records';port.description='Size-prefixed '+code+' record stream';
  port.acceptedTypeSets[0].setId='sdn-record-stream-'+code.toLowerCase();
  port.acceptedTypeSets[0].allowedTypes=[{schemaName:code+'.fbs',fileIdentifier:'$'+code,rootTypeName:code,wireFormat:'flatbuffer'}];
  manifest.methods[0].inputPorts.push(port);
 }

 manifest.sequentialJustification={kind:'caller-level-parallelism',detail:'Serial host I/O per input frame; host owns concurrency.'};
 await fs.mkdir(path.join(target,'dist/isomorphic'),{recursive:true});
 let sourceCode=await fs.readFile(path.join(original,'src',sourceFile),'utf8');
 if(replay&&folder==='http-request'){
  const {fixtureHttpSource}=await import('./fixture-http.mjs');
  const {encodeHttpResponse}=await import(pathToFileURL(require.resolve('space-data-module-sdk/runtime-contracts')));
  sourceCode=await fixtureHttpSource(packageDir,encodeHttpResponse);manifest.capabilities=[];manifest.externalInterfaces=[];
 }
 const result=await compileModuleFromSource({manifest,sourceCode,language:'c++',outputPath:path.join(target,'dist/isomorphic/module.wasm'),threadModel:'wasi-sequential',allowUndefinedImports:true});
 if(!result.report?.ok)throw new Error(`Host hook ${folder} validation failed`,{cause:result.report?.issues});
 await fs.writeFile(path.join(target,'plugin-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
 const entries=await resolveFlowDependencies({depsPath:target});
 const entry=entries.get(manifest.pluginId);
 return {...entry,manifest,wasmPath:result.outputPath,guestLink:{objectBytes:result.guestLink.objectBytes,metadata:result.guestLink}};
}
const dependencies=await resolveFlowDependencies({depsPath:packageDir});
dependencies.get(source).guestLink={objectBytes:compilation.guestLink.objectBytes,metadata:compilation.guestLink};
dependencies.set(http,await transport('http-request','http_request_module.cpp'));
dependencies.set(storage,await transport('storage-ingest','storage_ingest_module.cpp'));
// The SDK owns validation, linkage and all on-disk FlowStore metadata.
await compileFlowProgram({flow,dependencies,outDir:path.join(out,'runtime'),standardsRoot:process.env.SPACE_DATA_STANDARDS_ROOT});
await fs.copyFile(path.join(out,'runtime/flow.json'),path.join(out,'flow.json'));

import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {generateSdsHeaders} from '../../scripts/lib/sds-cpp-headers.mjs';
const modules=fileURLToPath(new URL('../../',import.meta.url)),packageDir=path.join(modules,'data-source/operator-states-public');
const require=createRequire(path.join(packageDir,'package.json'));
const {compileModuleFromSource,resolveWasiThreadsToolchain}=await import(pathToFileURL(require.resolve('space-data-module-sdk/compiler')));
const {compileFlowProgram,resolveFlowDependencies}=await import(pathToFileURL(require.resolve('space-data-module-sdk/flow/compiler')));
const out=path.join(modules,'flows/open-dca/dist');
// The flow's standards are its own pin (package.json); every module build resolves its own. So the override is set
// only around this flow's own compiles (the EOP and host-hook units) and the link, never while a module's build runs,
// and a module's dist stays what its own build makes of it.
const standardsRoot=path.dirname(createRequire(path.join(modules,'flows/open-dca/package.json')).resolve('spacedatastandards.org/package.json'));
delete process.env.SPACE_DATA_STANDARDS_ROOT;
async function withFlowStandards(step){
 process.env.SPACE_DATA_STANDARDS_ROOT=standardsRoot;
 try{return await step();}finally{delete process.env.SPACE_DATA_STANDARDS_ROOT;}
}
export async function buildHook(folder,sourceFile){
 const original=path.join(modules,'hostcap',folder),target=path.join(out,'transport',folder);
 const manifest=JSON.parse(await fs.readFile(path.join(original,'plugin-manifest.json'),'utf8'));
 manifest.sequentialJustification={kind:'caller-level-parallelism',detail:'Serial generic host I/O; host owns concurrency.'};
 await fs.mkdir(path.join(target,'dist/isomorphic'),{recursive:true});
 const result=await compileModuleFromSource({manifest,sourceCode:await fs.readFile(path.join(original,'src',sourceFile),'utf8'),language:'c++',outputPath:path.join(target,'dist/isomorphic/module.wasm'),threadModel:'wasi-sequential',allowUndefinedImports:true});
 if(!result.report?.ok)throw new Error(`Host hook ${folder} refused`,{cause:result.report?.issues});
 const entries=await resolveFlowDependencies({depsPath:original});return {...entries.get(manifest.pluginId),manifest,wasmPath:result.outputPath,guestLink:{objectBytes:result.guestLink.objectBytes,metadata:result.guestLink}};
}
export async function buildEop(kind="parser"){
 const original=path.join(modules,`data-source/eop-${kind}`),target=path.join(out,`transport/eop-${kind}`);
 const manifest=JSON.parse(await fs.readFile(path.join(original,'plugin-manifest.json'),'utf8'));
 manifest.sequentialJustification={kind:'pure-transform',detail:'Existing bounded IERS parser; no host calls or concurrency.'};
 const {header}=await generateSdsHeaders(['ICN','FIL','EOP'],pathToFileURL(path.join(packageDir,'build.mjs')));
 const pieces=await Promise.all(['data-source/eop-request/src/eop_wire.hpp','files/orbit-products/src/sha256.hpp',`data-source/eop-${kind}/src/module.cpp`].map(p=>fs.readFile(path.join(modules,p),'utf8')));
 const source=pieces.join('\n').replace(/^#include "(?:ICN|FIL|EOP)_generated\.h".*$/gm,'').replace(/\b(DataType|eopSeries|iauPrecessionNutationModel|icnConnectorKind|icnPostIngestAction)_([A-Za-z0-9_]+)/g,'$1::$2');
 await fs.mkdir(path.join(target,'dist/isomorphic'),{recursive:true});
 const result=await compileModuleFromSource({manifest,sourceCode:header.replace(/static_assert\(FLATBUFFERS_VERSION_MAJOR[\s\S]*?\);\n/g,'')+'\n'+source,language:'c++',outputPath:path.join(target,'dist/isomorphic/module.wasm'),threadModel:'wasi-sequential'});
 if(!result.report?.ok)throw new Error('IERS parser validation failed',{cause:result.report?.issues});
 const entries=await resolveFlowDependencies({depsPath:original});return {...entries.get(manifest.pluginId),manifest,wasmPath:result.outputPath,guestLink:{objectBytes:result.guestLink.objectBytes,metadata:result.guestLink}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const eop=await withFlowStandards(()=>buildEop()),eopRequest=await withFlowStandards(()=>buildEop('request'));
 if(process.argv.includes('--eop-only'))console.log(`Built EOP parser: ${eop.wasmPath}`);
 else{
 const operator=(await import('../../data-source/operator-states-public/build.mjs')).compilation;
 const weather=(await import('../../data-source/space-weather/build.mjs')).compilation;
 const http=await withFlowStandards(()=>buildHook('http-request','http_request_module.cpp')),storage=await withFlowStandards(()=>buildHook('storage-ingest','storage_ingest_module.cpp'));
 // Last: the EH-free typed energy compiler also supplies the final flow link.
 // The SDK owns composition; all physics stays in the linked WASM units.
 const density=(await import('../../analysis/density-calibration/build.mjs')).compilation;
 const ids={operator:'com.digitalarsenal.data-source.operator-states-public',weather:'com.digitalarsenal.data-source.space-weather',density:'com.digitalarsenal.analysis.density-calibration',eop:eop.manifest.pluginId,eopRequest:eopRequest.manifest.pluginId,http:http.manifest.pluginId,storage:storage.manifest.pluginId};
 const node=(id,plugin,method,kind='transform')=>({nodeId:id,pluginId:plugin,methodId:method,kind,drainPolicy:'single-shot'});
 const edge=(from,port,to,target)=>({edgeId:[from,port,to,target].join('-'),fromNodeId:from,fromPortId:port,toNodeId:to,toPortId:target,backpressurePolicy:'queue',queueDepth:1});
 const flow={programId:'com.digitalarsenal.flows.open-dca',name:'Open DCA NRLMSISE-00',version:'0.2.0',engineLinkage:'bridge',description:'Scheduled private Planet energy fits and aggregate E13 log-density correction publication. Raw operator states never enter SDN storage.',
 nodes:[node('operator-plan',ids.operator,'plan_operator'),node('operator-fetch',ids.http,'request'),node('operator-parse',ids.operator,'parse_operator'),node('prepare',ids.density,'prepare_operator_states'),node('eop-plan',ids.eopRequest,'finals2000a'),node('eop-fetch',ids.http,'request'),node('eop-parse',ids.eop,'parse_finals2000a'),node('eop-wrap',ids.operator,'wrap_eop'),node('weather-plan',ids.weather,'plan_weather'),node('weather-fetch',ids.http,'request'),node('weather-parse',ids.weather,'parse_weather'),node('weather-wrap',ids.operator,'wrap_weather'),node('fit',ids.density,'fit_energy_arcs'),node('solve',ids.density,'calibrate_log_density'),node('publish',ids.operator,'publish_correction'),node('ingest',ids.storage,'ingest'),node('egress','sdn.flow.egress','emit','sink')],
 edges:[edge('operator-plan','request','operator-fetch','request'),edge('operator-fetch','response','operator-parse','response'),edge('operator-parse','operator_states','prepare','operator_states'),edge('operator-parse','kernel','fit','kernel'),edge('eop-plan','request','eop-fetch','request'),edge('eop-fetch','response','eop-parse','response'),edge('eop-parse','records','eop-wrap','records'),edge('eop-wrap','earth_orientation','fit','earth_orientation'),edge('prepare','request','fit','request'),edge('weather-plan','request','weather-fetch','request'),edge('weather-fetch','response','weather-parse','response'),edge('weather-parse','records','weather-wrap','records'),edge('weather-wrap','space_weather','fit','space_weather'),edge('fit','arcs','solve','request'),edge('solve','calibration','publish','calibration'),edge('publish','records','ingest','dcl_records'),edge('publish','meta','ingest','meta'),edge('ingest','result','egress','result')],
 triggers:[{triggerId:'daily',kind:'timer',source:'host-cron',defaultIntervalMs:86400000,description:'Causal 30-day fleet solve on the daily operator states public at the issue.'}],triggerBindings:['operator-plan','weather-plan','eop-plan','eop-wrap'].map(targetNodeId=>({triggerId:'daily',targetNodeId,targetPortId:'tick',backpressurePolicy:'queue',queueDepth:1})),requiredPlugins:Object.values(ids)};
 // The production default uses the upstreams; a node-owned archive can replay
 // exact source bytes through the same artifact and ordinary HTTP capability.
 for(const family of ['operator','weather','eop']){
  flow.nodes.push(node(`${family}-route`,ids.operator,'route_request'),node(`${family}-restore`,ids.operator,'restore_response'));
  for(const e of flow.edges){
   if(e.toNodeId===`${family}-fetch`){e.toNodeId=`${family}-route`;}
   if(e.fromNodeId===`${family}-fetch`){e.fromNodeId=`${family}-restore`;}
  }
  flow.edges.push(edge(`${family}-route`,'request',`${family}-fetch`,'request'),edge(`${family}-fetch`,'response',`${family}-restore`,'response'));
 }
 const dependencies=new Map();
 for(const [folder,compilation] of [['data-source/operator-states-public',operator],['data-source/space-weather',weather],['analysis/density-calibration',density]]){const entries=await resolveFlowDependencies({depsPath:path.join(modules,folder)});for(const [id,entry]of entries)dependencies.set(id,{...entry,guestLink:{objectBytes:compilation.guestLink.objectBytes,metadata:compilation.guestLink}});}
 for(const entry of [eop,eopRequest,http,storage])dependencies.set(entry.manifest.pluginId,entry);
 resolveWasiThreadsToolchain({force:true});
 await withFlowStandards(()=>compileFlowProgram({flow,dependencies,outDir:path.join(out,'runtime'),standardsRoot}));
 await fs.copyFile(path.join(out,'runtime/flow.json'),path.join(out,'flow.json'));
 }
}

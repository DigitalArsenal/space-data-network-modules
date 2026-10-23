import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {compileModuleFromSource} from 'space-data-module-sdk/compiler';
import {compileFlowProgram,resolveFlowDependencies} from 'space-data-module-sdk/flow/compiler';
import {generateSdsHeaders} from '../../scripts/lib/sds-cpp-headers.mjs';
const root=fileURLToPath(new URL('.',import.meta.url)), modules=path.resolve(root,'../..');
const require=createRequire(import.meta.url);
process.env.SPACE_DATA_STANDARDS_ROOT=path.dirname(require.resolve('spacedatastandards.org/package.json'));
const out=path.join(root,'dist'),manifest=JSON.parse(await fs.readFile(path.join(root,'plugin-manifest.json'),'utf8'));
const {header,version}=await generateSdsHeaders(['FSO','FSB','OMM','OCM','ERM'],import.meta.url);
const control=await compileModuleFromSource({manifest,sourceCode:header+'\n'+await fs.readFile(path.join(root,'src/control.cpp'),'utf8'),language:'c++',outputPath:path.join(out,'control/isomorphic/module.wasm'),threadModel:'single-thread',allowUndefinedImports:true});
if(!control.report?.ok)throw new Error('Controller artifact rejected',{cause:control.report?.issues});
await fs.writeFile(path.join(out,'control/plugin-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
await fs.writeFile(path.join(out,'control/provenance.json'),JSON.stringify({sds:version,threadModel:'single-thread'},null,2)+'\n');
if(process.argv.includes('--control-only'))process.exit(0);
const gp=JSON.parse(await fs.readFile(path.join(modules,'analysis/gp-error-model/plugin-manifest.json'),'utf8'));
if(!gp.methods.find(m=>m.methodId==='object_covariance')?.outputPorts.some(p=>p.portId==='ocm'))
 throw new Error('BLOCKED: object_covariance must publish its standards-correct OCM output; wait for the gp-error-model claim and the CVR SDS escalation.');
const dependencies=await resolveFlowDependencies({depsPath:path.join(modules,'analysis/gp-error-model')});
dependencies.set(manifest.pluginId,{manifest,wasmPath:control.outputPath,guestLink:{objectBytes:control.guestLink.objectBytes,metadata:control.guestLink}});
for(const folder of ['flatsql-query','storage-ingest']) {
 const resolved=await resolveFlowDependencies({depsPath:path.join(modules,'hostcap',folder)});
 for(const [id,dep] of resolved)dependencies.set(id,dep);
}
const flow=JSON.parse(await fs.readFile(path.join(modules,'flows/object-covariance.flow.json'),'utf8'));
await compileFlowProgram({flow,dependencies,outDir:path.join(out,'runtime'),standardsRoot:process.env.SPACE_DATA_STANDARDS_ROOT});

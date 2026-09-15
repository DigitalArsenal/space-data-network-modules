// Generate only the ratified EOP binding from this package's published SDS pin.
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import createFlatc from 'flatc-wasm/module';
const root=path.dirname(fileURLToPath(import.meta.url));
export async function generateSdsHeaders(){
 const require=createRequire(import.meta.url);
 const standards=path.dirname(require.resolve('spacedatastandards.org/package.json'));
 const version=JSON.parse(fs.readFileSync(path.join(standards,'package.json'),'utf8')).version;
 const schema=fs.readFileSync(path.join(standards,'schema/EOP/main.fbs'),'utf8');
 const flatc=await createFlatc();flatc.FS.mkdir('/eop');flatc.FS.writeFile('/eop/main.fbs',schema);
 const rc=flatc.callMain(['--cpp','--cpp-std','c++17','--gen-object-api','--preserve-case','--no-warnings','-o','/eop','/eop/main.fbs']);
 if(rc!==0)throw new Error(`flatc failed for EOP from spacedatastandards.org@${version}`);
 const header=flatc.FS.readFile('/eop/main_generated.h',{encoding:'utf8'}).replaceAll('FLATBUFFERS_GENERATED_MAIN_H_','FLATBUFFERS_GENERATED_EOP_MAIN_H_');
 fs.mkdirSync(path.join(root,'src/generated/sds'),{recursive:true});
 fs.writeFileSync(path.join(root,'src/generated/sds/EOP_generated.h'),header);
 return {version,headers:{EOP:header}};
}

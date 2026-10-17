import fs from 'node:fs/promises';
import path from 'node:path';
import createFlatc from 'flatc-wasm/module';
// Traverse only the released schema dependency closure. No local IDL copies.
export async function generateHeaders(root, families) {
  const flatc=await createFlatc(), seen=new Set(), order=[];
  flatc.FS.mkdir('/schemas'); flatc.FS.mkdir('/headers');
  async function visit(name) {
    if (seen.has(name)) return;
    seen.add(name);
    const source=await fs.readFile(path.join(root,'schema',name,'main.fbs'),'utf8');
    for (const match of source.matchAll(/include\s+"(?:\.\.\/)?([^/]+)\/main.fbs"/g)) await visit(match[1]);
    flatc.FS.mkdir(`/schemas/${name}`);
    flatc.FS.writeFile(`/schemas/${name}/main.fbs`,source);
    order.push(name);
  }
  for (const name of families) await visit(name);
  const output=[];
  for (const name of order) {
    const rc=flatc.callMain(['--cpp','--gen-object-api','--gen-mutable','--preserve-case','--no-warnings',
      '-I','/schemas','-o','/headers',`/schemas/${name}/main.fbs`]);
    if (rc) throw Error(`flatc ${name}: ${rc}`);
    output.push(flatc.FS.readFile('/headers/main_generated.h',{encoding:'utf8'})
      .replaceAll('FLATBUFFERS_GENERATED_MAIN_H_',`FLATBUFFERS_GENERATED_${name}_MAIN_H_`)
      .replace(/^#include "[^"\n]*main_generated.h"\r?\n/gm,''));
  }
  return output.join('\n');
}

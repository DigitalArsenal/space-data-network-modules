#!/usr/bin/env node
// Reproduce C++ bindings solely from the exact installed npm release. Canonical
// schema files remain owned by SDS; virtual include names avoid main.h clashes.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import createFlatc from 'flatc-wasm/module';

export const packageRoot = path.dirname(fileURLToPath(import.meta.url));
export const standardsRoot = path.join(packageRoot, 'node_modules/spacedatastandards.org');
export const outDir = path.join(packageRoot, 'src/cpp/generated/sds');
export async function generateSdsHeaders() {
  // The pinned release (package.json) must be the installed one; build
  // metadata ("+stamp") is not part of a published version.
  const pinned = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).devDependencies['spacedatastandards.org'];
  const version = JSON.parse(fs.readFileSync(path.join(standardsRoot, 'package.json'), 'utf8')).version.split('+')[0];
  if (version !== pinned) throw new Error(`Expected published SDS ${pinned}, installed ${version}; run npm ci.`);
  const schemas = new Map();
  function visit(code) {
    if (schemas.has(code)) return;
    const source = fs.readFileSync(path.join(standardsRoot, 'schema', code, 'main.fbs'), 'utf8');
    for (const [,dep] of source.matchAll(/include\s+"\.\.\/([A-Z0-9_]+)\/main\.fbs"/g)) visit(dep);
    schemas.set(code, source);
  }
  for (const code of ['CQR', 'PIV', 'TAB', 'EOP']) visit(code);
  const flatc = await createFlatc();
  flatc.FS.mkdir('/schemas'); flatc.FS.mkdir('/headers');
  for (const [code, source] of schemas) {
    flatc.FS.writeFile(`/schemas/${code}.fbs`, source.replace(/include\s+"\.\.\/([A-Z0-9_]+)\/main\.fbs"/g, 'include "$1.fbs"'));
  }
  fs.mkdirSync(outDir, {recursive:true});
  const headers = {};
  for (const [code] of schemas) {
    const result = flatc.callMain(['--cpp','--cpp-std','c++17','--gen-object-api','--preserve-case','--no-warnings','-I','/schemas','-o','/headers',`/schemas/${code}.fbs`]);
    if (result !== 0) throw new Error(`flatc failed for published ${code}: ${result}`);
    headers[code] = flatc.FS.readFile(`/headers/${code}_generated.h`, {encoding:'utf8'});
    fs.writeFileSync(path.join(outDir, `${code}_generated.h`), headers[code]);
  }
  const provenance = {package:'spacedatastandards.org', version, generator:'flatc-wasm@26.1.32', schemas:Object.fromEntries([...schemas].map(([code,source])=>[code, createHash('sha256').update(source).digest('hex')]))};
  fs.writeFileSync(path.join(outDir, 'provenance.json'), JSON.stringify(provenance,null,2)+'\n');
  return {version, headers, outDir, provenance};
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const {version,headers} = await generateSdsHeaders();
  console.log(`Generated ${Object.keys(headers).join(', ')} from published spacedatastandards.org@${version}`);
}

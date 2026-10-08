import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import createFlatc from 'flatc-wasm/module';

export const packageRoot = fileURLToPath(new URL('.', import.meta.url));
export const standardsRoot = path.join(packageRoot, 'node_modules/spacedatastandards.org');
export async function generateSdsBindings() {
  const version = JSON.parse(fs.readFileSync(path.join(standardsRoot, 'package.json'))).version;
  if (version !== '1.232.0') throw new Error(`Expected published SDS 1.232.0; installed ${version}. Run npm ci.`);
  const flatc = await createFlatc();
  const mkdir = p => { try { flatc.FS.mkdir(p); } catch {} };
  for (const p of ['/schemas', '/out_cpp', '/out_ts']) mkdir(p);
  const dependencies = new Map();
  for (const family of fs.readdirSync(path.join(standardsRoot, 'schema'))) {
    const input = path.join(standardsRoot, 'schema', family, 'main.fbs');
    if (!fs.existsSync(input)) continue;
    const schema = fs.readFileSync(input, 'utf8');
    dependencies.set(family, [...schema.matchAll(/^\s*include\s+"\.\.\/([^/]+)\/main\.fbs"/gm)].map(m => m[1]));
    mkdir(`/schemas/${family}`);
    flatc.FS.writeFile(`/schemas/${family}/main.fbs`, schema);
  }
  const families = [];
  const visit = family => { if (families.includes(family)) return; for (const dep of dependencies.get(family) ?? []) visit(dep); families.push(family); };
  visit('PRW');
  // $EOP: the execution request's earth_orientation input.
  visit('EOP');
  const outDir = path.join(packageRoot, 'src/cpp/generated/sds');
  fs.mkdirSync(outDir, {recursive:true});
  for (const family of families) {
    const rc = flatc.callMain(['--cpp', '--cpp-std', 'c++17', '--gen-object-api', '--preserve-case', '--no-warnings', '-I', '/schemas', '-o', '/out_cpp', `/schemas/${family}/main.fbs`]);
    if (rc !== 0) throw new Error(`flatc C++ failed: ${family}`);
    let index = 0;
    const header = flatc.FS.readFile('/out_cpp/main_generated.h', {encoding:'utf8'})
      .replaceAll('FLATBUFFERS_GENERATED_MAIN_H_', `FLATBUFFERS_GENERATED_${family}_MAIN_H_`)
      .replace(/#include "main_generated\.h"/g, () => `#include "${dependencies.get(family)[index++]}_generated.h"`);
    fs.writeFileSync(path.join(outDir, `${family}_generated.h`), header);
  }
  const rc = flatc.callMain(['--ts', '--gen-object-api', '--gen-all', '--preserve-case', '--no-warnings', '-I', '/schemas', '-o', '/out_ts', '/schemas/PRW/main.fbs']);
  if (rc !== 0) throw new Error('flatc TypeScript failed: PRW');
  const jsOut = path.join(packageRoot, 'tests/generated/sds');
  fs.rmSync(jsOut, {recursive:true, force:true});
  const writeJs = dir => {
    for (const name of flatc.FS.readdir(dir)) {
      if (name === '.' || name === '..') continue;
      const file = `${dir}/${name}`;
      if (flatc.FS.isDir(flatc.FS.stat(file).mode)) writeJs(file);
      else if (name.endsWith('.ts')) {
        const target = path.join(jsOut, file.slice('/out_ts/'.length).replace(/\.ts$/, '.js'));
        fs.mkdirSync(path.dirname(target), {recursive:true});
        let source = flatc.FS.readFile(file, {encoding:'utf8'});
        // flatc 26.1.32 preserves the union discriminator accessor name but
        // its generated object unpacker still emits camelCase. Repair only
        // that generator defect; schema fields and on-wire ordinals stay exact.
        if(name==='RFM.ts')source=source.replaceAll('this.referenceFrameType()', 'this.REFERENCE_FRAME_type()');
        fs.writeFileSync(target, stripTypeScriptTypes(source, {mode:'transform', sourceMap:false}));
      }
    }
  };
  writeJs('/out_ts');
  console.log(`Generated ${families.join(', ')} object bindings from published spacedatastandards.org@${version}`);
  return { version, families, outDir };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await generateSdsBindings();

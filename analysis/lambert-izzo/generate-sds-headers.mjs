// Generate from the installed, released SDS schemas. npm SDS has no lib/cpp.
// Dependency order resolves includes in the one SDK translation unit.
import fs from 'node:fs/promises';
import path from 'node:path';
import createFlatc from 'flatc-wasm/module';
export async function generateSdsHeaders(standardsRoot) {
  const families = ['RFM', 'FRM', 'PCE', 'LMS', 'LMO'];
  const flatc = await createFlatc();
  flatc.FS.mkdir('/schemas'); flatc.FS.mkdir('/headers');
  for (const name of families) {
    flatc.FS.mkdir(`/schemas/${name}`);
    flatc.FS.writeFile(`/schemas/${name}/main.fbs`,
      await fs.readFile(path.join(standardsRoot, 'schema', name, 'main.fbs'), 'utf8'));
  }
  const headers = [];
  for (const name of families) {
    const result = flatc.callMain(['--cpp', '--preserve-case',
      '--no-warnings', '-I', '/schemas', '-o', '/headers', `/schemas/${name}/main.fbs`]);
    if (result !== 0) throw new Error(`flatc failed for ${name}: ${result}`);
    headers.push(flatc.FS.readFile('/headers/main_generated.h', {encoding:'utf8'})
      .replaceAll('FLATBUFFERS_GENERATED_MAIN_H_', `FLATBUFFERS_GENERATED_${name}_MAIN_H_`)
      .replace(/^#include "main_generated.h"\r?\n/gm, ''));
  }
  return headers.join('\n\n');
}

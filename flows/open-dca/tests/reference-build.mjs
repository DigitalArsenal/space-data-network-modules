// Rebuild unchanged current-main foundation references with the same sanctioned
// WASI compiler used by this task. The older package's default chooses its
// legacy Emscripten compiler; this test explicitly requests wasi-sequential.
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {modules,require} from './inputs.mjs';
for(const folder of ['foundation/time','foundation/frames']){
 const file=path.join(modules,folder,'build.mjs'),url=pathToFileURL(file).href;
 let source=await fs.readFile(file,'utf8');
 source=source.replace(/from (["'])space-data-module-sdk\/compiler\1/g,`from ${JSON.stringify(pathToFileURL(require.resolve('space-data-module-sdk/compiler')).href)}`)
   .replace(/from (["'])(\.\.?\/[^"']+)\1/g,(_,quote,spec)=>`from ${JSON.stringify(new URL(spec,url).href)}`)
   .replace('const sourceCode =',`manifest.sequentialJustification={kind:'pure-transform',detail:'Independent reference physics; no threads or host calls.'};\nconst sourceCode =`).replaceAll('import.meta.url',JSON.stringify(url)).replace('threadModel: "single-thread"','threadModel: "wasi-sequential"');
 await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
}

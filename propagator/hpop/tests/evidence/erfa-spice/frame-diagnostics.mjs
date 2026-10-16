// Build the offline C++ measurement helper in a caller-owned worktree directory.
// JavaScript only handles files, processes and WASM ABI transport.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { composeErfaTranslationUnit } from '../../../../../foundation/frames/erfa-amalgamation.mjs';
export const here=path.dirname(fileURLToPath(import.meta.url));
export const root=path.resolve(here,'../../../../..');
export async function build(work) {
 const erfa=path.join(root,'higherpop/third_party/erfa');
 const source=fs.readFileSync(path.join(erfa,'nut80.c'),'utf8');
 const table=source.match(/\} x\[\] = \{([\s\S]*?)\n   \};/);
 if(!table)throw new Error('Cannot locate pinned ERFA nut80 coefficient table');
 fs.writeFileSync(path.join(work,'erfa-nutation-table.inc'),table[1]);
 fs.writeFileSync(path.join(work,'erfa.cpp'),(await composeErfaTranslationUnit()).source);
 const bin=path.join(work,'frame-diagnostics');
 execFileSync('c++',['-std=c++17','-O2','-ffp-contract=off',...[
  work,path.join(root,'propagator/hpop/lib'),path.join(root,'propagator/hpop/src/cpp/include'),path.join(root,'foundation/frames/src'),erfa,
 ].flatMap(p=>['-I',p]),path.join(here,'frame-diagnostics.cpp'),path.join(work,'erfa.cpp'),'-o',bin],{stdio:'pipe',env:{...process.env,TMPDIR:work,TMP:work,TEMP:work}});
 return (mode,...extra)=>JSON.parse(execFileSync(bin,[mode,path.join(here,'hpop-frames.json'),path.join(here,'reference.json'),...extra],{encoding:'utf8',maxBuffer:16<<20}));
}

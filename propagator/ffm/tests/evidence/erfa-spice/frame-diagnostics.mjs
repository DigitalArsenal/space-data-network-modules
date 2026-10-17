// Offline C++ reduction; JavaScript handles files and processes only.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export const here=path.dirname(fileURLToPath(import.meta.url));
export const root=path.resolve(here,'../../../../..');
export async function build(work) {
 const bin=path.join(work,'frame-diagnostics');
 const env={...process.env,TMPDIR:work,TMP:work,TEMP:work};
 execFileSync('c++',['-std=c++17','-O2','-ffp-contract=off','-I',path.join(root,'propagator/ffm/lib'),'-I',path.join(root,'propagator/ffm/src/cpp/include'),path.join(here,'frame-diagnostics.cpp'),'-o',bin],{stdio:'pipe',env});
 return (ffm=path.join(here,'ffm-frames.json'),reference=path.join(here,'reference.json'))=>JSON.parse(execFileSync(bin,['score',ffm,reference,...(fs.existsSync(path.join(here,'classical-frames-10k.json'))?[path.join(here,'classical-frames-10k.json')]:[])],{encoding:'utf8',maxBuffer:16<<20,env}));
}

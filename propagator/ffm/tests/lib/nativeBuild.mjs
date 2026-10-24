// Native (host c++) builds of small C++ test drivers over the module's own sources, compiled in parallel into a scratch
// directory under .sdk-build and removed afterwards. The module's ERFA amalgamation is compiled once.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { composeErfaTranslationUnit } from '../../../../foundation/frames/erfa-amalgamation.mjs';

const exec = promisify(execFile);
const ffm = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repo = path.resolve(ffm, '../..');
const includes = ['lib', '../../third_party/nrlmsise00', '../../third_party/hwm14', '../../higherpop/third_party/erfa'].flatMap((d) => ['-I', path.resolve(ffm, d)]);

export async function buildNative(name, sources) {
  const build = path.join(ffm, '.sdk-build');
  fs.mkdirSync(build, { recursive: true });
  const work = fs.mkdtempSync(path.join(build, `native-${name}-`));
  const erfa = path.join(work, 'erfa.cpp');
  fs.writeFileSync(erfa, (await composeErfaTranslationUnit()).source);
  const jobs = [['erfa.cpp', erfa], ...sources.map((s) => [path.basename(s), path.resolve(ffm, s)])];
  const objects = await Promise.all(jobs.map(async ([label, file], i) => {
    const object = path.join(work, `${i}-${label}.o`);
    const c = file.endsWith('.c');
    await exec(c ? 'cc' : 'c++', [...(c ? ['-std=c11'] : ['-std=c++17', '-Wno-c23-extensions']), '-O1', ...includes, '-c', file, '-o', object], { maxBuffer: 1 << 26 });
    return object;
  }));
  const binary = path.join(work, name);
  await exec('c++', [...objects, '-o', binary], { maxBuffer: 1 << 26 });
  return { binary, dispose: () => fs.rmSync(work, { recursive: true, force: true }) };
}
export const run = async (binary, args) => (await exec(binary, args.map(String), { maxBuffer: 1 << 26 })).stdout;
export { repo };

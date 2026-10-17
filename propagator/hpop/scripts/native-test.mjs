// Build the native tests' shared ERFA dependency without changing their drivers.
// The temporary compiler launcher is scoped to the test child process's PATH;
// all generated sources, objects, executables and TMPDIR files stay in HPOP.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { composeErfaTranslationUnit } from '../../../foundation/frames/erfa-amalgamation.mjs';

const hpop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(hpop, '../..');
const erfaInclude = path.join(repo, 'higherpop/third_party/erfa');
const build = path.join(hpop, '.sdk-build');
fs.mkdirSync(build, { recursive: true });
const work = fs.mkdtempSync(path.join(build, 'native-tests-'));
const tmp = path.join(work, 'tmp');
const bin = path.join(work, 'bin');
fs.mkdirSync(tmp); fs.mkdirSync(bin);
const environment = { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp };
try {
const cxx = process.env.PATH.split(path.delimiter).map((dir) => path.resolve(dir, 'c++'))
  .find((candidate) => { try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; } });
if (!cxx) throw new Error('Native HPOP tests require the local C++ compiler.');
const unit = path.join(work, 'erfa.cpp');
const object = path.join(work, 'erfa.o');
const archive = path.join(work, 'liberfa.a');
fs.writeFileSync(unit, (await composeErfaTranslationUnit()).source);
execFileSync(cxx, ['-std=c++17', '-O2', '-I', erfaInclude, '-c', unit, '-o', object], { stdio: 'inherit', cwd: hpop, env: environment });
execFileSync('ar', ['rcs', archive, object], { stdio: 'inherit', cwd: hpop, env: environment });
const wrapper = `
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const link = !args.some((arg) => ['-c', '-E', '-S', '-fsyntax-only', '--version', '-v'].includes(arg));
const run = spawnSync(${JSON.stringify(cxx)}, ['-I', ${JSON.stringify(erfaInclude)}, ...args, ...(link ? [${JSON.stringify(archive)}] : [])], { stdio: 'inherit' });
if (run.error) { process.stderr.write(String(run.error) + '\\n'); process.exit(1); }
process.exit(run.status ?? 1);
`;
const launcher = path.join(bin, 'compiler.cjs');
fs.writeFileSync(launcher, wrapper);
const quote = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
fs.writeFileSync(path.join(bin, 'c++'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(launcher)} \"$@\"\n`, { mode: 0o755 });
const result = spawnSync(process.execPath, process.argv.slice(2), {
  cwd: hpop, stdio: 'inherit',
  env: { ...environment, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

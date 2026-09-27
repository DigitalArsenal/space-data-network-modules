#!/usr/bin/env node
// SDK public compiler hook. Keep C++ globals alive for the resident
// instance and guard the command/reactor constructor paths. SDK still owns
// wasi-threads flags, PIV, PLG, allocation, linking and artifact validation.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const compiler = process.env.CQR_SDK_CLANGXX;
if (!compiler) throw new Error('Run this compiler hook through node build.mjs.');
const flags = args.includes('--version') ? [] : ['-fno-c++-static-destructors'];
if (!args.includes('--version') && !args.includes('-c')) {
  flags.push(path.join(packageRoot, 'src/cpp/src/cqr_initialization.cpp'),
    '-Wl,--wrap=__wasm_call_ctors', '-Wl,--export=_initialize');
}
const result = spawnSync(compiler, [...args, ...flags], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);

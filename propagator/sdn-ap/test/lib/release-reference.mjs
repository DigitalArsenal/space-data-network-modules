// The committed 0.6.60 artifact is the independent binary compatibility control.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {packageRoot} from './module.mjs';
import {scratchTemp} from './scratch.mjs';
export function releaseReference(){
 const bytes=execFileSync('git',['show','6eeff4b6:propagator/sdn-ap/dist/isomorphic/module.wasm'],{cwd:path.resolve(packageRoot,'../..'),maxBuffer:1<<26});
 const file=path.join(scratchTemp('release-reference-'),'module.wasm');
 fs.writeFileSync(file,bytes);return file;
}

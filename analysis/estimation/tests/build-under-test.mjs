// Builds the module under test from the committed sources and the local
// Estimation.fbs into the ignored tests/.generated tree, so a schema addition
// the standards release has not published yet is exercised without committing
// generated code or touching the tracked dist. The build is cached by the hash
// of everything it reads. Framing only: the physics is the C++ WASM.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const INPUTS = ['build.mjs', 'generate-sds-headers.mjs', 'plugin-manifest.json', 'schemas/Estimation.fbs'];

function sourceHash() {
  const hash = crypto.createHash('sha256');
  const files = [...INPUTS, ...fs.readdirSync(path.join(root, 'src')).filter((n) => /\.(cpp|hpp)$/.test(n)).sort().map((n) => `src/${n}`)];
  for (const file of files) hash.update(file).update(fs.readFileSync(path.join(root, file)));
  return hash.digest('hex').slice(0, 16);
}

// Returns { wasm, manifest, directory, hash } for the current sources.
export function moduleUnderTest() {
  const hash = sourceHash();
  const directory = path.join(root, 'tests/.generated/module-under-test', hash);
  const wasm = path.join(directory, 'dist/isomorphic/module.wasm');
  if (!fs.existsSync(wasm)) {
    const run = spawnSync(process.execPath, ['build.mjs', '--out', directory], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
    if (run.status !== 0) throw new Error(`module build failed (${run.status}):\n${(run.stderr || '').split('\n').filter((l) => !/warning:|snake_case/.test(l)).slice(-60).join('\n')}${run.stdout.split('\n').slice(-20).join('\n')}`);
  }
  return { wasm, manifest: path.join(root, 'plugin-manifest.json'), directory, hash };
}

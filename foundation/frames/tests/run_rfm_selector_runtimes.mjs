// Each runtime executes the numerical tests through the production invoke
// surface, with the same immutable shipped WASM artifact. Explicit execution
// fails when native/container WasmEdge is unavailable; it never silently skips.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { toLoadableWasmBytes } from 'space-data-module-sdk/bundle';

const root = fileURLToPath(new URL('..', import.meta.url));
const artifact = path.join(root, 'dist/isomorphic/module.wasm');
const original = await fs.readFile(artifact);
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lane08-rfm-invoke-'));
const wrapper = path.join(directory, 'wasmedge-container');
const dockerImage = process.env.SDN_FRAME_DOCKER_IMAGE || 'space-data-module-sdk/parity-wasmedge:0.16.4';
try {
  // Mount only the SDK's loadable copy, read-only and with networking disabled.
  // Forward argv directly; no user-provided string is evaluated as shell code.
  await fs.writeFile(wrapper, `#!/usr/bin/env python3
import os,sys
wasm=next(os.path.abspath(a) for a in sys.argv[1:] if a.endswith('.wasm'))
os.execvp('docker',['docker','run','--rm','-i','--network','none','-v',wasm+':'+wasm+':ro','--entrypoint','wasmedge',${JSON.stringify(dockerImage)}]+sys.argv[1:])
`, { mode: 0o755 });
  for (const [name, binary] of [
    ['browser/V8', null],
    ['native WasmEdge', process.env.SDM_WASMEDGE_BINARY || 'wasmedge'],
    ['container WasmEdge', wrapper],
  ]) {
    const env = { ...process.env };
    // A parity gate itself runs under node:test. Its inherited context makes
    // a nested --test process skip all files while exiting zero unless removed.
    delete env.NODE_TEST_CONTEXT;
    if (binary) env.SDN_FRAME_WASMEDGE_BINARY = binary;
    else delete env.SDN_FRAME_WASMEDGE_BINARY;
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'tests/rfm_selectors.test.mjs'], {
      cwd: root, env, encoding: 'utf8', timeout: 120000,
    });
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    assert.equal(result.status, 0, `${name} failed: ${result.error ?? ''}`);
    assert.match(result.stdout, /# tests 23\b/, `${name} did not execute the complete selector suite`);
    assert.match(result.stdout, /# pass 23\b/, `${name} did not pass all selector tests`);
    assert.match(result.stdout, /# fail 0\b/, `${name} reported failures`);
    assert.match(result.stdout, /# skipped 0\b/, `${name} skipped a required check`);
    assert.deepEqual(await fs.readFile(artifact), original, 'production artifact changed between runtimes');
    console.log(`PASS production ${name}: all 8 ratified RFM selectors, inverse/state/rate/validation checks`);
  }
  console.log(`production same-byte SHA256 ${createHash('sha256').update(toLoadableWasmBytes(original)).digest('hex')}`);
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('SPK 2/3 closed forms, byte orders, barycentre chains and malformed input', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const temp = mkdtempSync(path.join(tmpdir(), 'sdn-chebyshev-'));
  try {
    const binary = path.join(temp, 'spk_chebyshev');
    execFileSync('c++', ['-std=c++17', '-O2', '-I', path.join(here, '../src'),
      path.join(here, 'spk_chebyshev_native.cpp'), '-o', binary], { stdio: 'pipe' });
    const output = execFileSync(binary, [], { encoding: 'utf8' });
    console.log(output.trim());
    assert.match(output, /0 failures PASS/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

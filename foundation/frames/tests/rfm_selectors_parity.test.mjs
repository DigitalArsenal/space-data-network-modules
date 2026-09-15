import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('all new RFM selectors pass production invoke tests in three runtimes', {
  skip: process.env.SDN_FRAME_TRI_RUNTIME !== '1',
}, async () => {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['tests/run_rfm_selector_runtimes.mjs'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)), env: process.env, stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      try { assert.equal(code, 0, `selector tri-runtime run failed: signal=${signal}`); resolve(); }
      catch (error) { reject(error); }
    });
  });
});

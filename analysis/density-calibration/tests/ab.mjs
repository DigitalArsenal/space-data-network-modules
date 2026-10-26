// A build of analysis/density-calibration against the same module at a named
// commit: every request of tests/cases.mjs (each method under JB2008 and
// NRLMSISE-00, and the requests they expect refused) must give the same status
// and byte-identical outputs from both artifacts. The E2E of a change that
// must not move this module's results (one shared with propagator/ffm).
//   node analysis/density-calibration/tests/ab.mjs --baseline <commit>
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';
import { DCL_TYPE, encodeDcl, encodeRequest } from './dcl.mjs';
import { cases } from './cases.mjs';

const { values: o } = parseArgs({ options: { baseline: { type: 'string' } } });
assert(o.baseline, 'usage: ab.mjs --baseline <commit>');
const root = fileURLToPath(new URL('..', import.meta.url));
const wasm = path.join(root, 'dist/isomorphic/module.wasm');
const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' }).trim();
const commit = execFileSync('git', ['rev-parse', `${o.baseline}^{commit}`], { cwd: root, encoding: 'utf8' }).trim();
const baseline = execFileSync('git', ['show', `${commit}:${path.relative(repo, wasm)}`], { cwd: root, maxBuffer: 64 << 20 });
const candidate = fs.readFileSync(wasm);
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'plugin-manifest.json'), 'utf8'));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const frame = (methodId, body) => ({ methodId, inputs: [{ portId: 'request', payload: encodeDcl(encodeRequest(methodId, body).dcl), typeRef: DCL_TYPE }] });
async function outputs(bytes) {
  const h = await createBrowserModuleHarness({ wasmSource: await WebAssembly.compile(bytes), manifest, surface: 'direct' });
  try {
    const rows = [];
    for (const c of cases) {
      const r = await h.invoke(frame(c.method, c.request));
      rows.push({ id: c.id, status: r.statusCode, error: r.errorCode ?? null, outputs: (r.outputs ?? []).map((x) => `${x.portId}:${sha(x.payload)}`) });
    }
    return rows;
  } finally { await h.destroy(); }
}
const [a, b] = [await outputs(baseline), await outputs(candidate)];
const differ = a.filter((row, i) => JSON.stringify(row) !== JSON.stringify(b[i])).map((row) => row.id);
console.log(JSON.stringify({ baselineCommit: commit, baselineWasmSha256: sha(baseline), candidateWasmSha256: sha(candidate), cases: a.length, differ }, null, 1));
assert.deepEqual(differ, [], `cases whose status or outputs differ: ${differ.join(', ')}`);

// A build of analysis/density-calibration against the same module at a named
// commit: every request of tests/cases.mjs (each method under JB2008 and
// NRLMSISE-00, and the requests they expect refused) must give the same status
// and byte-identical outputs from both artifacts. The E2E of a change that
// must not move this module's results (one shared with propagator/ffm).
// With --bound-rel B, outputs may differ in value: every number of each
// unpacked $DCL answer must lie within B of the baseline's, relative to the
// larger magnitude of the two, every other field must be equal, and the
// largest relative difference of each case is reported; --out writes the
// report (conformance/ab.json is the receipt of the module's latest change).
//   node analysis/density-calibration/tests/ab.mjs --baseline <commit> [--bound-rel B] [--out <file>]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';
import { DCL_TYPE, decodeDcl, encodeDcl, encodeRequest } from './dcl.mjs';
import { cases } from './cases.mjs';

const { values: o } = parseArgs({ options: { baseline: { type: 'string' }, 'bound-rel': { type: 'string', default: '0' }, out: { type: 'string' } } });
assert(o.baseline, 'usage: ab.mjs --baseline <commit> [--bound-rel B]');
const bound = Number(o['bound-rel']);
assert(bound >= 0, '--bound-rel must be a nonnegative number');
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
      rows.push({ id: c.id, status: r.statusCode, error: r.errorCode ?? null, outputs: (r.outputs ?? []).map((x) => `${x.portId}:${sha(x.payload)}`),
        answers: (r.outputs ?? []).map((x) => decodeDcl(x.payload)) });
    }
    return rows;
  } finally { await h.destroy(); }
}
// The largest relative difference over two unpacked answers, and where; a
// structural or non-numeric difference is Infinity.
function compare(x, y, at = '') {
  if (typeof x === 'number' && typeof y === 'number') {
    if (Object.is(x, y) || (Number.isNaN(x) && Number.isNaN(y))) return { rel: 0, at };
    const scale = Math.max(Math.abs(x), Math.abs(y));
    return { rel: Number.isFinite(scale) && scale > 0 ? Math.abs(x - y) / scale : Infinity, at };
  }
  if (x && y && typeof x === 'object' && typeof y === 'object' && !ArrayBuffer.isView(x)) {
    const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
    let worst = { rel: 0, at };
    for (const k of keys) {
      if (!(k in x) || !(k in y)) return { rel: Infinity, at: `${at}.${k}` };
      const d = compare(x[k], y[k], `${at}.${k}`);
      if (d.rel > worst.rel) worst = d;
    }
    return worst;
  }
  if (ArrayBuffer.isView(x) && ArrayBuffer.isView(y)) return compare([...x], [...y], at);
  return { rel: x === y ? 0 : Infinity, at };
}
const [a, b] = [await outputs(baseline), await outputs(candidate)];
const rows = a.map((row, i) => {
  const other = b[i];
  const same = row.status === other.status && row.error === other.error && row.outputs.length === other.outputs.length;
  const identical = same && JSON.stringify(row.outputs) === JSON.stringify(other.outputs);
  const d = !same ? { rel: Infinity, at: 'status' } : identical ? { rel: 0, at: '' } : compare(row.answers, other.answers);
  return { id: row.id, identical, maxRelativeDifference: d.rel, at: d.at };
});
const differ = rows.filter((r) => !r.identical).map((r) => r.id);
const beyond = rows.filter((r) => !(r.maxRelativeDifference <= bound)).map((r) => r.id);
const worst = rows.reduce((w, r) => (r.maxRelativeDifference > w.maxRelativeDifference ? r : w), rows[0]);
const report = JSON.stringify({ baselineCommit: commit, baselineWasmSha256: sha(baseline), candidateWasmSha256: sha(candidate), cases: a.length,
  boundRelative: bound, differ, beyond, worst, rows: bound > 0 ? rows : undefined }, null, 1);
console.log(report);
assert.deepEqual(beyond, [], `cases beyond the relative bound ${bound}: ${beyond.join(', ')}`);
if (o.out) fs.writeFileSync(o.out, `${report}\n`);

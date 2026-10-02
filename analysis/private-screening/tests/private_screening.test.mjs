// End to end through the compiled module: the two outcomes the decoy study
// rests on.
//  1. distinguish: decoys drawn from the real distribution leave the real
//     history first of N about 1/N of the time (N_eff ~ N); separable decoys
//     leave it first every time (N_eff = 1).
//  2. A rotated copy is the same orbit: rotation about the pole keeps a, e and
//     i, so its catalog distance to the object it copies is exactly 0.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';

const root = new URL('../', import.meta.url);
const harness = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(new URL('dist/isomorphic/module.wasm', root)),
  manifest: JSON.parse(fs.readFileSync(new URL('plugin-manifest.json', root), 'utf8')), surface: 'direct' });
test.after(() => harness.destroy());
const json = (portId, value) => ({ portId, payload: Buffer.from(JSON.stringify(value)), typeRef: { schemaName: 'application/json' } });
async function call(methodId, inputs) {
  const r = await harness.invoke({ methodId, inputs });
  assert.equal(r.statusCode, 0, r.errorMessage);
  return JSON.parse(Buffer.from(r.outputs[0].payload).toString());
}

let seed = 7;
const uniform = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const normal = () => Math.sqrt(-2 * Math.log(1 - uniform())) * Math.cos(2 * Math.PI * uniform());

test('N_eff is about N for indistinguishable decoys and 1 for separable ones', async () => {
  const rows = (shift) => Array.from({ length: 1200 }, (_, k) => ({ target: `T${k % 600}`, role: k < 600 ? 'real' : 'decoy',
    x: [normal() + (k < 600 ? shift : 0), normal()] }));
  const options = json('options', { ranks: [10], rounds: 50 });
  const same = await call('distinguish', [json('features', { names: ['a', 'b'], rows: rows(0) }), options]);
  assert.ok(Math.abs(same.auc - 0.5) < 0.06, `AUC ${same.auc}`);
  assert.ok(same.first[0].nEffective > 6 && same.first[0].nEffective < 16, `N_eff ${same.first[0].nEffective}`);
  const apart = await call('distinguish', [json('features', { names: ['a', 'b'], rows: rows(50) }), options]);
  assert.equal(apart.auc, 1);
  assert.equal(apart.first[0].nEffective, 1);
});

test('a rotated copy has catalog distance 0 to the object it copies', async () => {
  const from = Date.parse('2026-08-02T00:00:00Z') / 1000, days = 10;
  const objects = Array.from({ length: 12 }, (_, k) => {
    const t = Array.from({ length: days * 3 }, (_, j) => from + j * 28800 + 600 * k);
    return { id: String(1000 + k), t, n: t.map((_, j) => 15.0 + 0.05 * k + 1e-5 * j), e: t.map(() => 0.001 + 1e-4 * k),
      i: t.map(() => 45 + 3 * k), raan: t.map((_, j) => (10 * k + 4 * j) % 360), argp: t.map(() => 90),
      ma: t.map((_, j) => (37 * j) % 360), bstar: t.map(() => 1e-4) };
  });
  const window = [from, from + days * 86400];
  const decoys = await call('decoys', [json('population', { objects }), json('options', { generator: 'rotated', window })]);
  assert.equal(decoys.objects.length, objects.length);
  const features = await call('features', [json('histories', { objects: [...objects, ...decoys.objects] }), json('options', { view: 'gp', window })]);
  const at = features.names.indexOf('catalogDistance');
  for (const row of features.rows.filter((r) => r.role === 'decoy')) assert.ok(row.x[at] < 1e-9, row.id);   // 0 to the last digit carried
  for (const row of features.rows.filter((r) => r.role === 'real')) assert.ok(row.x[at] > 0, row.id);
});

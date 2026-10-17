// End to end through the compiled module, typed: histories in as $LFV rows
// with their $OMM element sets, settings as node config (plugin.getConfig),
// feature rows and the distinguishing report out as $LFV. The two outcomes
// the decoy study rests on:
//  1. distinguish: decoys drawn from the real distribution leave the real
//     history first of N about 1/N of the time (N_eff ~ N); separable decoys
//     leave it first every time (N_eff = 1).
//  2. A rotated copy is the same orbit: rotation about the pole keeps a, e and
//     i, so its catalog distance to the object it copies is exactly 0.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import { validateArtifactWithStandards } from 'space-data-module-sdk/compliance';
import { historiesLfv, windowsOem, featuresLfv, readLfv, lfvHistories, roleName, isoEpoch, unixEpoch, LFV } from './sds.mjs';

const standardsRoot = process.env.SPACE_DATA_STANDARDS_ROOT ?? path.dirname(createRequire(import.meta.url).resolve('spacedatastandards.org/package.json'));
const wasmPath = fileURLToPath(new URL('../dist/isomorphic/module.wasm', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(new URL('../plugin-manifest.json', import.meta.url), 'utf8'));
const frame = (portId, payload, code) => ({ portId, payload,
  typeRef: { schemaName: `${code}.fbs`, fileIdentifier: `$${code}`, rootTypeName: code, wireFormat: 'flatbuffer' } });
// One harness per config: the settings are node config.
async function invoke(methodId, inputs, config) {
  const harness = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(wasmPath), manifest, surface: 'direct', hostOptions: { config } });
  try {
    return await harness.invoke({ methodId, inputs });
  } finally {
    await harness.destroy();
  }
}
async function call(methodId, inputs, config) {
  const r = await invoke(methodId, inputs, config);
  assert.equal(r.statusCode, 0, r.errorMessage);
  assert.equal(r.outputs.length, 1);
  return readLfv(r.outputs[0].payload);
}

let seed = 7;
const uniform = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const normal = () => Math.sqrt(-2 * Math.log(1 - uniform())) * Math.cos(2 * Math.PI * uniform());

test('the artifact satisfies the SDK contract: one concrete type per port', async () => {
  const report = await validateArtifactWithStandards({ wasmPath, manifest, standardsRoot });
  assert.equal(report.ok, true, JSON.stringify(report.issues));
  for (const method of manifest.methods)
    for (const port of [...method.inputPorts, ...method.outputPorts])
      for (const set of port.acceptedTypeSets) {
        assert.equal(set.allowedTypes.length, 1, `${method.methodId}.${port.portId}`);
        assert.equal(set.allowedTypes[0].wireFormat, 'flatbuffer');
        assert.equal(set.allowedTypes[0].acceptsAnyFlatbuffer, undefined);
      }
});

test('epochs travel as ISO 8601 and come back to the same double', () => {
  for (const t of [1785628800, 1785628800.125, 1785628800 + 1 / 3, 1785651234.987654321]) assert.equal(unixEpoch(isoEpoch(t)), t);
});

test('N_eff is about N for indistinguishable decoys and 1 for separable ones', async () => {
  const rows = (shift) => Array.from({ length: 1200 }, (_, k) => ({ target: `T${k % 600}`, role: k < 600 ? 'real' : 'decoy',
    x: [normal() + (k < 600 ? shift : 0), normal()] }));
  const config = { distinguish: { ranks: [10], rounds: 50 } };
  const same = (await call('distinguish', [frame('features', featuresLfv({ names: ['a', 'b'], rows: rows(0) }), 'LFV')], config)).REPORT;
  assert.ok(Math.abs(same.AUC - 0.5) < 0.06, `AUC ${same.AUC}`);
  assert.equal(same.RANK_PROBABILITIES[0].N, 10);
  assert.ok(same.RANK_PROBABILITIES[0].N_EFFECTIVE > 6 && same.RANK_PROBABILITIES[0].N_EFFECTIVE < 16, `N_eff ${same.RANK_PROBABILITIES[0].N_EFFECTIVE}`);
  assert.equal(same.REAL_COUNT, 600);
  assert.equal(same.CLASSIFIER.ROUNDS, 50);
  const apart = (await call('distinguish', [frame('features', featuresLfv({ names: ['a', 'b'], rows: rows(50) }), 'LFV')], config)).REPORT;
  assert.equal(apart.AUC, 1);
  assert.equal(apart.RANK_PROBABILITIES[0].N_EFFECTIVE, 1);
  assert.equal(apart.THRESHOLDS.length, 1);
  assert.ok(apart.THRESHOLDS[0].EPSILON_LOWER_BOUND > 0);
});

const from = Date.parse('2026-08-02T00:00:00Z') / 1000, days = 10;
const window = [from, from + days * 86400];
const objects = Array.from({ length: 12 }, (_, k) => {
  const t = Array.from({ length: days * 3 }, (_, j) => from + j * 28800 + 600 * k);
  return { id: String(1000 + k), t, n: t.map((_, j) => 15.0 + 0.05 * k + 1e-5 * j), e: t.map(() => 0.001 + 1e-4 * k),
    i: t.map(() => 45 + 3 * k), raan: t.map((_, j) => (10 * k + 4 * j) % 360), argp: t.map(() => 90),
    ma: t.map((_, j) => (37 * j) % 360), bstar: t.map(() => 1e-4) };
});

test('a rotated copy has catalog distance 0 to the object it copies', async () => {
  const decoys = await call('decoys', [frame('population', historiesLfv(objects), 'LFV')], { decoys: { generator: 'rotated', window } });
  assert.equal(decoys.ROWS.length, objects.length);
  assert.equal(decoys.REFERENCE_COUNT, objects.length);
  for (const row of decoys.ROWS) {
    assert.equal(row.ROLE, LFV.lfvRole.Decoy);
    assert.equal(row.GENERATOR, 'rotated');
    assert.ok(row.ELEMENT_SETS.length >= 6);
  }
  const histories = [...objects, ...lfvHistories(decoys)];
  const features = await call('features', [frame('histories', historiesLfv(histories), 'LFV')], { features: { view: 'gp', window } });
  assert.equal(features.VIEW, 'gp');
  const at = features.FEATURE_NAMES.indexOf('catalogDistance');
  for (const row of features.ROWS.filter((r) => roleName(r.ROLE) === 'decoy')) assert.ok(row.VALUES[at] < 1e-9, row.SOURCE_ID);   // 0 to the last digit carried
  for (const row of features.ROWS.filter((r) => roleName(r.ROLE) === 'real')) assert.ok(row.VALUES[at] > 0, row.SOURCE_ID);
});

test('the ffm view reads the daily windows from the $OEM', async () => {
  const mu = 398600.4418e9;
  const ffm = objects.map((o, k) => {
    const a = (6378.1363 + 500 + 10 * k) * 1e3, w = Math.sqrt(mu / a ** 3), inc = (45 + 3 * k) * Math.PI / 180;
    const state = (t) => {
      const u = w * (t - from);
      return [t, a * Math.cos(u), a * Math.sin(u) * Math.cos(inc), a * Math.sin(u) * Math.sin(inc),
        -a * w * Math.sin(u), a * w * Math.cos(u) * Math.cos(inc), a * w * Math.cos(u) * Math.sin(inc)];
    };
    return { id: o.id, windows: Array.from({ length: days }, (_, d) => {
      const t0 = from + d * 86400;
      return { t: t0, samples: Array.from({ length: 8 }, (_, j) => state(t0 + j * 2 * Math.PI / w / 8)), end: state(t0 + 86400) };
    }) };
  });
  const f = await call('features', [frame('histories', historiesLfv(ffm), 'LFV'), frame('ephemerides', windowsOem(ffm), 'OEM')],
    { features: { view: 'ffm', window } });
  assert.equal(f.VIEW, 'ffm');
  assert.equal(f.ROWS.length, ffm.length);
  const a = f.FEATURE_NAMES.indexOf('aKm'), jump = f.FEATURE_NAMES.indexOf('jumpRKm');
  f.ROWS.forEach((row, k) => {
    assert.ok(Math.abs(row.VALUES[a] - (6378.1363 + 500 + 10 * k)) < 1e-6, `${row.SOURCE_ID} a ${row.VALUES[a]}`);
    assert.ok(Math.abs(row.VALUES[jump]) < 1e-6, `${row.SOURCE_ID} jump ${row.VALUES[jump]}`);   // the end state is the next window's start
  });
});

test('bad settings and untyped input are refused', async () => {
  const pop = frame('population', historiesLfv(objects), 'LFV');
  let r = await invoke('decoys', [pop], { decoys: { generator: 'shuffled', window } });
  assert.equal(r.errorCode, 'invalid-options');
  r = await invoke('decoys', [pop], { decoys: { generator: 'rotated' } });
  assert.equal(r.errorCode, 'invalid-options');
  r = await invoke('features', [frame('histories', historiesLfv(objects), 'LFV')], { features: { view: 'radar', window } });
  assert.equal(r.errorCode, 'invalid-options');
  r = await invoke('distinguish', [frame('features', featuresLfv({ names: ['a'], rows: [{ target: 'T', role: 'real', x: [1] }] }), 'LFV')], {});
  assert.equal(r.errorCode, 'too-few-rows');
  r = await invoke('decoys', [{ portId: 'population', payload: Buffer.from(JSON.stringify({ objects })), typeRef: { schemaName: 'application/json' } }],
    { decoys: { generator: 'rotated', window } });
  assert.notEqual(r.statusCode, 0);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Builder } from 'flatbuffers';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import { validateArtifactWithStandards } from 'space-data-module-sdk/compliance';

const wasm = fs.readFileSync(new URL('../dist/isomorphic/module.wasm', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(new URL('../plugin-manifest.json', import.meta.url)));
const encoder = new TextEncoder(), decoder = new TextDecoder();
function cat(norad, name = 'Object', designator = '') {
  const b = new Builder(256);
  const n = b.createString(name), d = b.createString(designator);
  b.startObject(3); b.addFieldOffset(0, n, 0); b.addFieldOffset(1, d, 0); b.addFieldInt32(2, norad, 0);
  b.finishSizePrefixed(b.endObject(), '$CAT');
  return new Uint8Array(b.asUint8Array());
}
const layer = (id, nativeKeys) => ({ id, node: `peer-${id}`, provider: id, source: 'catalog', head: `immutable-${id}`, ...(nativeKeys ? { nativeKeys } : {}) });
const recipe = (layers) => ({ version: 1, layers, asOf: 1000, maxAgeSeconds: 100, stateSources: ['preferred', 'fallback'], overrides: {} });
function request(config, catalogs) {
  const payload = encoder.encode(JSON.stringify(config));
  return { methodId: 'compose', inputs: [
    { portId: 'recipe', typeRef: { wireFormat: 'aligned-binary', requiredAlignment: 1, byteLength: payload.length }, payload },
    ...catalogs.map((rows) => ({ portId: 'catalogs', typeRef: { schemaName: 'CAT.fbs', fileIdentifier: '$CAT', rootTypeName: 'CAT' }, payload: new Uint8Array(Buffer.concat(rows)) })),
  ] };
}
async function harness(t) {
  const host = await createBrowserModuleHarness({ wasmSource: wasm, manifest, surface: 'direct' });
  t.after(() => host.destroy()); return host;
}
async function compose(host, config, catalogs) {
  const result = await host.invoke(request(config, catalogs));
  assert.equal(result.statusCode, 0, result.errorMessage);
  return { report: JSON.parse(decoder.decode(result.outputs.find(f => f.portId === 'report').payload)), catalog: result.outputs.find(f => f.portId === 'catalog')?.payload ?? new Uint8Array() };
}

test('the complete SDK bundle is compliant', async () => {
  const result = await validateArtifactWithStandards({ wasmPath: fileURLToPath(new URL('../dist/isomorphic/module.wasm', import.meta.url)), manifest, standardsRoot: process.env.SPACE_DATA_STANDARDS_ROOT });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
});
test('combines exact identities in layer order, preserves bytes, and supports an explicit override', async (t) => {
  const host = await harness(t), first = cat(1, 'First'), second = cat(1, 'Second'), third = cat(2, 'Third');
  const config = recipe([layer('a'), layer('b')]);
  let result = await compose(host, config, [[first], [second, third]]);
  assert.equal(result.report.objectCount, 2);
  assert.deepEqual(result.catalog, new Uint8Array(Buffer.concat([first, third])));
  assert.deepEqual(result.report.objects[0].candidates.map(c => c.layer), ['a', 'b']);
  config.overrides['norad:1'] = { catalogLayer: 'b' };
  result = await compose(host, config, [[first], [second, third]]);
  assert.deepEqual(result.catalog, new Uint8Array(Buffer.concat([second, third])));
});
test('does not merge objects by their names; retains namespaced native identities', async (t) => {
  const host = await harness(t), record = cat(0, 'Same name');
  const result = await compose(host, recipe([layer('gcat', ['S00001']), layer('vimpel', ['S00001'])]), [[record], [record]]);
  assert.equal(result.report.objectCount, 2);
  assert.notEqual(result.report.objects[0].key, result.report.objects[1].key);
  assert.deepEqual(result.report.objects.map(r => r.candidates[0].nativeKey), ['S00001', 'S00001']);
});
test('uses a unique international designator to join a record without a NORAD ID', async (t) => {
  const host = await harness(t), first = cat(1, 'Numbered', '2020-001A');
  const result = await compose(host, recipe([layer('a'), layer('b')]), [[first], [cat(0, 'Native', '2020-001A')]]);
  assert.equal(result.report.objectCount, 1);
  assert.deepEqual(result.catalog, first);
});
test('excludes conflicting identifiers until the user selects the source', async (t) => {
  const host = await harness(t), first = cat(1, 'First', '2020-001A'), other = cat(1, 'Other', '2021-001A');
  const config = recipe([layer('a'), layer('b')]);
  let result = await compose(host, config, [[first], [other]]);
  assert.equal(result.catalog.length, 0);
  assert.equal(result.report.objects[0].status, 'identity-conflict');
  config.overrides['norad:1'] = { catalogLayer: 'b' };
  result = await compose(host, config, [[first], [other]]);
  assert.deepEqual(result.catalog, other);
});
test('selects state sources in order with freshness, fallback and per-object overrides', async (t) => {
  const host = await harness(t), config = recipe([layer('a')]);
  config.stateCandidates = [
    { objectKey: 'norad:1', sourceId: 'preferred', recordId: 'old', epoch: 500 },
    { objectKey: 'norad:1', sourceId: 'fallback', recordId: 'fresh', epoch: 990 },
    { objectKey: 'norad:2', sourceId: 'preferred', recordId: 'future', epoch: 1100 },
  ];
  config.overrides['norad:1'] = { stateSources: ['preferred', 'fallback'], maxAgeSeconds: 600 };
  let result = await compose(host, config, [[cat(1), cat(2), cat(3)]]);
  assert.equal(result.report.objects[0].state.recordId, 'old');
  assert.equal(result.report.objects[1].state.status, 'future');
  assert.equal(result.report.objects[2].state.status, 'missing');
  delete config.overrides['norad:1'];
  result = await compose(host, config, [[cat(1)]]);
  assert.equal(result.report.objects[0].state.recordId, 'fresh');
});
test('rejects malformed, ambiguous and mismatched inputs without poisoning the instance', async (t) => {
  const host = await harness(t), valid = recipe([layer('a')]);
  const cases = [
    request(valid, [[cat(1), cat(1)]]),
    request(valid, [[cat(1, 'Numbered', '2020-001A'), cat(0, 'Unnumbered', '2020-001A')]]),
    request(valid, [[cat(0)]]),
    request(valid, [[cat(1).slice(0, -1)]]),
    request(recipe([layer('a', ['x', 'y'])]), [[cat(1)]]),
    request({ ...valid, maxAgeSeconds: '100' }, [[cat(1)]]),
    request({ ...valid, overrides: { 'norad:1': { catalogLayer: 'missing' } } }, [[cat(1)]]),
  ];
  for (const input of cases) {
    const result = await host.invoke(input);
    assert.notEqual(result.statusCode, 0);
  }
  assert.equal((await compose(host, valid, [[cat(1)]])).report.objectCount, 1);
});

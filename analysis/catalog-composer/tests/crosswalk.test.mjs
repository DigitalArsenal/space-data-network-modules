import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDatefirst, crosswalkCandidates, MAX_CROSSWALK_BYTES } from '../app/crosswalk.js';
const encode = text => new TextEncoder().encode(text);
const parse = text => parseDatefirst(encode(text), { recordId: 'sha256:fixture-edition' });
const header = 'Nvym t_det_v Nnor t_det_n\n';
test('datefirst preserves edition, original identifiers, unknown dates, duplicates and contradictions', async () => {
  const r = await parse(header + '00012 20240101 00123 20240229\n12 20240101 123 00000000\n13 20240101 124 20240301\n13 20240101 125 20240301\n');
  assert.deepEqual(r.edges.map(e => e.status), ['proposed', 'duplicate', 'conflicting', 'conflicting']);
  assert.equal(r.edges[0].left.nativeId, '12'); assert.equal(r.edges[0].left.originalNativeId, '00012');
  assert.equal(r.edges[0].evidence.rightDetectionDate, '2024-02-29'); assert.equal(r.edges[1].evidence.rightDetectionDate, undefined);
  assert.equal(r.edges[1].duplicateOf, 2); assert.match(r.sha256, /^[a-f0-9]{64}$/);
});
test('malformed files fail atomically and impossible dates remain invalid attributed rows', async () => {
  for (const text of ['wrong\n', header, header + '0 20240101 2 20240101', header + '1 20240101 2 20240101 extra']) await assert.rejects(parse(text));
  const invalid = await parse(header + '1 20230229 2 20240101');
  assert.equal(invalid.edges[0].status, 'invalid'); assert.match(invalid.edges[0].evidence.original, /20230229/);
  assert.equal(invalid.edges[0].evidence.leftDetectionDate, undefined);
  await assert.rejects(parseDatefirst(new Uint8Array(MAX_CROSSWALK_BYTES + 1), { recordId: 'edition' }));
});
test('candidate generation uses exact provider namespaces and requires both products', async () => {
  const crosswalk = await parse(header + '1 20240101 2 20240101\n3 20240101 4 20240101');
  const p = (provider, nativeId, id) => ({ provider, nativeId, id, recordId: `edition-${id}` });
  const r = crosswalkCandidates(crosswalk, [p('vimpel', '0001', 'v1'), p('space-track', '2', 'n2')]);
  assert.equal(r.candidates[0].nativeId, '1'); assert.equal(r.candidates[0].originalNativeId, '0001');
  assert.equal(r.pairs.length, 1); assert.equal(r.unresolved[0].reason, 'missing-state-product');
  assert.equal(r.pairs[0].evidence.line, 2);
  assert.throws(() => crosswalkCandidates(crosswalk, [p('vimpel', '1', 'a'), p('vimpel', '01', 'b')]));
  assert.throws(() => crosswalkCandidates(crosswalk, [p('vimpel', '1', 'a'), p('space-track', '2', 'a')]), /unique/);
});

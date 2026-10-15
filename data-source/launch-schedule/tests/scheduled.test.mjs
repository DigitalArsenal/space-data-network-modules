import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { validateArtifactWithStandards } from 'space-data-module-sdk/compliance';
import { decodeFlowNotice, decodeHttpRequest, decodeIngestRequest } from 'space-data-module-sdk/runtime-contracts';
import { ADAPTER, CORE, harness, httpResponse, nodeConfig, producerPeerId, tick } from './harness.mjs';

// The adapter gates scheduling on node CONFIG and turns a 304 into a FlowNotice Unchanged before parsing, so the stored
// notices are neither replaced nor republished (typed contracts 1.0: TimerTick / HttpResponse / FlowNotice only).
const recorded = fs.readFileSync(new URL('./fixtures/ll2-upcoming-2026-09-28.json', import.meta.url));
const root = process.env.SPACE_DATA_STANDARDS_ROOT ?? path.dirname(createRequire(import.meta.url).resolve('spacedatastandards.org/package.json'));
const prepare = (h) => h.invoke({ methodId: 'prepare_scheduled', inputs: [tick()] });
const notice = (result) => {
  assert.deepEqual(result.outputs.map((f) => [f.portId, f.typeRef?.fileIdentifier]), [['status', 'FNTC']]);
  return decodeFlowNotice(result.outputs[0].payload);
};

test('the adapter artifact satisfies the SDK contract with typed ports only', async () => {
  const manifest = JSON.parse(fs.readFileSync(ADAPTER.manifest, 'utf8'));
  const report = await validateArtifactWithStandards({ wasmPath: ADAPTER.wasm, manifest, standardsRoot: root });
  assert.equal(report.ok, true, JSON.stringify(report.issues));
  for (const p of manifest.methods.flatMap((m) => [...m.inputPorts, ...m.outputPorts])) {
    assert.equal(p.acceptedTypeSets[0].allowedTypes.length, 1);
    assert.equal(p.acceptedTypeSets[0].allowedTypes[0].wireFormat, 'flatbuffer');
    assert.equal(p.acceptedTypeSets[0].allowedTypes[0].acceptsAnyFlatbuffer, undefined);
  }
});

test('disabled until configured; only the anonymous tier is scheduled; the enabled tick is forwarded verbatim', async (t) => {
  const h = await harness(t, { ...ADAPTER, config: {} });
  const off = await prepare(h);
  assert.equal(off.statusCode, 0, off.errorMessage);
  assert.deepEqual(notice(off), { kind: 'skipped', schema: 'LDM.fbs', providerId: 'launch-schedule', sourceName: 'upcoming', batchId: '', count: 0, reason: 'disabled', items: [], atMs: 0 });
  h.stub.config = nodeConfig();
  const sent = tick();
  const on = await h.invoke({ methodId: 'prepare_scheduled', inputs: [sent] });
  assert.equal(on.statusCode, 0, on.errorMessage);
  assert.deepEqual(on.outputs.map((f) => [f.portId, f.typeRef?.fileIdentifier]), [['tick', 'TICK']]);
  assert.deepEqual(Buffer.from(on.outputs[0].payload), Buffer.from(sent.payload));
  for (const broken of [null, nodeConfig({ launch_schedule_producer_peer_id: '' }), nodeConfig({ launch_schedule_source: { access: 'supporter' } }),
    { launch_schedule_enabled: true, launch_schedule_producer_peer_id: producerPeerId }]) {
    h.stub.config = broken;
    const refused = await prepare(h);
    assert.notEqual(refused.statusCode, 0);
    assert.equal(refused.outputs.length, 0);
  }
});

test('timer -> adapter -> plan -> http -> receipt -> parse: one IngestRequest and the records; a 304 replaces nothing', async (t) => {
  const adapter = await harness(t, { ...ADAPTER, config: nodeConfig() });
  const core = await harness(t, { ...CORE, config: nodeConfig() });
  const forwarded = (await prepare(adapter)).outputs[0];
  const planned = await core.invoke({ methodId: 'plan_launches', inputs: [{ portId: 'tick', typeRef: forwarded.typeRef, payload: forwarded.payload }] });
  assert.equal(planned.statusCode, 0, planned.errorMessage);
  const request = decodeHttpRequest(planned.outputs[0].payload);
  // 304: the registry has nothing new; the stored notices stay
  const unchanged = await adapter.invoke({ methodId: 'receipt_scheduled', inputs: [httpResponse(request.context, '', 304)] });
  assert.equal(unchanged.statusCode, 0, unchanged.errorMessage);
  assert.deepEqual(notice(unchanged), { kind: 'unchanged', schema: 'LDM.fbs', providerId: 'launch-schedule', sourceName: 'upcoming', batchId: '', count: 0, reason: 'not-modified', items: [], atMs: 0 });
  // 200: forwarded verbatim to the parser
  const answered = httpResponse(request.context, recorded);
  const receipt = await adapter.invoke({ methodId: 'receipt_scheduled', inputs: [answered] });
  assert.equal(receipt.statusCode, 0, receipt.errorMessage);
  assert.deepEqual(receipt.outputs.map((f) => [f.portId, f.typeRef?.fileIdentifier]), [['response', 'HRSP']]);
  assert.deepEqual(Buffer.from(receipt.outputs[0].payload), Buffer.from(answered.payload));
  const parsed = await core.invoke({ methodId: 'parse_launches', inputs: [{ portId: 'response', typeRef: receipt.outputs[0].typeRef, payload: receipt.outputs[0].payload }] });
  assert.equal(parsed.statusCode, 0, parsed.errorMessage);
  const meta = decodeIngestRequest(parsed.outputs.find((f) => f.portId === 'meta').payload);
  assert.deepEqual([meta.tags.sourceName, meta.tags.sourcePeer, meta.reconcile], ['upcoming', producerPeerId, 'current']);
  // disabled between fetch and receipt: refused, nothing forwarded
  adapter.stub.config = nodeConfig({ launch_schedule_enabled: false });
  const off = await adapter.invoke({ methodId: 'receipt_scheduled', inputs: [answered] });
  assert.notEqual(off.statusCode, 0);
  assert.equal(off.outputs.length, 0);
});

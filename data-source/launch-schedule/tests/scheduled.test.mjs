import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';

// The adapter reads host configuration and stamps the retrieval receipt; a
// 304 (bytes 0x30 0x01 little-endian after "$HRB") must stop the cycle before
// parsing so the stored notices are neither replaced nor republished.
const wasm = fs.readFileSync(new URL('../host-adapter/dist/isomorphic/module.wasm', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(new URL('../host-adapter/plugin-manifest.json', import.meta.url)));
const peer = '16Uiu2HAm1apfD3rAJJjgx4AC5Ms3PejRBwoqEsKpRx36uYwXuW9h';
const enabled = { launch_schedule_enabled: true, launch_schedule_producer_peer_id: peer, launch_schedule_source: { access: 'anonymous', limit: 100 } };
const frame = (portId, value) => {
  const payload = value instanceof Uint8Array ? value : Buffer.from(JSON.stringify(value));
  return { portId, payload, typeRef: { wireFormat: 'aligned-binary', requiredAlignment: 1, byteLength: payload.length } };
};
const http = (status, body = '') => { const h = Buffer.alloc(8); h.write('$HRB'); h.writeInt32LE(status, 4); return Buffer.concat([h, Buffer.from(body)]); };
const ports = (r) => r.outputs.map((f) => f.portId).sort();
async function host(t, configuration) {
  const h = await createBrowserModuleHarness({ wasmSource: wasm, manifest, surface: 'direct', hostcallDispatch: (op) => { assert.equal(op, 'plugin.getConfig'); return configuration; } });
  t.after(() => h.destroy());
  return h;
}

test('disabled until configured; only the anonymous tier is scheduled', async (t) => {
  const off = await (await host(t, {})).invoke({ methodId: 'prepare_scheduled', inputs: [frame('tick', {})] });
  assert.equal(off.statusCode, 0, off.errorMessage);
  assert.deepEqual(ports(off), ['status']);
  const on = await (await host(t, enabled)).invoke({ methodId: 'prepare_scheduled', inputs: [frame('tick', {})] });
  assert.equal(on.statusCode, 0, on.errorMessage);
  assert.deepEqual(JSON.parse(Buffer.from(on.outputs[0].payload)), enabled.launch_schedule_source);
  const keyed = await (await host(t, { ...enabled, launch_schedule_source: { access: 'supporter' } })).invoke({ methodId: 'prepare_scheduled', inputs: [frame('tick', {})] });
  assert.notEqual(keyed.statusCode, 0);
});

test('a 304 ends the cycle; a 200 is stamped with time and producer', async (t) => {
  const h = await host(t, enabled);
  const unchanged = await h.invoke({ methodId: 'receipt_scheduled', inputs: [frame('job', { limit: 100 }), frame('response', http(304))] });
  assert.deepEqual(ports(unchanged), ['status']);
  const before = Date.now();
  const fresh = await h.invoke({ methodId: 'receipt_scheduled', inputs: [frame('job', { limit: 100 }), frame('response', http(200, '{}'))] });
  assert.deepEqual(ports(fresh), ['job', 'receipt', 'response']);
  const receipt = JSON.parse(Buffer.from(fresh.outputs.find((f) => f.portId === 'receipt').payload));
  assert.equal(receipt.producer_peer_id, peer);
  assert.ok(receipt.retrieved_at_ms >= before && receipt.retrieved_at_ms <= Date.now());
});

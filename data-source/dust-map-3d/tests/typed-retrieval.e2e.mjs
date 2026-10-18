#!/usr/bin/env node
// THE ONE E2E for dust-map-3d on typed contracts 1.0 (modules-typed-dust-map-3d-20261018):
//   node data-source/dust-map-3d/tests/typed-retrieval.e2e.mjs
// 1. The flow composes with the host capabilities as they are on main: every
//    edge into or out of hostcap/http-request and hostcap/storage-ingest names
//    a port those modules declare, with the same type (HREQ, HRSP, INGQ, $PCE
//    on pce_records).
// 2. The whole retrieval runs offline (tests/offline-retrieval.mjs answers
//    each HttpRequest from a local copy of the published file, as
//    hostcap/http-request would): every request is a GET HttpRequest whose URL
//    and Range name the same bytes within MAX_BYTES; build_dust emits 61
//    size-prefixed $PCE rows and an IngestRequest that files them under
//    PCE.fbs, edenhofer2024 / local-dust-1250pc, RECONCILE Current, within the
//    host's tag limits; the resampling conserves the probe sightlines' native
//    extinction within 2 %.
// Needs the module built (npm run build) and .source-cache/ (BLOCKED otherwise).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {deliverDustRows, dustSource} from './offline-retrieval.mjs';
import {dustMapFlow} from '../flow.mjs';

const here = fileURLToPath(new URL('..', import.meta.url));
const repo = path.resolve(here, '../..');
const manifest = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'plugin-manifest.json'), 'utf8'));
const http = 'com.digitalarsenal.hostcap.http-request', storage = 'com.digitalarsenal.hostcap.storage-ingest';
const manifests = {
  [http]: manifest(path.join(repo, 'hostcap/http-request')),
  [storage]: manifest(path.join(repo, 'hostcap/storage-ingest')),
  'com.digitalarsenal.data-source.dust-map-3d': manifest(here),
  'com.digitalarsenal.data-source.dust-map-3d-host': manifest(path.join(here, 'host-adapter')),
};
const checks = [];
const check = (name, fn) => { fn(); checks.push(name); console.log(`ok  ${name}`); };

// ---- 1. composition ----
const node = (nodeId, pluginId, methodId, kind = 'transform') => ({nodeId, pluginId, methodId, kind});
const edge = (fromNodeId, fromPortId, toNodeId, toPortId) => ({fromNodeId, fromPortId, toNodeId, toPortId});
const {flow} = dustMapFlow({node, edge, http, storage, packageDir: here});
const nodes = new Map(flow.nodes.map((n) => [n.nodeId, n]));
const typesOf = (n, direction, portId) => {
  const method = manifests[n.pluginId]?.methods.find((m) => m.methodId === n.methodId);
  assert.ok(method, `${n.pluginId} declares no method ${n.methodId}`);
  const port = method[direction].find((p) => p.portId === portId);
  assert.ok(port, `${n.pluginId}:${n.methodId} declares no ${direction === 'inputPorts' ? 'input' : 'output'} port "${portId}"`);
  return port.acceptedTypeSets.flatMap((set) => set.allowedTypes).map((t) => t.fileIdentifier ?? '*');
};
check('every hostcap edge names a declared port of the same type', () => {
  let hostEdges = 0;
  for (const e of flow.edges) {
    const from = nodes.get(e.fromNodeId), to = nodes.get(e.toNodeId);
    if (![from.pluginId, to.pluginId].some((id) => id === http || id === storage)) continue;
    if (!manifests[to.pluginId]) continue;  // the flow's egress sink
    const out = typesOf(from, 'outputPorts', e.fromPortId), into = typesOf(to, 'inputPorts', e.toPortId);
    assert.ok(out.some((t) => into.includes(t)), `${e.fromNodeId}.${e.fromPortId} (${out}) -> ${e.toNodeId}.${e.toPortId} (${into})`);
    hostEdges += 1;
  }
  // 14 requests, 14 responses, meta and records into storage.
  assert.equal(hostEdges, 30, `hostcap edges: ${hostEdges}`);
  const into = (port) => flow.edges.find((e) => e.toNodeId === 'ingest' && e.toPortId === port);
  assert.equal(into('pce_records')?.fromPortId, 'records');
  assert.equal(into('meta')?.fromPortId, 'meta');
});

// ---- 2. the retrieval, offline ----
if (!fs.existsSync(dustSource.file)) {
  console.log(`DUST-MAP-3D TYPED RETRIEVAL E2E BLOCKED: no offline copy of ${dustSource.url} at ${dustSource.file}`);
  process.exit(2);
}
const t0 = Date.now();
const retrievedAtMs = Date.parse('2026-10-18T00:00:00Z');
const {rows, meta, report, requests, bytesServed} = await deliverDustRows({retrievedAtMs, producerPeerId: 'e2e-offline-provider',
  progress: (line) => process.stdout.write(`    ${line}\n`)});
const seconds = (Date.now() - t0) / 1000;

check('every request is a GET HttpRequest naming one range within MAX_BYTES', () => {
  assert.ok(requests.length >= 14, `${requests.length} requests`);
  for (const r of requests) {
    assert.equal(r.method, 'GET');
    const m = /&sdn-range=(\d+)-(\d+)$/.exec(r.url);
    assert.ok(m && r.url.startsWith(dustSource.url), r.url);
    assert.equal(r.headers.Range, `bytes=${m[1]}-${m[2]}`);
    assert.equal(r.maxBytes, Number(m[2]) - Number(m[1]) + 1);
    // Every range fits the node's 5-minute http.request ceiling: at most the
    // 8 MiB table range, shell ranges of 6 MiB, and a 300 s timeout.
    assert.ok(r.maxBytes <= 8 * 1024 * 1024 && r.timeoutMs === 300000, JSON.stringify(r));
  }
});
check('61 size-prefixed $PCE rows, one per z plane', () => {
  assert.equal(rows.length, 61);
  for (const row of rows) {
    assert.equal(new DataView(row.buffer, row.byteOffset, 4).getUint32(0, true) + 4, row.length);
    assert.equal(Buffer.from(row.subarray(8, 12)).toString('latin1'), '$PCE');
  }
});
check('the IngestRequest files them under PCE.fbs, edenhofer2024 / local-dust-1250pc, RECONCILE Current', () => {
  assert.equal(meta.schema, 'PCE.fbs');
  assert.equal(meta.reconcile, 2);  // reconcileMode.Current
  assert.equal(meta.tags.providerId, 'edenhofer2024');
  assert.equal(meta.tags.sourceName, 'local-dust-1250pc');
  assert.equal(meta.tags.sourcePeer, 'e2e-offline-provider');
  assert.match(meta.tags.batchId, /^[0-9a-f]{64}$/);
  assert.equal(meta.tags.sourceUrl, dustSource.url);
  assert.match(meta.tags.license, /^CC BY 4\.0/);
  assert.match(meta.tags.citation, /Edenhofer/);
  // hostcap/storage-ingest refuses a tag over the hostcall's field (HostOps StorageIngestParams).
  assert.ok(meta.tags.license.length <= 128 && meta.tags.citation.length <= 255 && meta.tags.sourceUrl.length <= 255);
  assert.equal(meta.provenance.count, 61);
  assert.equal(meta.provenance.retrievedMs, retrievedAtMs);
});
check('the resampling conserves the native extinction within 2 %', () => {
  assert.equal(report.rows, 61);
  assert.ok(report.covered_voxels > 0);
  assert.ok(Math.abs(report.probe_aggregate_grid_over_native - 1) <= 0.02, `aggregate ${report.probe_aggregate_grid_over_native}`);
});
console.log(`DUST-MAP-3D TYPED RETRIEVAL E2E PASS (${checks.length} checks; ${requests.length} HttpRequests, ${(bytesServed / 1e9).toFixed(2)} GB served offline, ` +
  `61 rows, batch ${meta.tags.batchId.slice(0, 12)}…, aggregate ${report.probe_aggregate_grid_over_native.toFixed(4)}, ${seconds.toFixed(0)} s)`);

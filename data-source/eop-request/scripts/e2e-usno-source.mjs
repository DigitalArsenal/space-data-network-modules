// Real USNO request -> host HTTP -> the flow's unchanged finals parser -> archive comparison.
// JS only routes bytes, decodes SDS records, and computes comparison statistics.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';

const modules = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(path.join(modules, 'data-source/operator-states-public/package.json'));
const sdk = async subpath => import(pathToFileURL(require.resolve(`space-data-module-sdk/${subpath}`)));
const {createBrowserModuleHarness} = await sdk('host/browser-module');
const {encodeTimerTick, decodeHttpRequest, encodeHttpResponse, decodeIngestRequest} = await sdk('runtime-contracts');
const {ByteBuffer} = require('flatbuffers');
const {EOP} = await import(pathToFileURL(require.resolve('spacedatastandards.org/lib/js/EOP/main.js')));
const {ICN} = await import(pathToFileURL(require.resolve('spacedatastandards.org/lib/js/ICN/main.js')));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const frame = (portId, payload, schemaName, fileIdentifier, rootTypeName) => ({
  portId, payload, typeRef: {schemaName, fileIdentifier, rootTypeName, wireFormat: 'flatbuffer'},
});
const flow = path.join(modules, 'flows/open-dca/dist');
const wasm = kind => path.join(flow, `transport/eop-${kind}/dist/isomorphic/module.wasm`);
const archiveRoot = process.env.EOP_ARCHIVE_ROOT || '/opt/data/sdn-archive/hac/iers-eop';
const latest = JSON.parse(await fs.readFile(path.join(archiveRoot, 'latest.json'), 'utf8'));
const archived = latest.files['finals.all.iau2000.txt'];
const archivePath = path.resolve(path.dirname(archiveRoot), archived.path);
assert(archivePath.startsWith(path.resolve(archiveRoot) + path.sep), 'Archive path must stay inside its root');
const archiveBody = await fs.readFile(archivePath);
assert.equal(sha256(archiveBody), archived.sha256, 'Archive must match its recorded digest');
const receipt = {status: 'RUNNING', started: new Date().toISOString(), archivePath,
  archiveSha256: archived.sha256, docker: 'WAIVED: owner 2026-10-22',
  flowSha256: sha256(await fs.readFile(path.join(flow, 'runtime/runtime.wasm')))};
let requestHarness, parserHarness;
try {
  requestHarness = await createBrowserModuleHarness({wasmSource: await fs.readFile(wasm('request')), surface: 'direct'});
  parserHarness = await createBrowserModuleHarness({wasmSource: await fs.readFile(wasm('parser')), surface: 'direct'});
  const tick = frame('tick', encodeTimerTick({triggerId: 'daily', firedMs: Date.now()}), 'TimerTick.fbs', 'TICK', 'TimerTick');
  const requested = await requestHarness.invoke({methodId: 'finals2000a', inputs: [tick]});
  assert.equal(requested.statusCode, 0, requested.errorMessage);
  assert.equal(requested.outputs.length, 1);
  const q = decodeHttpRequest(requested.outputs[0].payload);
  assert.equal(q.url, 'https://maia.usno.navy.mil/ser7/finals2000A.all');
  assert.equal(q.method, 'GET');
  assert.equal(Number(q.timeoutMs), 90000);
  assert.equal(Number(q.maxBytes), 16777216);
  const job = ICN.getSizePrefixedRootAsICN(new ByteBuffer(q.context)).unpack();
  assert.equal(job.ENDPOINT_URL, q.url);
  assert.equal(job.DATASET_ID, 'finals2000a');
  assert.match(job.SOURCE_NAME, /USNO/);
  const response = await fetch(q.url, {method: q.method, headers: q.headers, signal: AbortSignal.timeout(Number(q.timeoutMs))});
  assert.equal(response.status, 200, `USNO HTTP ${response.status}`);
  const liveBody = Buffer.from(await response.arrayBuffer());
  assert(liveBody.length > 0 && liveBody.length <= Number(q.maxBytes));
  receipt.source = {url: q.url, status: response.status, bytes: liveBody.length,
    sha256: sha256(liveBody), lastModified: response.headers.get('last-modified')};
  async function parse(body, headers = {}) {
    const result = await parserHarness.invoke({methodId: 'parse_finals2000a', inputs: [frame('response',
      encodeHttpResponse({url: q.url, status: 200, body, context: q.context, headers}),
      'HttpResponse.fbs', 'HRSP', 'HttpResponse')]});
    assert.equal(result.statusCode, 0, result.errorMessage);
    const meta = decodeIngestRequest(result.outputs.find(o => o.portId === 'meta').payload);
    assert.equal(meta.provenance.sourceSha256, sha256(body));
    assert.equal(meta.provenance.sourceUrl, q.url);
    const stream = Buffer.from(result.outputs.find(o => o.portId === 'records').payload);
    const rows = new Map();
    for (let at = 0; at < stream.length;) {
      const length = stream.readUInt32LE(at);
      assert(length > 0 && at + 4 + length <= stream.length);
      const row = EOP.getRootAsEOP(new ByteBuffer(stream.subarray(at + 4, at + 4 + length))).unpack();
      assert(!rows.has(row.DATE), `Duplicate date ${row.DATE}`);
      // These identify the entire source edition, not the row's Earth orientation values.
      delete row.DATA_SET_CID;
      delete row.DATA_SET_EPOCH;
      rows.set(row.DATE, row);
      at += length + 4;
    }
    assert.equal(rows.size, Number(meta.provenance.normalizedCount));
    return rows;
  }
  const live = await parse(liveBody, Object.fromEntries(response.headers));
  const archive = await parse(archiveBody);
  const dates = [...live.keys()].sort();
  const today = Date.parse(new Date().toISOString().slice(0, 10));
  for (let day = -32; day <= 2; day++) {
    const date = new Date(today + day * 86400000).toISOString().replace('.000Z', 'Z');
    assert(live.has(date), `DCA window missing ${date}`);
  }
  receipt.coverage = {first: dates[0], last: dates.at(-1), daysChecked: 35, c04Required: false};
  let compared = 0, differentRows = 0, maxDifference = 0;
  const maxDifferenceByField = {}, firstDifferences = [];
  for (const [date, expected] of archive) {
    const actual = live.get(date);
    if (!actual) continue;
    compared++;
    let different = false;
    for (const field of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
      if (Object.is(expected[field], actual[field])) continue;
      different = true;
      if (typeof expected[field] === 'number' && typeof actual[field] === 'number') {
        const delta = Math.abs(expected[field] - actual[field]);
        maxDifferenceByField[field] = Math.max(maxDifferenceByField[field] || 0, delta);
        maxDifference = Math.max(maxDifference, delta);
      }
      if (firstDifferences.length < 5) firstDifferences.push({date, field, archive: expected[field], live: actual[field]});
    }
    if (different) differentRows++;
  }
  receipt.comparison = {liveRows: live.size, archiveRows: archive.size, compared, differentRows,
    maxDifference, maxDifferenceByField, firstDifferences};
  assert(compared > 19000, `Unexpectedly little archive overlap: ${compared}`);
  assert.equal(differentRows, 0, 'Every overlapping archive row must match; a different source edition is not equality');
  receipt.status = 'PASS';
} catch (error) {
  receipt.status = 'FAIL';
  receipt.error = error.message;
  process.exitCode = 1;
} finally {
  await requestHarness?.destroy();
  await parserHarness?.destroy();
  receipt.completed = new Date().toISOString();
  console.log(JSON.stringify(receipt, null, 2));
}

// Live USNO finals2000A -> the open-DCA flow's own eop-request and eop-parser modules -> the archived IERS copy.
// JS only routes bytes, decodes SDS records and computes comparison statistics; the request and the parse run in WASM.
//   node data-source/eop-request/scripts/e2e-usno-source.mjs
// Env: EOP_ARCHIVE_ROOT (default /opt/data/sdn-archive/hac/iers-eop); SDN_PREWARM_AOT_BIN (the node binary built from
// sdn origin/main; when set, the rebuilt flow bundle is also AOT-compiled by its prewarm-aot, WasmEdge 0.16.4).
import assert from 'node:assert/strict';
import dns from 'node:dns';
import fs from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';

const modules = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(path.join(modules, 'data-source/operator-states-public/package.json'));
const sdk = subpath => import(pathToFileURL(require.resolve(`space-data-module-sdk/${subpath}`)));
const standard = code => import(pathToFileURL(require.resolve(`spacedatastandards.org/lib/js/${code}/main.js`)));
const {createBrowserModuleHarness} = await sdk('host/browser-module');
const {encodeTimerTick, decodeHttpRequest, encodeHttpResponse, decodeIngestRequest} = await sdk('runtime-contracts');
const {ByteBuffer} = require('flatbuffers');
const {EOP, DataType} = await standard('EOP');
const {ICN} = await standard('ICN');

const USNO_URL = 'https://maia.usno.navy.mil/ser7/finals2000A.all';
const IERS_URL = 'https://datacenter.iers.org/data/9/finals2000A.all';
const REVISION_WINDOW_DAYS = 400;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const frame = (portId, payload, schemaName, fileIdentifier, rootTypeName) => ({
  portId, payload, typeRef: {schemaName, fileIdentifier, rootTypeName, wireFormat: 'flatbuffer'},
});
const flow = path.join(modules, 'flows/open-dca/dist');
const transport = kind => path.join(flow, `transport/eop-${kind}`);
const load = async kind => createBrowserModuleHarness({
  wasmSource: await fs.readFile(path.join(transport(kind), 'dist/isomorphic/module.wasm')),
  manifest: JSON.parse(await fs.readFile(path.join(modules, `data-source/eop-${kind}/plugin-manifest.json`), 'utf8')),
  surface: 'direct',
});

// The node's http-request capability stand-in: one GET honouring the request's TIMEOUT_MS and MAX_BYTES. When this
// machine's resolver cannot answer (it SERVFAILs the .mil zone at times), the same name is resolved through public
// resolvers; the connection still validates the certificate for the hostname.
const publicResolver = new dns.promises.Resolver();
publicResolver.setServers(['1.1.1.1', '8.8.8.8']);
function lookup(hostname, options, callback) {
  dns.lookup(hostname, options, (error, ...found) => {
    if (!error) return callback(null, ...found);
    publicResolver.resolve4(hostname).then(
      addresses => options.all ? callback(null, addresses.map(address => ({address, family: 4}))) : callback(null, addresses[0], 4),
      () => callback(error));
  });
}
const get = (url, headers, timeoutMs, maxBytes) => new Promise((resolve, reject) => {
  const request = https.get(url, {headers, lookup, timeout: timeoutMs}, response => {
    const chunks = [];
    let size = 0;
    response.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) request.destroy(new Error(`Response exceeds MAX_BYTES ${maxBytes}`));
      else chunks.push(chunk);
    });
    response.on('end', () => resolve({status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks)}));
    response.on('error', reject);
  });
  request.on('timeout', () => request.destroy(new Error(`No response within ${timeoutMs} ms`)));
  request.on('error', reject);
});

const archiveRoot = process.env.EOP_ARCHIVE_ROOT || '/opt/data/sdn-archive/hac/iers-eop';
const latest = JSON.parse(await fs.readFile(path.join(archiveRoot, 'latest.json'), 'utf8'));
const archived = latest.files['finals.all.iau2000.txt'];
const archivePath = path.resolve(path.dirname(archiveRoot), archived.path);
assert(archivePath.startsWith(path.resolve(archiveRoot) + path.sep), 'Archive path must stay inside its root');
const archiveBody = await fs.readFile(archivePath);
assert.equal(sha256(archiveBody), archived.sha256, 'Archive must match its recorded digest');
const runtimeBytes = await fs.readFile(path.join(flow, 'runtime/runtime.wasm'));
const receipt = {status: 'RUNNING', started: new Date().toISOString(), docker: 'WAIVED: owner 2026-10-22',
  flow: {runtimeSha256: sha256(runtimeBytes), requestSha256: sha256(await fs.readFile(path.join(transport('request'), 'dist/isomorphic/module.wasm'))),
    parserSha256: sha256(await fs.readFile(path.join(transport('parser'), 'dist/isomorphic/module.wasm')))},
  archive: {path: archivePath, sha256: archived.sha256}};
let requestHarness, parserHarness;
try {
  // The shipped flow carries the USNO source and no longer the IERS datacenter finals2000A URL.
  assert(runtimeBytes.includes(USNO_URL), 'runtime.wasm must carry the USNO finals2000A URL');
  assert(!runtimeBytes.includes(IERS_URL), 'runtime.wasm must not carry the IERS datacenter finals2000A URL');
  requestHarness = await load('request');
  parserHarness = await load('parser');
  const tick = frame('tick', encodeTimerTick({triggerId: 'daily', firedMs: Date.now()}), 'TimerTick.fbs', 'TICK', 'TimerTick');
  const requested = await requestHarness.invoke({methodId: 'finals2000a', inputs: [tick]});
  assert.equal(requested.statusCode, 0, requested.errorMessage);
  assert.equal(requested.outputs.length, 1);
  const q = decodeHttpRequest(requested.outputs[0].payload);
  assert.equal(q.url, USNO_URL);
  assert.equal(q.method, 'GET');
  assert.equal(Number(q.timeoutMs), 90000);
  assert.equal(Number(q.maxBytes), 16777216);
  const job = ICN.getSizePrefixedRootAsICN(new ByteBuffer(q.context)).unpack();
  assert.equal(job.ENDPOINT_URL, USNO_URL);
  assert.equal(job.DATASET_ID, 'finals2000a');
  assert.match(job.SOURCE_NAME, /USNO/);

  const response = await get(q.url, q.headers, Number(q.timeoutMs), Number(q.maxBytes));
  assert.equal(response.status, 200, `USNO HTTP ${response.status}`);
  const liveBody = response.body;
  assert(liveBody.length > 3_000_000, `USNO finals2000A is ${liveBody.length} bytes`);
  receipt.source = {url: q.url, status: response.status, bytes: liveBody.length, sha256: sha256(liveBody),
    lastModified: response.headers['last-modified'] || null};

  async function parse(body, headers) {
    const result = await parserHarness.invoke({methodId: 'parse_finals2000a', inputs: [frame('response',
      encodeHttpResponse({url: q.url, status: 200, body, context: q.context, headers, retrievedMs: Date.now()}),
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
      // These identify the whole source edition (its digest and retrieval time), not the row's Earth orientation.
      delete row.DATA_SET_CID;
      delete row.DATA_SET_EPOCH;
      rows.set(row.DATE, row);
      at += length + 4;
    }
    assert.equal(rows.size, Number(meta.provenance.normalizedCount));
    return rows;
  }
  const live = await parse(liveBody, Object.fromEntries(Object.entries(response.headers).filter(([, value]) => typeof value === 'string')));
  const archive = await parse(archiveBody, {});
  const liveDates = [...live.keys()].sort();

  // The DCA window: the last 32 days plus the 48-hour forecast must all be present in the live file.
  const today = Date.parse(new Date().toISOString().slice(0, 10));
  const day = offset => new Date(today + offset * 86400000).toISOString().replace('.000Z', 'Z');
  for (let offset = -32; offset <= 2; offset++) assert(live.has(day(offset)), `DCA window misses ${day(offset)}`);
  receipt.coverage = {first: liveDates[0], last: liveDates.at(-1), dcaWindow: `${day(-32)} .. ${day(2)}`, c04Required: false};

  // Same product, different edition. The Rapid Service re-issues about a trailing year of its Bulletin A series with
  // every weekly bulletin (the archive is one week older than the live file), so only older rows are frozen: those must
  // equal the USNO row field for field. The trailing year is compared too, and reported with the size of its revision.
  const archiveDates = [...archive.keys()].sort();
  const lastObserved = archiveDates.filter(date => archive.get(date).DATA_TYPE === DataType.OBSERVED).at(-1);
  const frozenThrough = new Date(Date.parse(lastObserved) - REVISION_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
  const frozen = {rows: 0, differentRows: 0, maxDifference: 0};
  const trailing = {rows: 0, missingRows: 0, differentRows: 0, flagChanged: 0, firstDifferent: null, maxDifferenceByField: {}};
  const firstDifferences = [];
  for (const date of archiveDates) {
    const expected = archive.get(date), actual = live.get(date);
    const section = date.slice(0, 10) <= frozenThrough ? frozen : trailing;
    section.rows++;
    if (!actual) { if (section === trailing) trailing.missingRows++; else frozen.differentRows++; continue; }
    let different = false;
    for (const field of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
      if (Object.is(expected[field], actual[field])) continue;
      different = true;
      if (field === 'DATA_TYPE') { trailing.flagChanged++; continue; }
      const delta = typeof expected[field] === 'number' && typeof actual[field] === 'number' ? Math.abs(expected[field] - actual[field]) : Infinity;
      if (section === frozen) {
        frozen.maxDifference = Math.max(frozen.maxDifference, delta);
        if (firstDifferences.length < 5) firstDifferences.push({date, field, archive: expected[field], live: actual[field]});
      } else trailing.maxDifferenceByField[field] = Math.max(trailing.maxDifferenceByField[field] || 0, delta);
    }
    if (different) {
      section.differentRows++;
      if (section === trailing) trailing.firstDifferent ??= date;
    }
  }
  const largest = name => trailing.maxDifferenceByField[name] || 0;
  const MAS_PER_RADIAN = 206264806.247;
  receipt.comparison = {liveRows: live.size, archiveRows: archive.size, archiveLastObserved: lastObserved, frozenThrough, frozen, trailing,
    trailingMaxChange: {polarMotionXMas: largest('X_POLE_WANDER_RADIANS') * MAS_PER_RADIAN,
      polarMotionYMas: largest('Y_POLE_WANDER_RADIANS') * MAS_PER_RADIAN, ut1MinusUtcMs: largest('UT1_MINUS_UTC_SECONDS') * 1000},
    firstDifferences};
  assert(frozen.rows > 16000, `Unexpectedly little frozen archive history: ${frozen.rows} rows`);
  assert.equal(frozen.differentRows, 0, 'Every archived row older than the revision window must equal the USNO row');
  assert.equal(frozen.maxDifference, 0);
  assert.equal(trailing.missingRows, 0, 'Every archived day must still be present in the USNO file');

  const aotBin = process.env.SDN_PREWARM_AOT_BIN;
  if (aotBin) {
    const prewarm = spawnSync(aotBin, ['prewarm-aot', '--flow', path.join(flow, 'runtime')], {encoding: 'utf8', timeout: 1_800_000});
    const lines = `${prewarm.stdout}${prewarm.stderr}`.split('\n').filter(line => /flow|FAILED|aot|AOT/i.test(line));
    receipt.aot = {bin: aotBin, status: prewarm.status, lines};
    assert.equal(prewarm.status, 0, `prewarm-aot exited ${prewarm.status}: ${lines.join(' | ')}`);
    assert(!lines.some(line => /FAILED/.test(line)), 'prewarm-aot reported a failure');
  } else {
    receipt.aot = 'SKIPPED: SDN_PREWARM_AOT_BIN is not set';
  }
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

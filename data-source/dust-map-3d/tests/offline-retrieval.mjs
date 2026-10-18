// The provider node's side of a dust-map-3d retrieval, offline and IO only:
// run plan_dust, advance_dust x13 and build_dust exactly as the flow does,
// answering each HttpRequest (HREQ) with the HttpResponse (HRSP)
// hostcap/http-request would return, from an offline copy of the published
// Zenodo file instead of the network. Returns the $PCE rows the node would
// store and publish, and the IngestRequest (INGQ) meta it would store them
// under. No dust physics here: every number is the module's.
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import * as flatbuffers from 'flatbuffers';
import {createBrowserModuleHarness} from 'space-data-module-sdk/host/browser-module';

const moduleDir = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(path.join(moduleDir, 'package.json'));
// The SDK's runtime types (typed contracts 1.0), as its generated JavaScript.
const sdkRoot = path.dirname(path.dirname(require.resolve('space-data-module-sdk')));
const runtime = (name) => import(pathToFileURL(path.join(sdkRoot, `src/generated/runtime/sdn/runtime/${name}.js`)).href);
const [{HttpRequest}, {HttpResponse}, {Header}, {IngestRequest}] =
  await Promise.all(['HttpRequest', 'HttpResponse', 'Header', 'IngestRequest'].map(runtime));

export const dustSource = {
  file: path.join(moduleDir, '.source-cache/mean_and_std_healpix.fits'),
  url: 'https://zenodo.org/records/10658339/files/mean_and_std_healpix.fits?download=1',
  bytes: 3252715200,
  // Ranges the stages read (whole bytes of the published v1.0.2 file).
  ranges: [[0, 1623225599], [3246402240, 3252715199]],
};

/** One HREQ frame as hostcap/http-request reads it: URL, Range, MAX_BYTES. */
export function readRequest(bytes) {
  const request = HttpRequest.getRootAsHttpRequest(new flatbuffers.ByteBuffer(bytes));
  if (!HttpRequest.bufferHasIdentifier(new flatbuffers.ByteBuffer(bytes))) throw new Error('a request frame is not an HttpRequest (HREQ)');
  const headers = {};
  for (let i = 0; i < request.headersLength(); i++) headers[request.HEADERS(i).NAME()] = request.HEADERS(i).VALUE();
  return {method: request.METHOD(), url: request.URL(), headers, timeoutMs: request.TIMEOUT_MS(), maxBytes: Number(request.MAX_BYTES())};
}

/** The HRSP hostcap/http-request would answer `request` with, from the offline file. */
function respond(fd, request) {
  const [first, last] = request.headers.Range.slice(6).split('-').map(Number);
  const end = Math.min(last, dustSource.bytes - 1);
  const ok = first <= end && end - first + 1 <= request.maxBytes;
  const body = Buffer.alloc(ok ? end - first + 1 : 0);
  if (ok) fs.readSync(fd, body, 0, body.length, first);
  const b = new flatbuffers.Builder(body.length + 1024);
  const url = b.createString(request.url);
  const bodyOffset = HttpResponse.createBodyVector(b, body);
  const range = Header.createHeader(b, b.createString('Content-Range'), b.createString(`bytes ${first}-${end}/${dustSource.bytes}`));
  const headers = HttpResponse.createHeadersVector(b, [range]);
  HttpResponse.startHttpResponse(b);
  HttpResponse.addUrl(b, url);
  HttpResponse.addStatus(b, ok ? 206 : 416);
  HttpResponse.addHeaders(b, headers);
  HttpResponse.addBody(b, bodyOffset);
  b.finish(HttpResponse.endHttpResponse(b), 'HRSP');
  return {frame: b.asUint8Array(), served: body.length};
}

const control = (portId, payload) => ({portId, payload,
  typeRef: {wireFormat: 'aligned-binary', requiredAlignment: 1, byteLength: payload.length}});
const typed = (portId, schemaName, fileIdentifier, rootTypeName, payload) => ({portId, payload,
  typeRef: {schemaName, fileIdentifier, rootTypeName, wireFormat: 'flatbuffer'}});

/** The INGQ meta as hostcap/storage-ingest reads it. */
export function readIngestRequest(bytes) {
  const bb = new flatbuffers.ByteBuffer(bytes);
  if (!IngestRequest.bufferHasIdentifier(bb)) throw new Error('the meta frame is not an IngestRequest (INGQ)');
  const r = IngestRequest.getRootAsIngestRequest(bb);
  const t = r.TAGS();
  const p = r.PROVENANCE();
  return {schema: r.SCHEMA(), reconcile: r.RECONCILE(),
    tags: {providerId: t.PROVIDER_ID(), sourceName: t.SOURCE_NAME(), batchId: t.BATCH_ID(), sourceUrl: t.SOURCE_URL(),
      sourcePeer: t.SOURCE_PEER(), license: t.LICENSE(), licenseUrl: t.LICENSE_URL(), citation: t.CITATION()},
    provenance: p && {parser: p.PARSER(), parserVersion: p.PARSER_VERSION(), count: Number(p.NORMALIZED_COUNT()), retrievedMs: Number(p.RETRIEVED_MS())}};
}

export async function deliverDustRows({retrievedAtMs, producerPeerId = 'e2e-offline-provider', progress = () => {}}) {
  if (!fs.existsSync(dustSource.file)) {
    const error = new Error(`BLOCKED: no offline copy of ${dustSource.url} at ${dustSource.file}`);
    error.blocked = true;
    throw error;
  }
  const wasm = fs.readFileSync(path.join(moduleDir, 'dist/isomorphic/module.wasm'));
  const manifest = JSON.parse(fs.readFileSync(path.join(moduleDir, 'plugin-manifest.json'), 'utf8'));
  const harness = await createBrowserModuleHarness({wasmSource: wasm, manifest, surface: 'direct'});
  const fd = fs.openSync(dustSource.file, 'r');
  let bytesServed = 0;
  const requests = [];
  try {
    const call = async (methodId, inputs) => {
      const response = await harness.invoke({methodId, inputs});
      if (response.statusCode !== 0) throw new Error(`dust-map-3d ${methodId}: ${response.errorCode}: ${response.errorMessage}`);
      return response.outputs;
    };
    const pick = (outputs, port) => outputs.filter(f => f.portId === port).map(f => new Uint8Array(f.payload));
    let outputs = await call('plan_dust', [control('config', Buffer.from(JSON.stringify({access: 'anonymous'})))]);
    for (let stage = 1; ; ++stage) {
      const asked = pick(outputs, 'request').map(readRequest);
      requests.push(...asked);
      const answers = asked.map(r => respond(fd, r));
      bytesServed += answers.reduce((n, a) => n + a.served, 0);
      const inputs = [control('state', pick(outputs, 'state')[0]),
        ...answers.map(a => typed('response', 'HttpResponse.fbs', 'HRSP', 'HttpResponse', a.frame))];
      progress(`dust-map-3d stage ${stage}: ${asked.length} ranges`);
      if (stage === 14) {
        inputs.push(control('receipt', Buffer.from(JSON.stringify({retrieved_at_ms: retrievedAtMs, producer_peer_id: producerPeerId}))));
        outputs = await call('build_dust', inputs);
        break;
      }
      outputs = await call('advance_dust', inputs);
    }
    const stream = Buffer.from(pick(outputs, 'records')[0]);
    const rows = [];
    for (let at = 0; at < stream.length;) {
      const size = stream.readUInt32LE(at);
      rows.push(new Uint8Array(stream.subarray(at, at + 4 + size)));  // each row as stored: size-prefixed
      at += 4 + size;
    }
    return {rows, stream: new Uint8Array(stream), meta: readIngestRequest(pick(outputs, 'meta')[0]),
      report: JSON.parse(Buffer.from(pick(outputs, 'report')[0]).toString()), bytesServed, requests};
  } finally {
    fs.closeSync(fd);
    await harness.destroy();
  }
}

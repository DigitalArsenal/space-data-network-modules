// Shared harness for the cell-tower-ingest tests on the typed contracts (1.0): the compiled wasm in the SDK browser
// harness, every frame a FlatBuffer, the SDS records built and read with the generated spacedatastandards.org
// bindings (lib/ts via esbuild, as foundation/http-respond's tests do), the runtime types with
// space-data-module-sdk/runtime-contracts, and plugin.getConfig answered by the SDK host (hostOptions.config) exactly as
// the Go node answers it: one ModuleConfig on raw "config". Each hostcall is recorded at the import.

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { encodeHttpRequest as encodeHtq } from "space-data-module-sdk/http";
import { decodeHostCall } from "space-data-module-sdk/runtime-contracts";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

export const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
export const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
export const STANDARDS_ROOT =
  process.env.SPACE_DATA_STANDARDS_ROOT ?? fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));

async function loadStandard(code) {
  const esbuild = await import(pathToFileURL(path.join(STANDARDS_ROOT, "node_modules", "esbuild", "lib", "main.js")).href);
  const flatbuffersEntry = fs.realpathSync(path.join(STANDARDS_ROOT, "node_modules", "flatbuffers", "mjs", "flatbuffers.js"));
  const out = await esbuild.build({ entryPoints: [path.join(STANDARDS_ROOT, "lib", "ts", code, "main.ts")], bundle: true, format: "esm", write: false, platform: "neutral", alias: { flatbuffers: flatbuffersEntry }, logLevel: "silent" });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
}
export const flatbuffers = await import(pathToFileURL(fs.realpathSync(path.join(STANDARDS_ROOT, "node_modules", "flatbuffers", "mjs", "flatbuffers.js"))).href);
export const sds = Object.fromEntries(await Promise.all(["APR", "DAV", "QRP", "IRM", "FSO", "FSB", "TBS"].map(async (c) => [c, await loadStandard(c)])));

// Build an SDS record through its generated object API.
export function build(code, object, { sizePrefixed = false } = {}) {
  const b = new flatbuffers.Builder(256);
  const offset = object.pack(b);
  if (sizePrefixed) b.finishSizePrefixed(offset, `$${code}`);
  else b.finish(offset, `$${code}`);
  return b.asUint8Array().slice();
}
export function read(code, bytes) {
  const bb = new flatbuffers.ByteBuffer(Uint8Array.from(bytes));
  assert.ok(sds[code][code].bufferHasIdentifier(bb), `a $${code} buffer`);
  return sds[code][code][`getRootAs${code}`](bb).unpack();
}
export const text = (v) => (v == null ? "" : typeof v === "string" ? v : Buffer.from(v).toString("utf8"));

// A size-prefixed stream's frames (zero-length prefixes are padding).
export function framesOf(bytes) {
  const b = Buffer.from(bytes);
  const out = [];
  for (let at = 0; at + 4 <= b.length;) {
    const n = b.readUInt32LE(at);
    at += 4;
    if (n === 0) continue;
    assert.ok(at + n <= b.length, "a frame runs past the stream");
    out.push(Uint8Array.from(b.subarray(at, at + n)));
    at += n;
  }
  return out;
}
export const stream = (buffers) => Buffer.concat(buffers.flatMap((x) => { const p = Buffer.alloc(4); p.writeUInt32LE(x.length); return [p, Buffer.from(x)]; }));

export const typeRef = (schemaName, fileIdentifier, rootTypeName) => ({ schemaName, fileIdentifier, rootTypeName, wireFormat: "flatbuffer" });
export const TYPE = {
  HTQ: typeRef("HttpRequestAbi.fbs", "$HTQ", "HttpRequest"),
  TICK: typeRef("TimerTick.fbs", "TICK", "TimerTick"),
  HRSP: typeRef("HttpResponse.fbs", "HRSP", "HttpResponse"),
  INGR: typeRef("IngestResult.fbs", "INGR", "IngestResult"),
  INGQ: typeRef("IngestRequest.fbs", "INGQ", "IngestRequest"),
  APR: typeRef("APR.fbs", "$APR", "APR"),
  IRM: typeRef("IRM.fbs", "$IRM", "IRM"),
  FSB: typeRef("FSB.fbs", "$FSB", "FSB"),
  TBS: typeRef("TBS.fbs", "$TBS", "TBS"),
};
export const htq = (pathname, { method = "GET", query = "", headers = {}, body } = {}) =>
  ({ portId: "request", typeRef: TYPE.HTQ, payload: encodeHtq({ method, path: pathname, query, headers, body }) });

// ---- the FlatSQL frames ----------------------------------------------------------------------------------------

// The $FSO a node emitted: its SQL and its tagged parameters decoded ([u8 tag][u32le size][bytes]).
export function decodeFso(bytes) {
  const f = read("FSO", bytes);
  assert.equal(f.OPERATION, sds.FSO.flatSqlNodeOperation.QUERY_RECORDS);
  const p = Buffer.from(f.PARAMETERS);
  const params = [];
  for (let at = 0; at < p.length;) {
    const tag = p[at], size = p.readUInt32LE(at + 1);
    const v = p.subarray(at + 5, at + 5 + size);
    params.push(tag === 2 ? { t: "i64", v: Number(v.readBigInt64LE(0)) } : tag === 3 ? { t: "f64", v: v.readDoubleLE(0) } : { t: tag, v });
    at += 5 + size;
  }
  assert.equal(params.length, f.PARAMETER_COUNT);
  return { sql: Buffer.from(f.QUERY).toString("utf8"), params };
}
// hostcap/flatsql-query's answer: the result stream cut into $FSB chunks of `chunkBytes` (at least one chunk).
export function fsbChunks(portId, data, chunkBytes = 1 << 20) {
  const bytes = Buffer.from(data ?? []);
  const n = bytes.length ? Math.ceil(bytes.length / chunkBytes) : 1;
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = new sds.FSB.FSBT();
    t.KIND = sds.FSB.flatSqlByteStreamKind.QUERY_RESULT;
    t.CHUNK_SEQUENCE = i;
    t.FINAL = i + 1 === n;
    t.TOTAL_BYTES = BigInt(bytes.length);
    t.DATA = Array.from(bytes.subarray(i * chunkBytes, (i + 1) * chunkBytes));
    out.push({ portId, typeRef: TYPE.FSB, payload: build("FSB", t) });
  }
  return out;
}

// ---- $IRM, $TBS ------------------------------------------------------------------------------------------------

export function irm({ providerId, sourceUrl, nextOffset = 0, totalBytes = 0, nextChunkIndex = 0, recordsCommitted = 0, updatedAt = "2026-08-24T00:00:00.000Z",
  headerLine = "", decoderState = null, decoderStateFormat = "", batchId = "", state, chunkBudget = 0, mergePolicy = "" }, { sizePrefixed = false } = {}) {
  const { IRMT, IRMSourceT, IRMDecodeContextT, IRMChunkT, irmJobState, irmRangeMode } = sds.IRM;
  const m = new IRMT();
  m.JOB_ID = `${providerId}@${sourceUrl}`;
  m.SEQUENCE = BigInt(nextChunkIndex);
  m.PROVIDER_ID = providerId;
  m.INGESTOR_ID = "cell-tower-ingest-wasm/v1";
  const s = new IRMSourceT();
  s.SOURCE_URL = sourceUrl;
  s.TOTAL_BYTES = BigInt(totalBytes);
  m.SOURCE = s;
  m.STATE = state ?? (totalBytes > 0 && nextOffset >= totalBytes ? irmJobState.COMPLETE : irmJobState.IN_PROGRESS);
  m.RANGE_MODE = irmRangeMode.INCLUSIVE_BYTE_RANGE;
  m.NEXT_OFFSET = BigInt(nextOffset);
  m.NEXT_CHUNK_INDEX = nextChunkIndex;
  m.CHUNK_BYTE_BUDGET = BigInt(chunkBudget);
  if (headerLine || decoderState) {
    const d = new IRMDecodeContextT();
    d.FORMAT = "text/csv";
    if (headerLine) d.HEADER_LINE = headerLine;
    if (decoderState) {
      d.DECODER_STATE = Array.from(Buffer.from(decoderState));
      d.DECODER_STATE_FORMAT = decoderStateFormat;
      d.DECODER_STATE_VERSION = "1";
      d.DECODER_STATE_BYTE_LENGTH = BigInt(Buffer.from(decoderState).length);
      d.COMPRESSION = "gzip";
      d.WINDOW = Array.from(Buffer.alloc(16, 7));
      d.WINDOW_BYTE_LENGTH = 16n;
    }
    m.DECODE_CONTEXT = d;
  }
  if (batchId) { const c = new IRMChunkT(); c.BATCH_ID = batchId; m.LAST_CHUNK = c; }
  m.RECORDS_COMMITTED = BigInt(recordsCommitted);
  m.TARGET_STANDARD = "$TBS";
  m.RECONCILE_MODE = "none";
  if (mergePolicy) m.MERGE_POLICY = mergePolicy;
  m.UPDATED_AT = updatedAt;
  return build("IRM", m, { sizePrefixed });
}
// A minimal stored $TBS row at a position (the tile lane reads only LATITUDE / LONGITUDE).
export function tbs(lat, lon, id = `t:${lat},${lon}`) {
  const { TBST, TBSProvenanceT, TBSConsensusT, tbsMergeMethod } = sds.TBS;
  const r = new TBST();
  r.ID = id;
  r.LATITUDE = lat;
  r.LONGITUDE = lon;
  const p = new TBSProvenanceT();
  p.PROVIDER_ID = "opencellid";
  p.RETRIEVED_AT = "2026-08-24T00:00:00.000Z";
  p.LICENSE = "CC BY-SA 4.0";
  r.SOURCES = [p];
  const c = new TBSConsensusT();
  c.METHOD = tbsMergeMethod.SINGLE_SOURCE;
  r.CONSENSUS = c;
  return build("TBS", r);
}

// ---- the harness -----------------------------------------------------------------------------------------------

// The node config is served by the SDK's own host (hostOptions.config): plugin.getConfig answers one ModuleConfig
// (MCFG) on raw "config", exactly what the Go node answers. The hostcall import is wrapped only to record each call;
// this module's only hostcall is plugin.getConfig, and any other fails the test.
export async function createHarness(t, config = {}) {
  const calls = [];
  const instantiate = WebAssembly.instantiate;
  WebAssembly.instantiate = async (module, imports) => {
    let memory;
    const host = imports.space_data_module_host;
    const wrapped = { ...imports, space_data_module_host: { ...host,
      call: (opPtr, opLen, ptr, len) => {
        const call = decodeHostCall(new Uint8Array(memory.buffer, ptr, len).slice());
        calls.push(call);
        if (call.op !== "plugin.getConfig") throw new Error(`unexpected hostcall ${call.op}`);
        return host.call(opPtr, opLen, ptr, len);
      },
    } };
    const instance = await instantiate(module, wrapped);
    memory = (instance.instance ?? instance).exports.memory;
    return instance;
  };
  let harness;
  try {
    harness = await createBrowserModuleHarness({
      wasmSource: new Uint8Array(fs.readFileSync(WASM_PATH)),
      manifest: JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")),
      surface: "direct",
      hostOptions: { config },
    });
  } finally {
    WebAssembly.instantiate = instantiate;
  }
  t.after(() => harness.destroy());
  harness.calls = calls;
  return harness;
}

export function ok(response) {
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  return response;
}
export const on = (response, port) => response.outputs.filter((f) => f.portId === port).map((f) => f.payload);
export const one = (response, port) => {
  const frames = on(response, port);
  assert.equal(frames.length, 1, `exactly one frame on "${port}" (got ports ${response.outputs.map((f) => f.portId).join(",")})`);
  return frames[0];
};
// An $APR's parameters / response headers as a plain object.
export const params = (list) => Object.fromEntries((list || []).map((p) => [text(p.NAME), text(p.VALUE)]));
// A $QRP projection page: the header and its rows as objects keyed by column name.
export function page(bytes) {
  const frames = framesOf(bytes);
  assert.equal(frames.length, 1, "a projection page is its header alone");
  const header = read("QRP", frames[0]);
  assert.equal(header.KIND, sds.QRP.qrpKind.Page);
  const names = header.COLUMNS.map((c) => text(c.NAME));
  const K = sds.QRP.qrpValueKind;
  const cell = (v) => (v.KIND === K.Int ? Number(v.INT_VALUE) : v.KIND === K.Float ? v.FLOAT_VALUE : v.KIND === K.Bool ? v.BOOL_VALUE : v.KIND === K.Text ? text(v.TEXT_VALUE) : null);
  return { header, names, rows: header.ROWS.map((r) => Object.fromEntries(names.map((n, i) => [n, cell(r.CELLS[i])]))) };
}

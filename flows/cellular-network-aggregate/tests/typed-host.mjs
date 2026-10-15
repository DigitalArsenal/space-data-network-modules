/*
 * The typed host the cellular flows' tests run against (typed contracts 1.0), shared by
 * flows/cellular-network-aggregate and flows/cellular-network-ingest so both exercise ONE definition of the records
 * they exchange with the store.
 *
 *   - SDS records ($APR, $DAV, $QRP, $TBS, $IRM, $PNM) are built and read with the standards' own generated TypeScript
 *     (spacedatastandards.org lib/ts, bundled with esbuild exactly as foundation/http-respond's tests do), so the guest's
 *     flatc C++ output is checked against flatc's TS output - a genuine cross-implementation round trip.
 *   - Every hostcall is the module's SDS $PIV request, decoded with the SDK's decodeHostCall and answered with a real
 *     $PIV response (encodeHostCallResult), exactly as the Go node answers it.
 *   - The runtime types (TimerTick, HttpResponse, IngestResult, FlowNotice) come from space-data-module-sdk.
 */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createFlowRuntimeHost } from "space-data-module-sdk/flow";
import { decodeHttpResponse as decodeHtr, encodeHttpRequest as encodeHtq } from "space-data-module-sdk/http";
import {
  decodeFlowNotice,
  decodeHostCall,
  decodeHttpResponse,
  decodeIngestResult,
  decodeSqlValues,
  encodeHostCallResult,
  encodeModuleConfig,
  encodeTimerTick,
  identifierOf,
} from "space-data-module-sdk/runtime-contracts";

export const decoder = new TextDecoder();
export const encoder = new TextEncoder();

export const STANDARDS_ROOT =
  process.env.SPACE_DATA_STANDARDS_ROOT ??
  fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));

async function loadStandard(code) {
  const esbuild = await import(pathToFileURL(path.join(STANDARDS_ROOT, "node_modules", "esbuild", "lib", "main.js")).href);
  const flatbuffersEntry = fs.realpathSync(path.join(STANDARDS_ROOT, "node_modules", "flatbuffers", "mjs", "flatbuffers.js"));
  const out = await esbuild.build({
    entryPoints: [path.join(STANDARDS_ROOT, "lib", "ts", code, "main.ts")],
    bundle: true, format: "esm", write: false, platform: "neutral",
    alias: { flatbuffers: flatbuffersEntry }, logLevel: "silent",
  });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
}
export const flatbuffers = await import(
  pathToFileURL(fs.realpathSync(path.join(STANDARDS_ROOT, "node_modules", "flatbuffers", "mjs", "flatbuffers.js"))).href
);
export const sds = Object.fromEntries(
  await Promise.all(["APR", "DAV", "QRP", "TBS", "IRM", "PNM"].map(async (c) => [c, await loadStandard(c)])),
);

/** Build an SDS record through its generated object API (`${code}T`). */
export function build(code, fields, { sizePrefixed = false } = {}) {
  const object = Object.assign(new sds[code][`${code}T`](), fields);
  const b = new flatbuffers.Builder(1024);
  const offset = object.pack(b);
  if (sizePrefixed) b.finishSizePrefixed(offset, `$${code}`);
  else b.finish(offset, `$${code}`);
  return b.asUint8Array().slice();
}
/** Read one SDS record (a finished buffer) back as its object-API object. */
export function unpack(code, bytes) {
  const bb = new flatbuffers.ByteBuffer(Uint8Array.from(bytes));
  assert.ok(sds[code][code].bufferHasIdentifier(bb), `not a $${code} buffer (${identifierOf(bytes)})`);
  return sds[code][code][`getRootAs${code}`](bb).unpack();
}

/** A size-prefixed stream of buffers, each frame padded to 8 bytes with zero-length prefixes (as the store pads). */
export function stream(buffers) {
  const parts = [];
  let length = 0;
  for (const b of buffers) {
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32LE(b.length, 0);
    parts.push(prefix, Buffer.from(b));
    length += 4 + b.length;
    while (length % 8) { parts.push(Buffer.alloc(4)); length += 4; }
  }
  return new Uint8Array(Buffer.concat(parts));
}
/** The frames of a size-prefixed stream (zero-length prefixes are padding). */
export function frames(bytes) {
  const out = [];
  const view = Buffer.from(bytes);
  for (let at = 0; at + 4 <= view.length;) {
    const n = view.readUInt32LE(at);
    at += 4;
    if (n === 0) continue;
    assert.ok(at + n <= view.length, "a stream frame runs past the end");
    out.push(new Uint8Array(view.subarray(at, at + n)));
    at += n;
  }
  return out;
}

// ---- the resume mark ---------------------------------------------------------------------------------------------

export const DECODER_STATE_FORMAT = "cell-tower-source/tinfl-v1";

/** One $IRM record, built with the standard's own generated TypeScript. */
export function irmRecord({
  providerId,
  sourceUrl,
  nextOffset,
  totalBytes,
  nextChunkIndex = 1,
  recordsCommitted = 0,
  updatedAt,
  batchId = `${providerId}@0`,
  headerLine = "",
  decoderState = null,
  decoderStateFormat = DECODER_STATE_FORMAT,
}) {
  const { IRMT, IRMSourceT, IRMChunkT, IRMDecodeContextT, irmJobState, irmRangeMode } = sds.IRM;
  const complete = totalBytes > 0 && nextOffset >= totalBytes;
  const decode = headerLine || decoderState
    ? Object.assign(new IRMDecodeContextT(), {
      FORMAT: "text/csv",
      HEADER_LINE: headerLine || null,
      HEADER_BYTE_LENGTH: BigInt(headerLine ? headerLine.length + 1 : 0),
      DECODER_STATE: decoderState ? Array.from(decoderState) : [],
      DECODER_STATE_FORMAT: decoderState ? decoderStateFormat : null,
      DECODER_STATE_VERSION: decoderState ? "1" : null,
      DECODER_STATE_BYTE_LENGTH: BigInt(decoderState ? decoderState.length : 0),
    })
    : null;
  return build("IRM", {
    JOB_ID: `${providerId}@${sourceUrl}`,
    SEQUENCE: BigInt(nextChunkIndex),
    PROVIDER_ID: providerId,
    INGESTOR_ID: "cell-tower-ingest-wasm/v1",
    SOURCE: Object.assign(new IRMSourceT(), { SOURCE_URL: sourceUrl, TOTAL_BYTES: BigInt(totalBytes > 0 ? totalBytes : 0) }),
    STATE: complete ? irmJobState.COMPLETE : irmJobState.IN_PROGRESS,
    RANGE_MODE: irmRangeMode.INCLUSIVE_BYTE_RANGE,
    NEXT_OFFSET: BigInt(nextOffset),
    NEXT_CHUNK_INDEX: nextChunkIndex,
    DECODE_CONTEXT: decode,
    LAST_CHUNK: Object.assign(new IRMChunkT(), { CHUNK_INDEX: nextChunkIndex - 1, BATCH_ID: batchId, COMMITTED_AT: updatedAt }),
    CHUNKS_COMMITTED: nextChunkIndex,
    BYTES_COMMITTED: BigInt(nextOffset),
    RECORDS_COMMITTED: BigInt(recordsCommitted),
    TARGET_STANDARD: "$TBS",
    RECONCILE_MODE: "none",
    UPDATED_AT: updatedAt,
  });
}

/** True when the SQL is the durable-mark read (the engine-routed IRM view) rather than the record read. */
export function isMarkQuery(sql) {
  return /\bFROM\s+"?IRM"?\b/i.test(String(sql ?? ""));
}

// ---- a real $TBS site ---------------------------------------------------------------------------------------------

/** One stored, deconflicted $TBS site (what the ingest lane persists). */
export function tbsSite({ id, latitude, longitude, providerId = "opencellid" }) {
  const { TBSProvenanceT, TBSConsensusT, tbsMergeMethod, tbsRadioClass } = sds.TBS;
  return build("TBS", {
    ID: id,
    RADIO: tbsRadioClass.LTE,
    LATITUDE: latitude,
    LONGITUDE: longitude,
    SOURCES: [Object.assign(new TBSProvenanceT(), {
      PROVIDER_ID: providerId, RETRIEVED_AT: "2026-08-24T00:00:00.000Z", LICENSE: "CC BY-SA 4.0", CONTRIBUTED: true,
      REPORTED_LATITUDE: latitude, REPORTED_LONGITUDE: longitude,
    })],
    CONSENSUS: Object.assign(new TBSConsensusT(), {
      METHOD: tbsMergeMethod.SINGLE_SOURCE, PROVIDERS_CONSULTED: 1, PROVIDERS_AGREEING: 1, WINNING_PROVIDER_ID: providerId,
    }),
  });
}

// ---- the host ------------------------------------------------------------------------------------------------------

const headerLines = (bytes) => Object.fromEntries(
  decoder.decode(bytes ?? new Uint8Array(0)).split(/\r?\n/).filter(Boolean)
    .map((l) => [l.slice(0, l.indexOf(":")).trim().toLowerCase(), l.slice(l.indexOf(":") + 1).trim()]),
);
const headerBlock = (headers) => Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\r\n");

/**
 * The host side of the typed hostcall. `handlers[op](call)` returns the answer as { result, raw, lists } (ok) or
 * { error: { code, message } }; an op without a handler fails the test. Every call is recorded with its decoded
 * params / raw / lists (and, for http.request, url / headers / body; for storage.flatsql_query_stream, sql / params).
 */
export function createHostStub(handlers) {
  const calls = [];
  const memoryRef = { memory: null };
  let response = new Uint8Array(0);
  const imports = {
    space_data_module_host: {
      call(opPtr, opLen, payloadPtr, payloadLen) {
        const heap = new Uint8Array(memoryRef.memory.buffer);
        const operation = decoder.decode(heap.subarray(opPtr, opPtr + opLen));
        const call = decodeHostCall(Uint8Array.from(heap.subarray(payloadPtr, payloadPtr + payloadLen)));
        assert.equal(call.op, operation, "the $PIV METHOD_ID names the operation");
        const c = { operation, params: call.params, lists: call.lists, raw: call.raw };
        if (operation === "http.request") {
          c.url = decoder.decode(call.raw.url);
          c.headers = headerLines(call.raw.headers);
          c.method = call.params?.METHOD ?? "GET";
          c.body = call.raw.body ? Buffer.from(call.raw.body) : Buffer.alloc(0);
        }
        if (operation === "storage.flatsql_query_stream") {
          c.sql = decoder.decode(call.raw.sql);
          // SQL values on raw "params" (FlatSQL's tagged encoding): {t, v} each; sqlParams the plain values.
          c.sqlValues = decodeSqlValues(call.raw.params ?? new Uint8Array(0));
          c.sqlParams = c.sqlValues.map(({ t, v }) => (t === "i64" ? Number(v) : v));
        }
        calls.push(c);
        const handler = handlers[operation];
        if (!handler) assert.fail(`unexpected hostcall ${operation}`);
        const answer = handler(c) ?? {};
        response = encodeHostCallResult(answer.error ? { ok: false, error: answer.error } : { ok: true, op: operation, ...answer });
        return 0;
      },
      response_len() { return response.length; },
      read_response(dst, len) {
        const n = Math.min(len, response.length);
        new Uint8Array(memoryRef.memory.buffer).set(response.subarray(0, n), dst);
        return n;
      },
    },
  };
  return { calls, imports, memoryRef };
}

/** plugin.getConfig answered with `config` as one ModuleConfig on raw "config", as the Go node answers it. */
export const configHandler = (config) => () => ({ raw: { config: encodeModuleConfig(config) } });
/** An http.request answer. */
export const httpAnswer = (status, body = "", headers = {}) => ({
  result: { STATUS: status, RETRIEVED_MS: BigInt(Date.UTC(2026, 9, 13, 12)) },
  raw: { url: "", headers: headerBlock(headers), body: Buffer.from(body) },
});
/** A storage.flatsql_query_stream answer carrying `bytes` (a size-prefixed stream) on raw "stream". */
export const streamAnswer = (bytes, rows = frames(bytes).length) => ({
  result: { ROWS: BigInt(rows), COLUMNS: 1 },
  raw: { stream: Buffer.from(bytes) },
});

/** Run the compiled flow once: one trigger frame in, every egress frame out (decoded by its type). */
export async function runFlow(wasmUrl, stub, trigger) {
  const host = await createFlowRuntimeHost({
    wasmSource: new Uint8Array(fs.readFileSync(fileURLToPath(wasmUrl))),
    extraImports: stub.imports,
    runtimeTarget: "wasmedge",
  });
  stub.memoryRef.memory = host.memory;
  const egress = [];
  host.enqueueTriggerFrame(0, trigger);
  await host.drain({
    "sdn.flow.egress:emit": ({ frames: out }) => {
      for (const f of out) egress.push(decodeEgress(Uint8Array.from(f.bytes)));
      return { statusCode: 0 };
    },
  });
  return { egress, host };
}

/** An egress frame by its type: $HTR (the HTTP answer), INGR, FNTC, HRSP, $IRM, $PNM. */
export function decodeEgress(bytes) {
  const id = identifierOf(bytes);
  if (id === "$HTR") {
    const r = decodeHtr(bytes);
    return { type: "$HTR", ...r, header: (name) => r.headers.find((h) => h.name === name)?.value };
  }
  if (id === "INGR") return { type: id, ...decodeIngestResult(bytes) };
  if (id === "FNTC") return { type: id, ...decodeFlowNotice(bytes) };
  if (id === "HRSP") return { type: id, ...decodeHttpResponse(bytes) };
  if (id === "$IRM") return { type: id, ...unpack("IRM", bytes), bytes };
  if (id === "$PNM") return { type: id, ...unpack("PNM", bytes) };
  return assert.fail(`an egress frame of no known type: "${id}"`);
}

export const htqTrigger = (request) => ({ portId: "request", bytes: encodeHtq(request) });
export const tickTrigger = () => ({
  portId: "tick",
  bytes: encodeTimerTick({ triggerId: "timer-cell-ingest", scheduledMs: Date.UTC(2026, 7, 14), firedMs: Date.UTC(2026, 7, 14) }),
});

/** The HTTP answer of an exchange (exactly one $HTR per request). */
export function httpAnswerOf(egress) {
  const answers = egress.filter((e) => e.type === "$HTR");
  assert.equal(answers.length, 1, `exactly one HTTP answer per exchange, got ${answers.length}`);
  return answers[0];
}

/** A $QRP page stream (header + record frames, or a projection): the header unpacked plus its rows as objects. */
export function readPage(body) {
  const [head, ...records] = frames(body);
  const header = unpack("QRP", head);
  const names = (header.COLUMNS ?? []).map((c) => c.NAME);
  const cell = (v) => {
    switch (v?.KIND) {
      case 1: return v.BOOL_VALUE;
      case 2: return Number(v.INT_VALUE);
      case 3: return v.FLOAT_VALUE;
      case 4: return v.TEXT_VALUE;
      case 5: return Uint8Array.from(v.BYTES_VALUE);
      default: return null;
    }
  };
  const rows = (header.ROWS ?? []).map((r) => Object.fromEntries(names.map((n, i) => [n, cell(r.CELLS[i])])));
  return { header, rows, records };
}

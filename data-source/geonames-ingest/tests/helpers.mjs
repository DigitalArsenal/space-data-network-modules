// Shared test plumbing for data-source/geonames-ingest on the typed contracts (1.0): the compiled wasm in the SDK
// browser harness, every frame a FlatBuffer - TimerTick in, $FSO out (the mark read), $FSB chunks in (the
// flatsql-query result carrying $IRM marks), HttpRequest out with the job (a size-prefixed $GNP header) in CONTEXT,
// HttpResponse + $GNP stream in, IngestRequest out, IngestResult in, $IRM + HttpRequest out - and the node config the
// SDS $PIV plugin.getConfig answer (one ModuleConfig on raw "config").

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  decodeHostCall,
  decodeHttpRequest,
  decodeIngestRequest,
  decodeIngestResult,
  encodeHttpResponse,
  encodeIngestRequest,
  encodeIngestResult,
  encodeTimerTick,
  identifierOf,
} from "space-data-module-sdk/runtime-contracts";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

export const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
export const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
export const STANDARDS_ROOT =
  process.env.SPACE_DATA_STANDARDS_ROOT ?? fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));
const lib = (code) => pathToFileURL(path.join(STANDARDS_ROOT, `lib/js/${code}/main.js`));
export const flatbuffers = createRequire(lib("GNP"))("flatbuffers");
export const gnpLib = await import(lib("GNP").href);
export const irmLib = await import(lib("IRM").href);
export const fsoLib = await import(lib("FSO").href);
export const fsbLib = await import(lib("FSB").href);

export const BASE = "https://download.geonames.org/export/dump/";
export const TYPE = {
  TICK: { schemaName: "TimerTick.fbs", fileIdentifier: "TICK", rootTypeName: "TimerTick", wireFormat: "flatbuffer" },
  FSB: { schemaName: "FSB.fbs", fileIdentifier: "$FSB", rootTypeName: "FSB", wireFormat: "flatbuffer" },
  GNP: { schemaName: "GNP.fbs", fileIdentifier: "$GNP", rootTypeName: "GNP", wireFormat: "flatbuffer" },
  HRSP: { schemaName: "HttpResponse.fbs", fileIdentifier: "HRSP", rootTypeName: "HttpResponse", wireFormat: "flatbuffer" },
  INGQ: { schemaName: "IngestRequest.fbs", fileIdentifier: "INGQ", rootTypeName: "IngestRequest", wireFormat: "flatbuffer" },
  INGR: { schemaName: "IngestResult.fbs", fileIdentifier: "INGR", rootTypeName: "IngestResult", wireFormat: "flatbuffer" },
};

// ---- frames in ----------------------------------------------------------------------------------------------

export const tickFrame = (firedMs = Date.UTC(2026, 7, 15)) => ({
  portId: "tick", typeRef: TYPE.TICK, payload: encodeTimerTick({ triggerId: "timer-geonames-ingest", scheduledMs: firedMs, firedMs }),
});

// An $IRM mark as publish_request authors it (the fields ingest_plan reads, and the rest it writes).
export function irm({ dataset = "geonames", jobId = `geonames-ingest/${dataset}`, date = "2026-08-14", sequence, state = "COMPLETE", etag = null, lastModified = null } = {}) {
  const { IRMT, IRMSourceT, irmJobState } = irmLib;
  const day = Math.floor(Date.parse(`${date}T00:00:00Z`) / 86400000);
  const record = new IRMT(jobId, BigInt(sequence ?? day), "geonames", "com.digitalarsenal.data-source.geonames-ingest",
    new IRMSourceT(`${BASE}modifications-${date}.txt`, null, null, null, 0n, etag, lastModified, null, `${date}T00:00:00.000Z`),
    irmJobState[state]);
  record.UPDATED_AT = `${date}T02:00:00.000Z`;
  const b = new flatbuffers.Builder(512);
  b.finish(record.pack(b), "$IRM");
  return b.asUint8Array().slice();
}

// The flatsql-query result as hostcap/flatsql-query answers it: the engine's aligned size-prefixed stream (each record
// size-prefixed, a zero-length prefix as alignment padding between them) in $FSB QUERY_RESULT chunks of `chunk` bytes.
export function markFrames(records, chunk = 1024 * 1024) {
  const parts = [];
  for (const r of records) {
    const len = Buffer.alloc(4);
    len.writeUInt32LE(r.length, 0);
    parts.push(len, Buffer.from(r), Buffer.alloc(4)); // + a zero-length (padding) prefix
  }
  const stream = Buffer.concat(parts);
  const chunks = [];
  for (let at = 0, seq = 0; at < stream.length || seq === 0; at += chunk, seq++) {
    const { FSBT, flatSqlByteStreamKind } = fsbLib;
    const data = [...stream.subarray(at, at + chunk)];
    const fsb = new FSBT(0n, flatSqlByteStreamKind.QUERY_RESULT, seq, at + chunk >= stream.length, BigInt(stream.length), BigInt(records.length), 1, null, null, data);
    const b = new flatbuffers.Builder(1024 + data.length);
    b.finish(fsb.pack(b), "$FSB");
    chunks.push({ portId: "mark", typeRef: TYPE.FSB, payload: b.asUint8Array().slice() });
    if (at + chunk >= stream.length) break;
  }
  return chunks;
}

// A real $GNP record stream of `count` places (each a size-prefixed $GNP buffer).
export function gnpStream(count = 2) {
  const { GNPT, GNPProvenanceT } = gnpLib;
  const parts = [];
  for (let i = 0; i < count; i++) {
    const place = new GNPT(`geonames:${1000 + i}`, `Place ${i}`);
    place.SOURCE = new GNPProvenanceT("geonames", null, null, "2026-08-15T00:00:00.000Z", null, null, null, "2026-08-15T02:00:00.000Z", "CC BY 4.0", null, null, false, false, String(1000 + i), null);
    const b = new flatbuffers.Builder(256);
    b.finishSizePrefixed(place.pack(b), "$GNP");
    parts.push(Buffer.from(b.asUint8Array()));
  }
  return Buffer.concat(parts);
}
export const recordsFrame = (count = 2) => ({ portId: "records", typeRef: TYPE.GNP, payload: Uint8Array.from(gnpStream(count)) });

// The job header as ingest_plan writes it (ID, NAME, SOURCE dataset contract).
export function jobHeader({ dataset = "geonames", epoch = "2026-08-15T00:00:00.000Z", file = "cities15000.zip", name = "cities15000.txt" } = {}) {
  const { GNPT, GNPProvenanceT } = gnpLib;
  const header = new GNPT("geonames", name);
  header.SOURCE = new GNPProvenanceT(dataset, "GeoNames gazetteer", BASE, epoch, null, `${BASE}${file}`, file, "", "CC BY 4.0", null, null, false, false, "", null);
  const b = new flatbuffers.Builder(512);
  b.finishSizePrefixed(header.pack(b), "$GNP");
  return b.asUint8Array().slice();
}
export const responseFrame = ({ status = 206, headers = {}, context = jobHeader(), retrievedMs = Date.UTC(2026, 7, 15, 2, 18) } = {}) => ({
  portId: "response", typeRef: TYPE.HRSP, payload: encodeHttpResponse({ url: "", status, headers, body: new Uint8Array(0), context, retrievedMs }),
});
export const resultFrame = (r) => ({ portId: "result", typeRef: TYPE.INGR, payload: encodeIngestResult(r) });
export const metaFrame = (r) => ({ portId: "meta", typeRef: TYPE.INGQ, payload: encodeIngestRequest(r) });

// ---- frames out ---------------------------------------------------------------------------------------------

export const readHeader = (context) => {
  assert.equal(identifierOf(context.subarray(4)), "$GNP", "CONTEXT is one size-prefixed $GNP record");
  assert.equal(new DataView(context.buffer, context.byteOffset).getUint32(0, true), context.length - 4);
  return gnpLib.GNP.getRootAsGNP(new flatbuffers.ByteBuffer(Uint8Array.from(context.subarray(4)))).unpack();
};
export const decodeFso = (bytes) => fsoLib.FSO.getRootAsFSO(new flatbuffers.ByteBuffer(Uint8Array.from(bytes))).unpack();
export const decodeIrm = (bytes) => irmLib.IRM.getRootAsIRM(new flatbuffers.ByteBuffer(Uint8Array.from(bytes))).unpack();

export function outputsByPort(response) {
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  const map = new Map();
  for (const out of response.outputs) {
    const id = identifierOf(out.payload);
    const value = id === "HREQ" ? decodeHttpRequest(out.payload) : id === "INGQ" ? decodeIngestRequest(out.payload)
      : id === "INGR" ? decodeIngestResult(out.payload) : id === "$FSO" ? decodeFso(out.payload) : id === "$IRM" ? decodeIrm(out.payload)
      : Buffer.from(out.payload);
    assert.ok(!map.has(out.portId), `one frame per port: ${out.portId}`);
    map.set(out.portId, value);
  }
  return map;
}

// ---- harness: the node config is the $PIV plugin.getConfig answer -----------------------------------------------

// The node config is served by the SDK's own host (hostOptions.config): plugin.getConfig answers one ModuleConfig
// (MCFG) on raw "config", exactly what the Go node answers. The hostcall import is wrapped only to record each
// operation; this node's only hostcall is plugin.getConfig (sdk_compat asserts it).
export async function createHarness(t, config = {}) {
  const calls = [];
  const instantiate = WebAssembly.instantiate;
  WebAssembly.instantiate = async (module, imports) => {
    let memory;
    const host = imports.space_data_module_host;
    const wrapped = { ...imports, space_data_module_host: { ...host,
      call: (opPtr, opLen, ptr, len) => {
        calls.push(decodeHostCall(new Uint8Array(memory.buffer, ptr, len).slice()).op);
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
      wasmSource: new Uint8Array(fs.readFileSync(ISOMORPHIC_WASM_PATH)),
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

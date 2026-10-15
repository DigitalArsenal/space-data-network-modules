// Typed contracts 1.0 for the terrain-ingest tests: the frames the scheduler reads and writes, built and decoded with
// the SDK's runtime contracts and the SDS libraries (spacedatastandards.org lib/js), and a harness whose
// plugin.getConfig is answered as the Go node answers it - one ModuleConfig on raw "config" (the SDK host's own answer
// for a fixed config). No JSON frame crosses a port in these tests.

import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { createBrowserModuleHarness } from "space-data-module-sdk/testing";
import {
  decodeHttpRequest,
  decodeIngestRequest,
  decodeModuleConfig,
  encodeFlowNotice,
  encodeHttpResponse,
  encodeIngestRequest,
  encodeIngestResult,
  encodeTimerTick,
} from "space-data-module-sdk/runtime-contracts";

import {
  createTypedHarness,
  DTT_LIB,
  flatbuffers,
  storeAnswer,
  decodeFsoQuery,
  STANDARDS_ROOT,
} from "../../terrain-source/typed-frames.mjs";

export { decodeHttpRequest, decodeIngestRequest, decodeModuleConfig, decodeFsoQuery, encodeIngestRequest, encodeIngestResult };

const IRM_LIB = await import(new URL(`file://${STANDARDS_ROOT}/lib/js/IRM/main.js`).href);
export { IRM_LIB };

export const MANIFEST = JSON.parse(fs.readFileSync(new URL("../plugin-manifest.json", import.meta.url), "utf8"));
export const WASM_PATH = fileURLToPath(new URL("../dist/isomorphic/module.wasm", import.meta.url));

export const TYPE = {
  TICK: { schemaName: "TimerTick.fbs", fileIdentifier: "TICK", rootTypeName: "TimerTick", wireFormat: "flatbuffer" },
  FSB: { schemaName: "FSB.fbs", fileIdentifier: "$FSB", rootTypeName: "FSB", wireFormat: "flatbuffer" },
  IRM: { schemaName: "IRM.fbs", fileIdentifier: "$IRM", rootTypeName: "IRM", wireFormat: "flatbuffer" },
  DTT: { schemaName: "DTT.fbs", fileIdentifier: "$DTT", rootTypeName: "DTT", wireFormat: "flatbuffer" },
  FNTC: { schemaName: "FlowNotice.fbs", fileIdentifier: "FNTC", rootTypeName: "FlowNotice", wireFormat: "flatbuffer" },
  HRSP: { schemaName: "HttpResponse.fbs", fileIdentifier: "HRSP", rootTypeName: "HttpResponse", wireFormat: "flatbuffer" },
  INGQ: { schemaName: "IngestRequest.fbs", fileIdentifier: "INGQ", rootTypeName: "IngestRequest", wireFormat: "flatbuffer" },
  INGR: { schemaName: "IngestResult.fbs", fileIdentifier: "INGR", rootTypeName: "IngestResult", wireFormat: "flatbuffer" },
};

/** A harness for this module with `config` as the node config (object, or a function returning one). */
export async function createHarness(t, config = {}) {
  const harness = await createTypedHarness({
    createBrowserModuleHarness,
    wasmSource: fs.readFileSync(WASM_PATH),
    manifest: MANIFEST,
    config,
  });
  t?.after?.(() => harness.destroy());
  return harness;
}

/** A TimerTick frame fired at `firedAt` (an ISO instant), or with no clock at all when null. */
export const tickFrame = (firedAt = "2026-08-15T00:00:00Z") => ({
  portId: "tick",
  typeRef: TYPE.TICK,
  payload: encodeTimerTick({ triggerId: "timer-terrain-ingest", firedMs: firedAt === null ? 0 : Date.parse(firedAt) }),
});

/** One $IRM record (root buffer) for a mark. */
export function irmRecord({ jobId, next = 0, storedTotal = 0, etag = null, provider = "copernicus", state = "IN_PROGRESS", decodeContext = null }) {
  const { IRMT, IRMSourceT, IRMChunkT, irmJobState, irmRangeMode } = IRM_LIB;
  const source = new IRMSourceT("https://copernicus-dem-30m.s3.eu-central-1.amazonaws.com/");
  if (etag) source.ENTITY_TAG = etag;
  const mark = new IRMT(jobId, BigInt(next), provider, "terrain-ingest-wasm/v1", source, irmJobState[state],
    irmRangeMode.PART_INDEX);
  mark.NEXT_CHUNK_INDEX = next;
  mark.CHUNKS_COMMITTED = next;
  mark.RECORDS_COMMITTED = BigInt(storedTotal);
  mark.LAST_CHUNK = new IRMChunkT(next > 0 ? next - 1 : 0);
  mark.UPDATED_AT = "2026-08-26T00:00:00.000Z";
  if (decodeContext) mark.DECODE_CONTEXT = decodeContext;
  const b = new flatbuffers.Builder(1024);
  b.finish(mark.pack(b), "$IRM");
  return b.asUint8Array().slice();
}

/** Records as hostcap/flatsql-query's "records" answer: one aligned size-prefixed stream, chunked into $FSB frames. */
export function markFrames(records, chunkBytes) {
  const parts = [];
  for (const r of records) {
    const size = Buffer.alloc(4);
    size.writeUInt32LE(r.length);
    parts.push(size, Buffer.from(r));
    const pad = (8 - ((r.length + 4) % 8)) % 8;
    if (pad >= 4) parts.push(Buffer.alloc(4));  // a zero-length prefix is alignment padding
  }
  return storeAnswer(Buffer.concat(parts), chunkBytes ? { chunkBytes } : {})
    .filter((f) => f.portId === "records")
    .map((f) => ({ ...f, portId: "mark" }));
}

export const jobIdOf = (dataset, tileset, epoch) => `${dataset}@${tileset}@${epoch}`;

/** A plan frame's $DTT header stream, decoded. */
export function decodePlan(bytes) {
  const { DTT } = DTT_LIB;
  const buf = Buffer.from(bytes);
  const out = [];
  for (let at = 0; at + 4 <= buf.length;) {
    const len = buf.readUInt32LE(at);
    at += 4;
    if (len === 0) continue;
    const record = DTT.getRootAsDTT(new flatbuffers.ByteBuffer(Uint8Array.from(buf.subarray(at, at + len)))).unpack();
    at += len;
    out.push({
      tilesetId: record.TILESET_ID,
      tilingScheme: record.TILING_SCHEME,
      level: record.LEVEL,
      x: record.X,
      y: record.Y,
      rowOriginNorth: record.ROW_ORIGIN_NORTH,
      west: record.WEST_DEG,
      south: record.SOUTH_DEG,
      east: record.EAST_DEG,
      north: record.NORTH_DEG,
      gridSize: record.GRID_WIDTH,
      maxLevel: record.MAX_LEVEL,
      childAvailability: record.CHILD_AVAILABILITY,
      sourceClass: record.SOURCE_CLASS,
      verticalDatumName: record.VERTICAL_DATUM_NAME,
      etag: record.ETAG,
      remarks: record.REMARKS,
      payloadBytes: record.PAYLOAD?.BYTES?.length ?? 0,
      provenance: record.PROVENANCE,
      demUrls: record.PROVENANCE?.SOURCE_QUERY ? record.PROVENANCE.SOURCE_QUERY.split(" ") : [],
      wbmUrls: record.WATER_MASK_PROVENANCE?.SOURCE_QUERY ? record.WATER_MASK_PROVENANCE.SOURCE_QUERY.split(" ") : [],
    });
  }
  return out;
}

/** An $IRM (job or mark) frame decoded, with the fields the lane reads named. */
export function decodeIrm(bytes) {
  const { IRM } = IRM_LIB;
  const r = IRM.getRootAsIRM(new flatbuffers.ByteBuffer(Uint8Array.from(bytes))).unpack();
  return {
    record: r,
    jobId: r.JOB_ID,
    firstIndex: r.LAST_CHUNK?.CHUNK_INDEX ?? 0,
    nextIndex: r.NEXT_CHUNK_INDEX,
    recordsCommitted: Number(r.RECORDS_COMMITTED),
    epoch: r.SOURCE?.SOURCE_VERSION,
    etag: r.SOURCE?.ENTITY_TAG,
    lastModified: r.SOURCE?.LAST_MODIFIED,
    notes: r.NOTES,
    tags: r.TAGS,
    state: r.STATE,
  };
}

export const irmFrame = (portId, bytes) => ({ portId, typeRef: TYPE.IRM, payload: bytes });

/** A planner invocation's outputs by port (repeated ports as arrays). */
export function outputs(response) {
  if (response.statusCode !== 0) throw new Error(`${response.errorCode}: ${response.errorMessage}`);
  const map = new Map();
  for (const o of response.outputs) {
    if (!map.has(o.portId)) map.set(o.portId, []);
    map.get(o.portId).push(new Uint8Array(o.payload));
  }
  return map;
}

export const reportFrame = (count) => ({
  portId: "decision",
  typeRef: TYPE.FNTC,
  payload: encodeFlowNotice({ kind: "info", schema: "DTT.fbs", count, reason: "tile-block" }),
});
export const responseFrame = (headers = {}, status = 200, extra = {}) => ({
  portId: "response",
  typeRef: TYPE.HRSP,
  payload: encodeHttpResponse({ url: "https://granules.test/primary.tif", status, headers, body: new Uint8Array(0), ...extra }),
});
export const recordsFrame = (bytes) => ({ portId: "records", typeRef: TYPE.DTT, payload: Uint8Array.from(bytes) });

/** An IRMT (object API) as an $IRM root buffer. */
export function encodeIrm(mark) {
  const b = new flatbuffers.Builder(1024);
  b.finish(mark.pack(b), "$IRM");
  return b.asUint8Array().slice();
}

/** A planner's job: the mark-to-be for the batch [first, next). */
export function jobRecord({ jobId, first, next, recordsCommitted = 0, walk = "cell", epoch = null, provider = "copernicus",
  sourceUrl = "https://copernicus-dem-30m.s3.eu-central-1.amazonaws.com/" }) {
  const { IRMT, IRMSourceT, IRMChunkT, irmJobState, irmRangeMode } = IRM_LIB;
  const source = new IRMSourceT(sourceUrl);
  if (epoch) source.SOURCE_VERSION = epoch;
  const job = new IRMT(jobId, BigInt(first), provider, "terrain-ingest-wasm/v1", source, irmJobState.IN_PROGRESS, irmRangeMode.PART_INDEX);
  job.NEXT_CHUNK_INDEX = next;
  job.CHUNKS_COMMITTED = first;
  job.LAST_CHUNK = new IRMChunkT(first);
  job.RECORDS_COMMITTED = BigInt(recordsCommitted);
  job.UPDATED_AT = "2026-08-26T00:00:00.000Z";
  job.TAGS = ["lane:terrain", `walk:${walk}`];
  return encodeIrm(job);
}

// TYPED CONTRACTS 1.0 for the terrain lane: the FlatBuffer frames terrain-source / terrain-ingest read and write,
// built and decoded with the SDK runtime contracts and the SDS libraries (spacedatastandards.org lib/js). Shared by the
// module tests, the flow tests and tools/terrain-pyramid, so every caller puts the SAME bytes on the wire the flow does.

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
// ── typed contracts 1.0: the frames the module reads and writes ─────────────
//
// The tests keep describing a plan the way the lane always has (a plain object: tilesetId, gridSize, level/x/y or
// tiles[], provenance, waterMask, maxGridSize, ...), and these builders put it on the wire the way the module now
// takes it: a size-prefixed stream of $DTT HEADER records (one per address, PAYLOAD present and empty) on "plan", the
// encoder's knobs as a ModuleConfig on "options", every granule an HttpResponse (HRSP) and the report a FlowNotice.

import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  decodeFlowNotice,
  decodeHostCall,
  encodeHostCallResult,
  encodeHttpResponse,
  encodeModuleConfig,
} from "space-data-module-sdk/runtime-contracts";

const requireHere = createRequire(import.meta.url);
export const STANDARDS_ROOT =
  process.env.SPACE_DATA_STANDARDS_ROOT ?? path.dirname(requireHere.resolve("spacedatastandards.org/package.json"));
const sdsLib = (code) => pathToFileURL(path.join(STANDARDS_ROOT, "lib", "js", code, "main.js"));
const flatbuffers = createRequire(sdsLib("DTT"))("flatbuffers");
export const DTT_LIB = await import(sdsLib("DTT").href);
export const FSO_LIB = await import(sdsLib("FSO").href);
export const FSB_LIB = await import(sdsLib("FSB").href);
export { flatbuffers };

export const TYPE = {
  DTT: { schemaName: "DTT.fbs", fileIdentifier: "$DTT", rootTypeName: "DTT", wireFormat: "flatbuffer" },
  MCFG: { schemaName: "ModuleConfig.fbs", fileIdentifier: "MCFG", rootTypeName: "ModuleConfig", wireFormat: "flatbuffer" },
  HRSP: { schemaName: "HttpResponse.fbs", fileIdentifier: "HRSP", rootTypeName: "HttpResponse", wireFormat: "flatbuffer" },
  HTQ: { schemaName: "HttpRequestAbi.fbs", fileIdentifier: "$HTQ", rootTypeName: "HttpRequest", wireFormat: "flatbuffer" },
  FSO: { schemaName: "FSO.fbs", fileIdentifier: "$FSO", rootTypeName: "FSO", wireFormat: "flatbuffer" },
  FSB: { schemaName: "FSB.fbs", fileIdentifier: "$FSB", rootTypeName: "FSB", wireFormat: "flatbuffer" },
};

const enumOrdinal = (table, name, outOfRange) =>
  name === undefined || name === null || name === "" ? 0 : (table[name] ?? outOfRange);

function provenanceOf(b, p = {}) {
  const { DTTProvenance } = DTT_LIB;
  const s = (v) => b.createString(v ?? "");
  const opt = (v) => (v ? b.createString(v) : 0);
  const id = s(p.datasetId), epoch = s(p.datasetEpoch), retrieved = s(p.retrievedAt), license = s(p.license);
  const name = opt(p.datasetName), licenseUrl = opt(p.licenseUrl), attribution = opt(p.attribution), sourceUrl = opt(p.sourceUrl);
  DTTProvenance.startDTTProvenance(b);
  DTTProvenance.addDatasetId(b, id);
  DTTProvenance.addDatasetEpoch(b, epoch);
  DTTProvenance.addRetrievedAt(b, retrieved);
  DTTProvenance.addLicense(b, license);
  if (name) DTTProvenance.addDatasetName(b, name);
  if (licenseUrl) DTTProvenance.addLicenseUrl(b, licenseUrl);
  if (attribution) DTTProvenance.addAttribution(b, attribution);
  if (sourceUrl) DTTProvenance.addSourceUrl(b, sourceUrl);
  return DTTProvenance.endDTTProvenance(b);
}

/** One $DTT HEADER record (no mesh) for one address of a plan, finished size-prefixed. */
export function planHeader(plan, address) {
  const { DTT, DTTPayloadRef, dttTilingScheme, dttSourceClass, dttWaterMask } = DTT_LIB;
  const b = new flatbuffers.Builder(1024);
  const tileset = b.createString(plan.tilesetId ?? "");
  const datum = plan.verticalDatumName ? b.createString(plan.verticalDatumName) : 0;
  const provenance = provenanceOf(b, plan.provenance);
  const water = plan.waterMask;
  const waterProvenance = water?.provenance ? provenanceOf(b, water.provenance) : 0;
  DTTPayloadRef.startDTTPayloadRef(b);
  const payload = DTTPayloadRef.endDTTPayloadRef(b);
  DTT.startDTT(b);
  DTT.addTilesetId(b, tileset);
  DTT.addTilingScheme(b, enumOrdinal(dttTilingScheme, plan.scheme, dttTilingScheme.CUSTOM));
  DTT.addLevel(b, address.level ?? plan.level ?? 0);
  DTT.addX(b, address.x ?? 0);
  DTT.addY(b, address.y ?? 0);
  DTT.addRowOriginNorth(b, Boolean(plan.rowOriginNorth));
  DTT.addPayload(b, payload);
  if (plan.gridSize !== undefined) { DTT.addGridWidth(b, plan.gridSize); DTT.addGridHeight(b, plan.gridSize); }
  if (datum) DTT.addVerticalDatumName(b, datum);
  if (water) {
    DTT.addWaterMaskKind(b, enumOrdinal(dttWaterMask, water.kind, 99));
    if (water.width !== undefined) DTT.addWaterMaskWidth(b, water.width);
    if (water.height !== undefined) DTT.addWaterMaskHeight(b, water.height);
    if (waterProvenance) DTT.addWaterMaskProvenance(b, waterProvenance);
  }
  DTT.addChildAvailability(b, address.childAvailability ?? 0);
  DTT.addMaxLevel(b, plan.maxLevel ?? 0);
  DTT.addSourceClass(b, enumOrdinal(dttSourceClass, plan.sourceClass, 99));
  DTT.addProvenance(b, provenance);
  DTT.finishSizePrefixedDTTBuffer(b, DTT.endDTT(b));
  return b.asUint8Array().slice();
}

/** A plan as the "plan" ($DTT header stream) frame plus, when it states any, the "options" (MCFG) frame. */
export function planInputs(plan) {
  const addresses = Array.isArray(plan.tiles)
    ? plan.tiles
    : [{ level: plan.level, x: plan.x, y: plan.y, childAvailability: plan.childAvailability }];
  const parts = addresses.map((a) => planHeader(plan, a));
  const stream = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { stream.set(p, at); at += p.length; }
  const inputs = [{ portId: "plan", typeRef: TYPE.DTT, payload: stream }];
  const options = {};
  for (const key of ["maxGridSize", "minGridSize", "measureAccuracy", "skipOceanTiles"]) {
    if (plan[key] !== undefined) options[key] = plan[key];
  }
  if (Object.keys(options).length) inputs.push({ portId: "options", typeRef: TYPE.MCFG, payload: encodeModuleConfig(options) });
  return inputs;
}

/** A granule as hostcap/http-request answers it: an HttpResponse, BODY verbatim. */
export function httpResponseBytes(body, status = 200, extra = {}) {
  return encodeHttpResponse({ url: extra.url ?? "https://granules.test/granule.tif", status, body: Uint8Array.from(body ?? []), ...extra });
}
export const granuleFrame = (portId, body, status = 200, extra = {}) => ({
  portId,
  typeRef: TYPE.HRSP,
  payload: httpResponseBytes(body, status, extra),
});

const scalar = (v) => (v === "true" ? true : v === "false" ? false : v !== "" && Number.isFinite(Number(v)) ? Number(v) : v);

/** The FlowNotice report back as the object the lane's report always described. */
export function decodeTileReport(bytes) {
  const notice = decodeFlowNotice(Uint8Array.from(bytes));
  assert.equal(notice.kind, "info");
  assert.equal(notice.reason, "tile-block");
  const report = { tiles: [], notice };
  for (const item of notice.items) {
    const tile = item.match(/^(\d+)\/(\d+)\/(\d+)(?: (.*))?$/);
    if (tile) {
      const entry = { level: Number(tile[1]), x: Number(tile[2]), y: Number(tile[3]) };
      for (const pair of (tile[4] ?? "").split(" ").filter(Boolean)) {
        const at = pair.indexOf("=");
        entry[pair.slice(0, at)] = scalar(pair.slice(at + 1));
      }
      report.tiles.push(entry);
      continue;
    }
    const at = item.indexOf("=");
    const key = item.slice(0, at), value = item.slice(at + 1);
    report[key] = key === "tilesetId" || key === "digest" || key === "sourceClass" || key === "waterMaskKind" ||
      key === "verticalDatumNote" || key === "contentEncoding" || key === "verticalDatum" ? value : scalar(value);
  }
  assert.equal(report.recordsOut, notice.count);
  return report;
}

/**
 * layer.json `available` ([[{startX, startY, endX, endY}, ...] per level]) as the NumberList terrain-source reads in
 * place: [level, startX, startY, endX, endY] per rectangle. A ModuleConfig has no list-of-lists kind.
 */
export function availabilityNumbers(available) {
  const out = [];
  (available ?? []).forEach((rects, level) => {
    for (const r of rects ?? []) out.push(level, r.startX, r.startY, r.endX, r.endY);
  });
  return out;
}
/** A config object as the node holds it for the terrain lane: terrain_available given in layer.json shape is flattened. */
export function moduleConfigOf(config) {
  const out = { ...(config ?? {}) };
  if (Array.isArray(out.terrain_available) && out.terrain_available.some(Array.isArray)) {
    out.terrain_available = availabilityNumbers(out.terrain_available);
  }
  return out;
}
/** The same config as the ModuleConfig a "config" port takes. */
export function configFrame(config, portId = "config") {
  return { portId, typeRef: TYPE.MCFG, payload: encodeModuleConfig(moduleConfigOf(config)) };
}

/**
 * The SDK browser harness with the node config served the way the Go node serves it: plugin.getConfig answers one
 * ModuleConfig on raw "config". A plain object goes to the SDK host (hostOptions.config, which encodes it with
 * encodeModuleConfig); a function (a config that changes between invokes) is answered at the hostcall import with the
 * same encoding. Either way every hostcall's operation is recorded on harness.hostCalls.
 */
export async function createTypedHarness({ wasmSource, manifest, config = {}, surface = "direct", createBrowserModuleHarness }) {
  const calls = [];
  const dynamic = typeof config === "function";
  const instantiate = WebAssembly.instantiate;
  WebAssembly.instantiate = async (module, imports) => {
    let memory, own = null;
    const host = imports.space_data_module_host;
    const wrapped = host
      ? { ...imports, space_data_module_host: { ...host,
          call: (opPtr, opLen, ptr, len) => {
            const call = decodeHostCall(new Uint8Array(memory.buffer, ptr, len).slice());
            calls.push(call.op);
            if (!dynamic) { own = null; return host.call(opPtr, opLen, ptr, len); }
            own = call.op === "plugin.getConfig"
              ? encodeHostCallResult({ ok: true, op: call.op, raw: { config: encodeModuleConfig(moduleConfigOf(config())) } })
              : encodeHostCallResult({ ok: false, op: call.op, error: { code: "unsupported", message: `unexpected hostcall ${call.op}` } });
            return 0;
          },
          response_len: () => (own ? own.length : host.response_len()),
          read_response: (dst, n) => {
            if (!own) return host.read_response(dst, n);
            const k = Math.min(n, own.length);
            new Uint8Array(memory.buffer, dst, k).set(own.subarray(0, k));
            return k;
          },
        } }
      : imports;
    const instance = await instantiate(module, wrapped);
    memory = (instance.instance ?? instance).exports.memory;
    return instance;
  };
  let harness;
  try {
    harness = await createBrowserModuleHarness({
      wasmSource,
      manifest,
      surface,
      ...(dynamic ? {} : { hostOptions: { config: moduleConfigOf(config) } }),
    });
  } finally {
    WebAssembly.instantiate = instantiate;
  }
  harness.hostCalls = calls;
  return harness;
}

/** hostcap/flatsql-query's answer to one query: the record stream as $FSB chunks plus one $FSO status. */
export function storeAnswer(stream, { status = "COMPLETE", errorCode = "", chunkBytes = 1024 * 1024 } = {}) {
  const { FSB, flatSqlByteStreamKind } = FSB_LIB;
  const { FSO, flatSqlNodeStatus, flatSqlNodeOperation } = FSO_LIB;
  const bytes = Uint8Array.from(stream ?? []);
  const frames = [];
  if (status === "COMPLETE") {
    const count = bytes.length === 0 ? 1 : Math.ceil(bytes.length / chunkBytes);
    for (let i = 0; i < count; i++) {
      const b = new flatbuffers.Builder(1024 + chunkBytes);
      const part = bytes.subarray(i * chunkBytes, Math.min(bytes.length, (i + 1) * chunkBytes));
      const data = part.length ? FSB.createDataVector(b, part) : 0;
      FSB.startFSB(b);
      FSB.addKind(b, flatSqlByteStreamKind.QUERY_RESULT);
      FSB.addChunkSequence(b, i);
      FSB.addFinal(b, i === count - 1);
      FSB.addTotalBytes(b, BigInt(bytes.length));
      if (data) FSB.addData(b, data);
      FSB.finishFSBBuffer(b, FSB.endFSB(b));
      frames.push({ portId: "records", typeRef: TYPE.FSB, payload: b.asUint8Array().slice() });
    }
  }
  const b = new flatbuffers.Builder(256);
  const code = errorCode ? b.createString(errorCode) : 0;
  FSO.startFSO(b);
  FSO.addOperation(b, flatSqlNodeOperation.QUERY_RECORDS);
  FSO.addStatus(b, flatSqlNodeStatus[status]);
  if (code) FSO.addErrorCode(b, code);
  FSO.finishFSOBuffer(b, FSO.endFSO(b));
  frames.push({ portId: "status", typeRef: TYPE.FSO, payload: b.asUint8Array().slice() });
  return frames;
}

/** An $FSO query frame decoded: the SQL text and its tagged parameters. */
export function decodeFsoQuery(bytes) {
  const { FSO } = FSO_LIB;
  const fso = FSO.getRootAsFSO(new flatbuffers.ByteBuffer(Uint8Array.from(bytes)));
  const sql = new TextDecoder().decode(fso.queryArray() ?? new Uint8Array(0));
  const raw = Buffer.from(fso.parametersArray() ?? new Uint8Array(0));
  const params = [];
  for (let at = 0; at < raw.length;) {
    const tag = raw[at], size = raw.readUInt32LE(at + 1);
    const v = raw.subarray(at + 5, at + 5 + size);
    params.push(tag === 4 ? { t: "str", v: v.toString("utf8") } : tag === 2 ? { t: "i64", v: Number(v.readBigInt64LE(0)) } : { t: tag, v });
    at += 5 + size;
  }
  assert.equal(params.length, fso.PARAMETER_COUNT());
  return { sql, params, operation: fso.OPERATION() };
}

const ID_TYPES = { $DTT: TYPE.DTT, MCFG: TYPE.MCFG, HRSP: TYPE.HRSP, $HTQ: TYPE.HTQ, $FSO: TYPE.FSO, $FSB: TYPE.FSB };
/** The type reference a frame's bytes declare (file identifier at 4, or at 8 behind a size prefix). */
export function typeRefOf(bytes) {
  const id = (at) => (bytes.length >= at + 4 ? Buffer.from(bytes.subarray(at, at + 4)).toString("latin1") : "");
  return ID_TYPES[id(4)] ?? ID_TYPES[id(8)] ?? { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: bytes.byteLength };
}
/** One input frame typed by its own bytes. */
export function typedInput(portId, payload) {
  const bytes = typeof payload === "string" ? new TextEncoder().encode(payload) : Uint8Array.from(payload);
  return { portId, typeRef: typeRefOf(bytes), payload: bytes };
}
/**
 * The lane's test inputs on the typed wire: a plan object -> the $DTT header stream (+ options); bytes -> a frame typed
 * by its identifier. Returns a frame or an array of frames (callers flatten).
 */
export function input(portId, value) {
  if (value instanceof Uint8Array || typeof value === "string") return typedInput(portId, value);
  if (portId === "plan" && value && typeof value === "object") return planInputs(value);
  throw new Error(`no typed frame for ${portId}`);
}

/** harness.invoke with the inputs flattened (input() answers a plan as two frames). */
export const invokeTyped = (harness, request) => harness.invoke({ ...request, inputs: (request.inputs ?? []).flat() });

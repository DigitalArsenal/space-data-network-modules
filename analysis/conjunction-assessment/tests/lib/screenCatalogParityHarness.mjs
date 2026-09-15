// =============================================================================
// A2.8b — shared pure-node screen_catalog parity driver
// =============================================================================
//
// Drives the conjunction-assessment module's FlatBuffer `screen_catalog`
// methodId directly against the primary canonical WASM
// (dist/isomorphic/module.wasm) via the SDK browser harness +
// SDS PIV envelope — NO WasmEdge, NO network. This is the CI-viable path: the
// same raw plugin_invoke_stream ABI the passing pivInvokeContract.test.mjs uses.
//
// Request/catalog/result buffers are (de)serialized with flatc-wasm (pure JS),
// exactly like tests/sdnDataApiStream.test.mjs. Both A2.8b lane suites
// (SOCRATES OMM catalog + Aerospace OCM track catalog) build on this.
//
// Lock: analysis/conjunction-assessment/** (A2.8b-harness). Read-only vs the
// CA module C++ (src/cpp/**) — the harness needs no module change.
// =============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createRequire } from "node:module";
import * as flatbuffers from "flatbuffers";

import { FlatcRunner } from "flatc-wasm";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

import { cqrSchema, publishedSchema, encodeCqr, decodeCqr, catalogRequest, catalogInReferenceUnits } from './cqr.mjs';
import { relVelStratum } from "./caParityTolerances.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "..", "..");
const SDS_ROOT = path.dirname(createRequire(import.meta.url).resolve("spacedatastandards.org/package.json"));
const PRIMARY_WASM_PATH = path.join(
  PACKAGE_ROOT,
  "dist",
  "isomorphic",
  "module.wasm",
);

// Resolve published SDS bindings independently of checkout layout.
import { bufferMutability } from "spacedatastandards.org/lib/js/PIV/bufferMutability.js";
import { bufferOwnership } from "spacedatastandards.org/lib/js/PIV/bufferOwnership.js";
import { FlatBufferTypeRefT } from "spacedatastandards.org/lib/js/PIV/FlatBufferTypeRef.js";
import { payloadWireFormat } from "spacedatastandards.org/lib/js/PIV/payloadWireFormat.js";
import { PIV, PIVT } from "spacedatastandards.org/lib/js/PIV/PIV.js";
import { PIVRequestT } from "spacedatastandards.org/lib/js/PIV/PIVRequest.js";
import { TABT } from "spacedatastandards.org/lib/js/PIV/TAB.js";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

// --- artifact / module load -------------------------------------------------

export function primaryArtifactExists() {
  return fs.existsSync(PRIMARY_WASM_PATH);
}

export async function loadRawConjunctionModule() {
  const wasmBinary = await fs.promises.readFile(PRIMARY_WASM_PATH);
  const harness = await createBrowserModuleHarness({ wasmSource: wasmBinary, surface: 'direct', enableThreads: true });
  return { ...(harness.instance?.exports ?? harness.exports), memory: harness.memory, destroy: harness.destroy };
}

export async function initFlatc() {
  return FlatcRunner.init();
}

// --- flatc schema descriptors ----------------------------------------------

function readText(relFromPackage) {
  return fs.readFileSync(path.join(PACKAGE_ROOT, relFromPackage), "utf8");
}
function readSdsSchema(rel) {
  return fs.readFileSync(path.join(SDS_ROOT, "schema", rel), "utf8");
}

const screenCatalogRequestSchema = cqrSchema;
const screenCatalogResultSchema = cqrSchema;
const ommSchema = () => publishedSchema('OMM');

// --- OMM catalog (SGP4 mean-element) builder --------------------------------

// Accepts a CelesTrak/SDS GP record (schema-exact keys) and produces the SDS
// $OMM FlatBuffer used by the screen_catalog `catalog` port.
export function ommRecordFromGp(flatc, gp) {
  return flatc.generateBinary(
    ommSchema(),
    JSON.stringify({
      CENTER_NAME: "EARTH",
      REFERENCE_FRAME: { REFERENCE_FRAME_type: "CelestialFrameWrapper", REFERENCE_FRAME: { frame: "TEMEOFDATE" } },
      TIME_SYSTEM: "UTC",
      OBJECT_NAME: gp.OBJECT_NAME ?? `NORAD-${gp.NORAD_CAT_ID}`,
      OBJECT_ID: gp.OBJECT_ID ?? "",
      EPOCH: gp.EPOCH,
      MEAN_MOTION: Number(gp.MEAN_MOTION),
      ECCENTRICITY: Number(gp.ECCENTRICITY),
      INCLINATION: Number(gp.INCLINATION),
      RA_OF_ASC_NODE: Number(gp.RA_OF_ASC_NODE),
      ARG_OF_PERICENTER: Number(gp.ARG_OF_PERICENTER),
      MEAN_ANOMALY: Number(gp.MEAN_ANOMALY),
      EPHEMERIS_TYPE: "SGP4",
      CLASSIFICATION_TYPE: gp.CLASSIFICATION_TYPE ?? "U",
      NORAD_CAT_ID: Number(gp.NORAD_CAT_ID),
      ELEMENT_SET_NO: Number(gp.ELEMENT_SET_NO ?? 999),
      REV_AT_EPOCH: Number(gp.REV_AT_EPOCH ?? 0),
      BSTAR: Number(gp.BSTAR ?? 0),
      MEAN_MOTION_DOT: Number(gp.MEAN_MOTION_DOT ?? 0),
      MEAN_MOTION_DDOT: Number(gp.MEAN_MOTION_DDOT ?? 0),
    }),
    { sizePrefix: false },
  );
}

// uint32be length-prefixed OMM stream (the "SDN data API" catalog wire format).
export function frameUint32beStream(records) {
  const total = records.reduce((sum, r) => sum + 4 + r.length, 0);
  const stream = new Uint8Array(total);
  const view = new DataView(stream.buffer);
  let offset = 0;
  for (const record of records) {
    view.setUint32(offset, record.length, false);
    offset += 4;
    stream.set(record, offset);
    offset += record.length;
  }
  return stream;
}

export function buildOmmCatalogFrame(flatc, gpRecords) {
  return gpRecords.map((gp) => ommRecordFromGp(flatc, gp));
}

// --- screen_catalog request builder ----------------------------------------

export function buildScreenCatalogRequest(flatc, options = {}) {
  return encodeCqr(flatc, catalogRequest(options));
}

// --- raw PIV invoke ---------------------------------------------------------

function alignOffset(offset, alignment) {
  const remainder = offset % alignment;
  return remainder === 0 ? offset : offset + alignment - remainder;
}

function encodeInvoke(methodId, inputs) {
  const arena = [];
  const frames = inputs.map((input) => {
    const payload = input.bytes;
    const alignment = 8;
    const offset = alignOffset(arena.length, alignment);
    while (arena.length < offset) arena.push(0);
    for (const byte of payload) arena.push(byte);
    const id = String.fromCharCode(...payload.subarray(4,8));
    const code = id.startsWith("$") ? id.slice(1) : null;
    const typeRef = new FlatBufferTypeRefT(input.schemaName ?? (code ? `${code}.fbs` : null), code ? id : null, null, code);
    const frame = new TABT(
      offset,
      payload.length,
      alignment,
      payloadWireFormat.FLATBUFFER,
      typeRef,
      bufferMutability.IMMUTABLE,
      bufferOwnership.HOST_OWNED,
      0n,
    );
    frame.PORT_ID = input.portId;
    return frame;
  });
  const builder = new flatbuffers.Builder(1024);
  PIV.finishPIVBuffer(
    builder,
    new PIVT(new PIVRequestT(methodId, frames, arena, 0n, 0), null).pack(builder),
  );
  return builder.asUint8Array();
}

// Low-level: invoke any methodId with named FlatBuffer input frames.
export function invokeRaw(exports, methodId, inputs) {
  const requestBytes = encodeInvoke(methodId, inputs);
  const requestPtr = exports.plugin_alloc(requestBytes.length);
  const sizePtr = exports.plugin_alloc(4);
  new Uint8Array(exports.memory.buffer).set(requestBytes, requestPtr);
  new DataView(exports.memory.buffer).setUint32(sizePtr, 0, true);
  const responsePtr = exports.plugin_invoke_stream(
    requestPtr,
    requestBytes.length,
    sizePtr,
  );
  const responseSize = new DataView(exports.memory.buffer).getUint32(sizePtr, true);
  const responseBytes = new Uint8Array(
    new Uint8Array(exports.memory.buffer).slice(responsePtr, responsePtr + responseSize),
  );
  const envelope = PIV.getRootAsPIV(
    new flatbuffers.ByteBuffer(responseBytes),
  ).unpack();
  exports.plugin_free(responsePtr, 0);
  exports.plugin_free(requestPtr, requestBytes.length);
  exports.plugin_free(sizePtr, 4);
  const outputs = envelope.RESPONSE.OUTPUTS.map((frame) => ({
    portId: frame.PORT_ID,
    payload: new Uint8Array(
      envelope.RESPONSE.PAYLOAD_ARENA.slice(frame.OFFSET, frame.OFFSET + frame.SIZE),
    ),
  }));
  return {
    statusCode: envelope.RESPONSE.STATUS_CODE,
    errorMessage: envelope.RESPONSE.ERROR_MESSAGE,
    outputs,
  };
}

// High-level: run screen_catalog and decode the CASS result.
export function runScreenCatalog(exports, flatc, { requestBinary, catalogBinary }) {
  const inputs = [{ portId: "request", bytes: requestBinary }];
  if (catalogBinary) {
    for (const bytes of Array.isArray(catalogBinary) ? catalogBinary : [catalogBinary]) inputs.push({ portId: "catalog", bytes });
  }
  const response = invokeRaw(exports, "screen_catalog", inputs);
  if (response.statusCode !== 0) {
    throw new Error(
      `screen_catalog failed (status ${response.statusCode}): ${response.errorMessage || "unknown"}`,
    );
  }
  const result = response.outputs.find((o) => o.portId === "result");
  if (!result?.payload?.byteLength) {
    throw new Error("screen_catalog returned no result payload.");
  }
  return catalogInReferenceUnits(decodeCqr(flatc, result.payload).CATALOG_RESULT);
}

// --- comparison / stratification -------------------------------------------

export function isoToJd(iso) {
  const millis = Date.parse(String(iso ?? "").trim());
  return Number.isFinite(millis) ? millis / 86400000 + 2440587.5 : Number.NaN;
}

function pairKey(a, b) {
  return [Number(a), Number(b)].sort((x, y) => x - y).join("-");
}

function probabilityRatio(actual, expected) {
  const a = Number(actual);
  const e = Number(expected);
  if (a === 0 && e === 0) return 1;
  if (!(a > 0) || !(e > 0)) return Number.POSITIVE_INFINITY;
  return Math.max(a / e, e / a);
}

// Match a decoded screen_catalog result against a reference event list.
// referenceEvents: [{ obj1Norad, obj2Norad, tcaJd, missKm, relSpeedKms, pc? }]
// Returns { matched:[{stratum, deltas, event, reference}], missing:[...ref],
//           extra:[...event], counts }.
export function compareToReference(decoded, referenceEvents) {
  const found = new Map();
  for (const event of decoded.conjunctions ?? []) {
    found.set(pairKey(event.obj1Norad, event.obj2Norad), event);
  }
  const matched = [];
  const missing = [];
  const usedKeys = new Set();
  for (const reference of referenceEvents) {
    const key = pairKey(reference.obj1Norad, reference.obj2Norad);
    const event = found.get(key);
    if (!event) {
      missing.push(reference);
      continue;
    }
    usedKeys.add(key);
    const tcaDeltaSec = Math.abs(Number(event.tcaJd) - Number(reference.tcaJd)) * 86400.0;
    const missDeltaM = Math.abs(Number(event.minRangeKm) - Number(reference.missKm)) * 1000.0;
    const relSpeedDeltaMS =
      reference.relSpeedKms == null
        ? null
        : Math.abs(Number(event.relSpeedKms) - Number(reference.relSpeedKms)) * 1000.0;
    matched.push({
      key,
      stratum: relVelStratum(event.relSpeedKms),
      event,
      reference,
      deltas: {
        tcaDeltaSec,
        missDeltaM,
        relSpeedDeltaMS,
        pcRatio: reference.pc == null ? null : probabilityRatio(event.maxProbability, reference.pc),
      },
    });
  }
  const extra = [];
  for (const [key, event] of found) {
    if (!usedKeys.has(key)) extra.push(event);
  }
  return {
    matched,
    missing,
    extra,
    counts: {
      referenceCount: referenceEvents.length,
      foundCount: decoded.conjunctions?.length ?? 0,
      matchedCount: matched.length,
      missingCount: missing.length,
      extraCount: extra.length,
      objectsParsed: decoded.objectsParsed ?? 0,
    },
  };
}

export { PACKAGE_ROOT, SDS_ROOT, PRIMARY_WASM_PATH };

// =============================================================================
// A2.8b — shared pure-node screen_catalog parity driver
// =============================================================================
//
// Drives the conjunction-assessment module's FlatBuffer `screen_catalog`
// methodId directly against the checked-in singlethread WASM
// (dist/isomorphic-singlethread/module.wasm) via a raw WebAssembly instance +
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
import { fileURLToPath, pathToFileURL } from "node:url";

import { FlatcRunner } from "flatc-wasm";

import { relVelStratum } from "./caParityTolerances.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "..", "..");
const MAIN_PACKAGES_ROOT = path.resolve(PACKAGE_ROOT, "..", "..", "..");
const SDS_ROOT = path.join(MAIN_PACKAGES_ROOT, "spacedatastandards.org");
const SINGLETHREAD_WASM_PATH = path.join(
  PACKAGE_ROOT,
  "dist",
  "isomorphic-singlethread",
  "module.wasm",
);

// PIV codec + flatbuffers are loaded from the sibling spacedatastandards.org
// checkout (same source pivInvokeContract.test.mjs uses). Dynamic import keeps
// the relative-depth math out of static specifiers.
const flatbuffers = await import(
  pathToFileURL(
    path.join(SDS_ROOT, "node_modules", "flatbuffers", "mjs", "flatbuffers.js"),
  ).href
);
const {
  bufferMutability,
  bufferOwnership,
  FlatBufferTypeRefT,
  payloadWireFormat,
  PIV,
  PIVRequestT,
  PIVT,
  TABT,
} = await import(pathToFileURL(path.join(SDS_ROOT, "lib", "js", "PIV", "main.js")).href);

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

// --- artifact / module load -------------------------------------------------

export function singlethreadArtifactExists() {
  return fs.existsSync(SINGLETHREAD_WASM_PATH);
}

export async function loadRawConjunctionModule() {
  const wasmBinary = await fs.promises.readFile(SINGLETHREAD_WASM_PATH);
  const imports = {
    wasi_snapshot_preview1: new Proxy({}, { get: () => () => 0 }),
  };
  const { instance } = await WebAssembly.instantiate(wasmBinary, imports);
  instance.exports.__wasm_call_ctors?.();
  return instance.exports;
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

function screenCatalogRequestSchema() {
  return {
    entry: "/schemas/ConjunctionScreenCatalogRequest.fbs",
    files: {
      "/schemas/ConjunctionScreenCatalogRequest.fbs": readText(
        "schemas/ConjunctionScreenCatalogRequest.fbs",
      ),
      "/schemas/ConjunctionCommon.fbs": readText("schemas/ConjunctionCommon.fbs"),
    },
  };
}
function screenCatalogResultSchema() {
  return {
    entry: "/schemas/ConjunctionScreenCatalogResult.fbs",
    files: {
      "/schemas/ConjunctionScreenCatalogResult.fbs": readText(
        "schemas/ConjunctionScreenCatalogResult.fbs",
      ),
      "/schemas/ConjunctionCommon.fbs": readText("schemas/ConjunctionCommon.fbs"),
    },
  };
}
function ommSchema() {
  return {
    entry: "/sds/OMM/main.fbs",
    files: {
      "/sds/OMM/main.fbs": readSdsSchema("OMM/main.fbs"),
      "/sds/RFM/main.fbs": readSdsSchema("RFM/main.fbs"),
      "/sds/TIM/main.fbs": readSdsSchema("TIM/main.fbs"),
      "/sds/MET/main.fbs": readSdsSchema("MET/main.fbs"),
    },
  };
}

// --- OMM catalog (SGP4 mean-element) builder --------------------------------

// Accepts a CelesTrak/SDS GP record (schema-exact keys) and produces the SDS
// $OMM FlatBuffer used by the screen_catalog `catalog` port.
export function ommRecordFromGp(flatc, gp) {
  return flatc.generateBinary(
    ommSchema(),
    JSON.stringify({
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
  return frameUint32beStream(gpRecords.map((gp) => ommRecordFromGp(flatc, gp)));
}

// --- screen_catalog request builder ----------------------------------------

export function buildScreenCatalogRequest(flatc, options = {}) {
  const payload = {
    selectedSources: options.selectedSources ?? [
      {
        sourceKind: options.sourceKind ?? "OMM",
        sourceId: options.sourceId ?? "a2.8b-parity",
        providerId: options.providerId ?? "parity-harness",
        schemaName: options.schemaName ?? "OMM/main.fbs",
        fileIdentifier: options.fileIdentifier ?? "$OMM",
      },
    ],
    startJd: options.startJd,
    durationDays: options.durationDays,
    thresholdKm: options.thresholdKm,
    numThreads: options.numThreads ?? 1,
    coarseStepSec: options.coarseStepSec ?? 60.0,
    fineTolSec: options.fineTolSec ?? 0.001,
    combinedRadiusM: options.combinedRadiusM ?? 10.0,
    useKdTree: options.useKdTree ?? true,
    useDynamicWindow: options.useDynamicWindow ?? true,
    usePerigeeFilter: options.usePerigeeFilter ?? true,
  };
  if (Array.isArray(options.primaryTracks)) {
    payload.primaryTracks = options.primaryTracks;
  }
  if (Array.isArray(options.secondaryTracks)) {
    payload.secondaryTracks = options.secondaryTracks;
  }
  if (Array.isArray(options.primaryGps)) {
    payload.primaryGps = options.primaryGps;
  }
  if (Array.isArray(options.secondaryGps)) {
    payload.secondaryGps = options.secondaryGps;
  }
  return flatc.generateBinary(
    screenCatalogRequestSchema(),
    JSON.stringify(payload),
    { sizePrefix: false },
  );
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
    const typeRef = new FlatBufferTypeRefT(input.schemaName ?? null, null, null, null);
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
    inputs.push({ portId: "catalog", bytes: catalogBinary });
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
  return JSON.parse(
    flatc.generateJSON(
      screenCatalogResultSchema(),
      { path: "/result.bin", data: result.payload },
      { defaultsJson: true },
    ),
  );
}

// --- JSON operation path (version probe etc.) -------------------------------

export function invokeJsonOperation(exports, operation, params = {}) {
  const response = invokeRaw(exports, "invoke", [
    {
      portId: "request",
      bytes: textEncoder.encode(JSON.stringify({ operation, params })),
      schemaName: "application/json",
    },
  ]);
  const out = response.outputs.find((o) => o.portId === "response");
  return {
    statusCode: response.statusCode,
    json: out ? JSON.parse(textDecoder.decode(out.payload)) : null,
  };
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

export { PACKAGE_ROOT, SDS_ROOT, SINGLETHREAD_WASM_PATH };

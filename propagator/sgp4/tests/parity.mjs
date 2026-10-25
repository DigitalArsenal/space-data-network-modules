// Tri-runtime parity: the same artifact and the same invoke bytes in Chrome,
// native WasmEdge and Docker WasmEdge must give byte-identical outputs.
//   PATH="$HOME/.wasmedge/bin:$PATH" node tests/parity.mjs
//
// The harness runs every case as one command invocation in a fresh instance,
// so each case carries its element sets on the omm port (propagate_state and
// propagate_ephemeris ingest them first, as ingest_omm does).
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { normalizeParityFixture, runParityHarness, formatParityReport } from "space-data-module-sdk/testing";

import {
  ReferenceFrame,
  encodeCatPayload,
  encodeLegacyPropagatorBatchRequest,
  encodeOmmPayload,
  encodeRecWithCat,
  encodePropagatorBatchRequest,
  encodeSizePrefixedStream,
  SYNTHETIC_SSO,
} from "./lib/payloadEncoders.mjs";

const wasmPath = fileURLToPath(new URL("../dist/isomorphic/module.wasm", import.meta.url));
const OMM_TYPE = { schemaName: "orbpro.sds.omm", fileIdentifier: "$OMM", rootTypeName: "OMM" };
const CAT_TYPE = { schemaName: "orbpro.sds.cat", fileIdentifier: "$CAT", rootTypeName: "CAT" };
const REC_TYPE = { schemaName: "orbpro.sds.rec", fileIdentifier: "$REC", rootTypeName: "REC" };
const PROP_TYPE = { schemaName: "orbpro.propagator.PropagatorBatchRequest", fileIdentifier: "PROP", rootTypeName: "PropagatorBatchRequest" };
const VALLADO = JSON.parse(fs.readFileSync(new URL("../../../analysis/epoch-state/tests/vallado-verification.json", import.meta.url), "utf8")).cases;
const HISTORY = [0, 1, 2, 3, 4].map((k) => ({
  epoch: new Date(Date.UTC(2024, 0, 1, 6 * k)).toISOString().replace(/\.000Z$/, ""),
  meanAnomaly: (173.4281 + 47 * k) % 360,
  raan: 21.5245 - 0.3 * k,
}));
const vallado = VALLADO.map((c) => encodeOmmPayload({
  noradId: c.satnum, objectId: c.entityId, objectName: `SGP4-VER ${c.satnum}`, epoch: c.epochIso,
  meanMotion: c.MEAN_MOTION, eccentricity: c.ECCENTRICITY, inclination: c.INCLINATION, raan: c.RA_OF_ASC_NODE,
  argPericenter: c.ARG_OF_PERICENTER, meanAnomaly: c.MEAN_ANOMALY, bstar: c.BSTAR, meanMotionDot: 0, meanMotionDdot: 0,
}));

const hex = (payload) => Buffer.from(payload).toString("hex");
const omm = (payloads) => ({ portId: "omm", typeRef: OMM_TYPE, payloadHex: hex(encodeSizePrefixedStream(payloads)) });
const cat = (payload) => ({ portId: "catalog", typeRef: CAT_TYPE, payloadHex: hex(payload) });
const rec = (payload) => ({ portId: "records", typeRef: REC_TYPE, payloadHex: hex(payload) });
const request = (payload) => ({ portId: "request", typeRef: PROP_TYPE, payloadHex: hex(payload) });
const invoke = (methodId, inputs, outputStreamCap = 0) => ({ methodId, inputs, outputStreamCap });

const cases = [
  { id: "ingest-omm", request: invoke("ingest_omm", [omm(vallado)]) },
  { id: "propagate-state-earth-fixed-1.1.0-request", request: invoke("propagate_state",
    [request(encodeLegacyPropagatorBatchRequest({ epoch: 2460310.75, entityHandles: [0, 1] })), omm([encodeOmmPayload(), encodeOmmPayload(SYNTHETIC_SSO)])], 2) },
  { id: "propagate-state-teme-by-catalog-number", request: invoke("propagate_state",
    [request(encodePropagatorBatchRequest({ epoch: 2453912.0, catalogNumbers: [11801, 5, 14128], outputFrame: ReferenceFrame.TEME })), omm(vallado)], 3) },
  { id: "propagate-state-gcrf-by-catalog-number", request: invoke("propagate_state",
    [request(encodePropagatorBatchRequest({ epoch: 2453912.0, catalogNumbers: [11801, 5, 14128, 28057], outputFrame: ReferenceFrame.ICRF })), omm(vallado)], 4) },
  { id: "propagate-ephemeris-element-sets-gcrf", request: invoke("propagate_ephemeris",
    [request(encodePropagatorBatchRequest({ epoch: 0, catalogNumbers: [25544], outputFrame: ReferenceFrame.ICRF, stepSeconds: 600, elementSetBlocks: true })),
      omm(HISTORY.map((s) => encodeOmmPayload(s)))], 1) },
  { id: "propagate-ephemeris-span-teme", request: invoke("propagate_ephemeris",
    [request(encodePropagatorBatchRequest({ epoch: 2460310.6, stopEpoch: 2460310.7, catalogNumbers: [99002], outputFrame: ReferenceFrame.TEME, stepSeconds: 60 })),
      omm([encodeOmmPayload(), encodeOmmPayload(SYNTHETIC_SSO)])], 1) },
  // `$CAT` records are stored as FlatBuffers: a direct `$CAT` verbatim, one
  // carried in a `$REC` re-finished as its own `$CAT`.
  { id: "upsert-cat-direct", request: invoke("upsert_cat",
    [cat(encodeCatPayload({ noradId: 99002, objectName: "CAT DIRECT", objectId: "2024-001A" }))]) },
  { id: "upsert-cat-rec", request: invoke("upsert_cat",
    [rec(encodeRecWithCat(encodeCatPayload({ noradId: 99002, objectName: "CAT REC", objectId: "2024-001A" })))]) },
  // A multi-record `$REC` shares one vtable among its CAT tables.
  { id: "upsert-cat-rec-shared-vtable", request: invoke("upsert_cat",
    [rec(encodeRecWithCat(...[1, 2, 3].map((k) => encodeCatPayload({ noradId: 99000 + k, objectName: `CAT REC ${k}`, objectId: "2024-001A" }))))]) },
  // The provider's own SATCAT frames (size-prefixed, each finished behind its
  // prefix): 97 records the SpaceAware console read over SDN on 2026-10-24.
  { id: "upsert-cat-provider-size-prefixed-stream", request: invoke("upsert_cat",
    [cat(fs.readFileSync(new URL("./fixtures/celestrak-satcat-csv-97.cat", import.meta.url)))]) },
  { id: "refuse-handle-mismatch", request: invoke("propagate_state",
    [request(encodePropagatorBatchRequest({ epoch: 2460310.75, entityHandles: [0], catalogNumbers: [99002] })), omm([encodeOmmPayload(), encodeOmmPayload(SYNTHETIC_SSO)])], 1) },
  { id: "refuse-unknown-object", request: invoke("propagate_ephemeris",
    [request(encodePropagatorBatchRequest({ epoch: 0, catalogNumbers: [99999], outputFrame: ReferenceFrame.TEME, stepSeconds: 60, elementSetBlocks: true })), omm([encodeOmmPayload()])], 1) },
];

const plan = await normalizeParityFixture({ name: "propagator/sgp4", threadEnvVar: "SDM_WORKER_COUNT", threadCounts: [1], cases });
// SDM_PARITY_LANES narrows the lanes (comma-separated SDK lane names), for a
// box without Docker; the report names the lanes that ran.
const lanes = process.env.SDM_PARITY_LANES?.split(",").filter(Boolean);
const report = await runParityHarness({ wasmPath, plan, lanes, timeoutMs: 120000, log: console.log });
console.log(formatParityReport(report));
const summary = { ...report, wasmPath: "dist/isomorphic/module.wasm" };
fs.mkdirSync(new URL("../conformance/", import.meta.url), { recursive: true });
fs.writeFileSync(new URL("../conformance/parity.json", import.meta.url), `${JSON.stringify(summary, null, 2)}\n`);
assert.equal(report.ok, true, JSON.stringify(report.failures));

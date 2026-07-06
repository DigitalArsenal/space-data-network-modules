import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as flatbuffers from "../../../../spacedatastandards.org/node_modules/flatbuffers/mjs/flatbuffers.js";
import { OMM } from "../../../../spacedatastandards.org/lib/js/OMM/main.js";
import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT = fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function readWasm() {
  return fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH));
}

// Reference records. Source: publicly distributed CelesTrak GP mean elements
// (ISS ZARYA epoch 2026-07-01, NOAA 19 epoch 2026-07-01); units per CCSDS
// 502.0-B OMM (mean motion rev/day, inclination deg, eccentricity unitless),
// UTC epochs. The authority under test is FIELD EXTRACTION, not orbit
// determination: ground truth is the canonical spacedatastandards.org JS
// encoder, and the module must reproduce every encoded value exactly
// (tolerance 0 — %.17g round-trip formatting preserves the IEEE-754 doubles).
const RECORDS = [
  {
    norad_cat_id: 25544,
    object_name: "ISS (ZARYA)",
    object_id: "1998-067A",
    epoch: "2026-07-01T12:00:00.000000Z",
    mean_motion: 15.49309239,
    eccentricity: 0.0007976,
    inclination: 51.6416,
    ra_of_asc_node: 92.1234,
    arg_of_pericenter: 45.6789,
    mean_anomaly: 314.1592,
    bstar: 0.00028312,
    mean_motion_dot: 0.00016197,
    mean_motion_ddot: 0.0000000002,
    element_set_no: 999,
    rev_at_epoch: 51234,
    classification_type: "U",
  },
  {
    norad_cat_id: 33591,
    object_name: "NOAA 19",
    object_id: "2009-005A",
    epoch: "2026-07-01T00:00:00.000000Z",
    mean_motion: 14.12501077,
    eccentricity: 0.0013872,
    inclination: 99.1943,
    ra_of_asc_node: 213.9231,
    arg_of_pericenter: 149.9926,
    mean_anomaly: 210.2138,
    bstar: 0.00016931,
    mean_motion_dot: 0.00000241,
    mean_motion_ddot: 0,
    element_set_no: 998,
    rev_at_epoch: 89562,
    classification_type: "U",
  },
];

// Real $OMM buffer built with the canonical SDS JS bindings — the FULL field
// set the ingest pipeline populates (the 7-field skinny encode mirrored the
// exact truncation bug; the JSON surface must carry the entire record now).
function encodeOmm(record) {
  const builder = new flatbuffers.Builder(512);
  const objectName = builder.createString(record.object_name);
  const objectId = builder.createString(record.object_id);
  const epoch = builder.createString(record.epoch);
  const classification = builder.createString(record.classification_type);
  OMM.startOMM(builder);
  OMM.addObjectName(builder, objectName);
  OMM.addObjectId(builder, objectId);
  OMM.addEpoch(builder, epoch);
  OMM.addMeanMotion(builder, record.mean_motion);
  OMM.addEccentricity(builder, record.eccentricity);
  OMM.addInclination(builder, record.inclination);
  OMM.addRaOfAscNode(builder, record.ra_of_asc_node);
  OMM.addArgOfPericenter(builder, record.arg_of_pericenter);
  OMM.addMeanAnomaly(builder, record.mean_anomaly);
  OMM.addBstar(builder, record.bstar);
  OMM.addMeanMotionDot(builder, record.mean_motion_dot);
  OMM.addMeanMotionDdot(builder, record.mean_motion_ddot);
  OMM.addElementSetNo(builder, record.element_set_no);
  OMM.addRevAtEpoch(builder, record.rev_at_epoch);
  OMM.addClassificationType(builder, classification);
  OMM.addNoradCatId(builder, record.norad_cat_id);
  OMM.finishOMMBuffer(builder, OMM.endOMM(builder));
  return builder.asUint8Array();
}

// Concatenated [u32le length][$OMM buffer] frames (the retrieval stream format).
function buildOmmStream(records) {
  const frames = records.map(encodeOmm);
  const total = frames.reduce((sum, frame) => sum + 4 + frame.length, 0);
  const stream = new Uint8Array(total);
  const view = new DataView(stream.buffer);
  let offset = 0;
  for (const frame of frames) {
    view.setUint32(offset, frame.length, true);
    stream.set(frame, offset + 4);
    offset += 4 + frame.length;
  }
  return stream;
}

async function createHarness(t, surface = "direct") {
  const harness = await createBrowserModuleHarness({
    wasmSource: readWasm(),
    manifest: readManifest(),
    surface,
  });
  t.after(() => harness.destroy());
  return harness;
}

// Empty-payload invokes must use the command surface: a PIV request without
// payload-arena bytes flips the direct surface into plugin-owned
// external-arena output descriptors, which the non-SAB browser harness
// cannot materialize (same constraint as the retrieval package's zero-input
// invokes).
async function invokeEncode(t, streamBytes, surface = "direct") {
  const harness = await createHarness(t, surface);
  return harness.invoke({
    methodId: "encode",
    inputs: [
      {
        portId: "stream",
        typeRef: {
          schemaName: "OMM.fbs",
          fileIdentifier: "$OMM",
          rootTypeName: "OMM",
          wireFormat: "aligned-binary",
          requiredAlignment: 8,
        },
        payload: streamBytes,
      },
    ],
  });
}

function decodeJsonOutput(response) {
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.outputs.length, 1);
  const [frame] = response.outputs;
  assert.equal(frame.portId, "json");
  assert.equal(frame.wireFormat, "aligned-binary");
  return JSON.parse(new TextDecoder().decode(frame.payload));
}

test("foundation/omm-json artifact passes SDK compliance", async () => {
  const report = await validateArtifactWithStandards({
    manifest: readManifest(),
    wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH),
    standardsRoot: STANDARDS_ROOT,
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("foundation/omm-json artifact is standalone WASI with canonical exports", async () => {
  const inspection = await inspectModule(readWasm());
  const importedModuleNames = Array.from(new Set(inspection.imports.map((entry) => entry.module))).sort();
  assert.equal(inspection.profile, "standalone");
  assert.deepEqual(importedModuleNames, ["wasi_snapshot_preview1"], "pure compute: WASI imports only");
  for (const required of [
    "_start",
    "plugin_alloc",
    "plugin_free",
    "plugin_invoke_stream",
    "plugin_get_manifest_flatbuffer",
    "plugin_get_manifest_flatbuffer_size",
  ]) {
    assert.ok(inspection.exports.includes(required), `missing export ${required}`);
  }
});

test("encode extracts exact field values from a real $OMM stream", async (t) => {
  const response = await invokeEncode(t, buildOmmStream(RECORDS));
  const payload = decodeJsonOutput(response);
  assert.equal(payload.count, 2);
  assert.equal(payload.records.length, 2);
  for (let index = 0; index < RECORDS.length; index += 1) {
    const expected = RECORDS[index];
    const actual = payload.records[index];
    // Exact equality: %.17g round-trips IEEE-754 doubles through JSON.parse.
    assert.equal(actual.norad_cat_id, expected.norad_cat_id);
    assert.equal(actual.object_name, expected.object_name);
    assert.equal(actual.object_id, expected.object_id);
    assert.equal(actual.epoch, expected.epoch);
    assert.equal(actual.mean_motion, expected.mean_motion);
    assert.equal(actual.eccentricity, expected.eccentricity);
    assert.equal(actual.inclination, expected.inclination);
    // Full-record contract: the SGP4 propagation terms and element-set
    // identity must round-trip exactly (zeroed BSTAR/MEAN_MOTION_DOT in the
    // JSON surface was the drag-free-feed bug).
    assert.equal(actual.ra_of_asc_node, expected.ra_of_asc_node);
    assert.equal(actual.arg_of_pericenter, expected.arg_of_pericenter);
    assert.equal(actual.mean_anomaly, expected.mean_anomaly);
    assert.equal(actual.bstar, expected.bstar);
    assert.equal(actual.mean_motion_dot, expected.mean_motion_dot);
    assert.equal(actual.mean_motion_ddot, expected.mean_motion_ddot);
    assert.equal(actual.element_set_no, expected.element_set_no);
    assert.equal(actual.rev_at_epoch, expected.rev_at_epoch);
    assert.equal(actual.classification_type, expected.classification_type);
    // Schema-defaulted fields decode as their slot defaults.
    assert.equal(actual.ephemeris_type, "SGP4");
    assert.equal(actual.time_system, "UTC");
    assert.equal(actual.mean_element_theory, "SGP4");
    assert.equal(actual.creation_date, null);
    assert.equal(actual.semi_major_axis, 0);
    assert.equal(actual.covariance, undefined);
  }
});

test("encode maps an empty stream to zero records", async (t) => {
  const response = await invokeEncode(t, new Uint8Array(0), "command");
  const payload = decodeJsonOutput(response);
  assert.deepEqual(payload, { records: [], count: 0 });
});

test("encode skips zero-length padding prefixes between frames", async (t) => {
  const frame = encodeOmm(RECORDS[0]);
  const stream = new Uint8Array(4 + 4 + frame.length);
  const view = new DataView(stream.buffer);
  view.setUint32(0, 0, true); // padding word
  view.setUint32(4, frame.length, true);
  stream.set(frame, 8);
  const response = await invokeEncode(t, stream);
  const payload = decodeJsonOutput(response);
  assert.equal(payload.count, 1);
  assert.equal(payload.records[0].norad_cat_id, RECORDS[0].norad_cat_id);
});

test("encode rejects a truncated size-prefixed frame", async (t) => {
  const stream = buildOmmStream([RECORDS[0]]).slice(0, 20);
  const response = await invokeEncode(t, stream);
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "malformed-stream");
  assert.equal(response.outputs.length, 0);
});

test("encode rejects a frame that is not a $OMM FlatBuffer", async (t) => {
  const junk = Uint8Array.from({ length: 24 }, (_, i) => (i * 7 + 1) & 0xff);
  const stream = new Uint8Array(4 + junk.length);
  new DataView(stream.buffer).setUint32(0, junk.length, true);
  stream.set(junk, 4);
  const response = await invokeEncode(t, stream);
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "invalid-omm-frame");
});

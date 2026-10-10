// propagate_ephemeris (1.2.0): one SDS $OEM per object, the input contract of
// analysis/maneuver-detection detect_maneuvers (its README: one data block per
// element set, Earth-centred inertial axes, UTC, each block spanning its
// neighbouring sets' epochs).
//
// Reference for every state: the same element set alone in a fresh module,
// answered by propagate_state (TEME or GCRF) at the line's epoch. The line
// epochs are printed to the microsecond and read back as Julian-date doubles
// (about 40 us of resolution), so a state can sit up to ~50 us from its
// reference: 0.4 m and 0.5 mm/s at 7.7 km/s and 9 m/s^2 (limits 1 m, 1e-3 m/s).
// The ISS element sets below are illustrative (not a physical history): the
// contract does not depend on their consistency.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createBrowserModuleHarness } from "space-data-module-sdk/host/browser-module";

import { invokePiv, loadRawSgp4Module } from "./lib/pivInvokeHelper.mjs";
import {
  ReferenceFrame,
  decodeOem,
  decodePropagatorState,
  encodeOmmPayload,
  encodePropagatorBatchRequest,
  encodeSizePrefixedStream,
} from "./lib/payloadEncoders.mjs";

const OMM_TYPE = { schemaName: "orbpro.sds.omm", fileIdentifier: "$OMM", rootTypeName: "OMM" };
const PROP_TYPE = { schemaName: "orbpro.propagator.PropagatorBatchRequest", fileIdentifier: "PROP", rootTypeName: "PropagatorBatchRequest" };
const UTC = 11;           // SDS timingStandard.UTC
const TEMEOFDATE = 5;     // SDS CelestialFrame
const GCRF = 0;
const STEP = 600;
const HOUR = 3600;

// Five element sets, six hours apart.
const SETS = [0, 1, 2, 3, 4].map((k) => ({
  epoch: new Date(Date.UTC(2024, 0, 1, 6 * k)).toISOString().replace(/\.000Z$/, ""),
  meanAnomaly: (173.4281 + 47 * k) % 360,
  raan: 21.5245 - 0.3 * k,
}));
// UTC Julian date of an ISO time with up to microseconds (Date.parse keeps
// only milliseconds).
function jdOf(iso) {
  const [whole, fraction = ""] = iso.replace(/Z$/, "").split(".");
  return 2440587.5 + (Date.parse(`${whole}Z`) + Number(`0.${fraction || "0"}`) * 1000) / 86400000;
}
const sub = (a, b) => a.map((x, i) => x - b[i]);
const norm = (a) => Math.hypot(...a);

function ingest(module, sets) {
  const result = invokePiv(module, { methodId: "ingest_omm", inputs: [{ portId: "omm", typeRef: OMM_TYPE,
    payload: encodeSizePrefixedStream(sets.map((s) => encodeOmmPayload(s))) }] });
  assert.equal(result.response.STATUS_CODE, 0, result.response.ERROR_MESSAGE);
}
function ephemeris(module, request) {
  return invokePiv(module, { methodId: "propagate_ephemeris", outputStreamCap: 4,
    inputs: [{ portId: "request", typeRef: PROP_TYPE, payload: encodePropagatorBatchRequest({ epoch: 0, catalogNumbers: [25544], stepSeconds: STEP, ...request }) }] });
}

// The states of one element set alone at the given epochs.
async function reference(set, epochs, outputFrame) {
  const module = await loadRawSgp4Module();
  try {
    ingest(module, [set]);
    return epochs.map((epoch) => {
      const result = invokePiv(module, { methodId: "propagate_state", outputStreamCap: 1,
        inputs: [{ portId: "request", typeRef: PROP_TYPE, payload: encodePropagatorBatchRequest({ epoch, catalogNumbers: [25544], outputFrame }) }] });
      assert.equal(result.response.STATUS_CODE, 0, result.response.ERROR_MESSAGE);
      return decodePropagatorState(result.outputPayloads[0].bytes);
    });
  } finally {
    module._plugin_destroy();
  }
}

for (const [label, outputFrame, frameCode] of [["TEME", ReferenceFrame.TEME, TEMEOFDATE], ["GCRF", ReferenceFrame.ICRF, GCRF]]) {
  test(`element-set blocks in ${label}: one per set, spanning two sets each side, each from its own set`, async () => {
    const module = await loadRawSgp4Module();
    try {
      ingest(module, SETS);
      const result = ephemeris(module, { outputFrame, elementSetBlocks: true, neighbourSets: 2 });
      assert.equal(result.response.STATUS_CODE, 0, result.response.ERROR_MESSAGE);
      assert.equal(result.outputPayloads.length, 1);
      const out = result.outputPayloads[0];
      assert.equal(out.portId, "ephemeris");
      assert.equal(out.typeRef.fileIdentifier, "$OEM");
      const oem = decodeOem(out.bytes);
      assert.equal(oem.EPHEMERIS_DATA_BLOCK.length, SETS.length);
      for (const [i, block] of oem.EPHEMERIS_DATA_BLOCK.entries()) {
        assert.equal(block.OBJECT.NORAD_CAT_ID, 25544);
        assert.equal(block.OBJECT.OBJECT_ID, "1998-067A");
        assert.equal(block.CENTER_NAME, "EARTH");
        assert.equal(block.TIME_SYSTEM, UTC);
        assert.equal(block.REFERENCE_FRAME.REFERENCE_FRAME.frame, frameCode);
        assert.match(block.COMMENT, new RegExp(`^Element set ${SETS[i].epoch}`));
        // Span: from the set two before to the set two after (clamped).
        const first = SETS[Math.max(0, i - 2)].epoch, last = SETS[Math.min(SETS.length - 1, i + 2)].epoch;
        assert.equal(block.START_TIME, `${first}.000000Z`);
        assert.equal(block.STOP_TIME, `${last}.000000Z`);
        const lines = block.EPHEMERIS_DATA_LINES;
        assert.equal(lines.length, (jdOf(last) - jdOf(first)) * 86400 / STEP + 1);
        const expected = await reference(SETS[i], lines.map((l) => jdOf(l.EPOCH)), outputFrame);
        lines.forEach((line, k) => {
          const position = [line.X, line.Y, line.Z].map((x) => x * 1000), velocity = [line.X_DOT, line.Y_DOT, line.Z_DOT].map((x) => x * 1000);
          assert.ok(norm(sub(position, expected[k].position)) < 1, `block ${i} line ${k}: position`);
          assert.ok(norm(sub(velocity, expected[k].velocity)) < 1e-3, `block ${i} line ${k}: velocity`);
        });
      }
    } finally {
      module._plugin_destroy();
    }
  });
}

test("one block over a span follows the entity's own set selection; refusals", async () => {
  const module = await loadRawSgp4Module();
  try {
    ingest(module, SETS);
    // Inside the hours where SETS[1] is the nearest set (its midpoints with
    // the neighbours are 3 h away), so both answers use the same set.
    const from = jdOf(SETS[1].epoch) - 2 * HOUR / 86400, to = from + 4 * HOUR / 86400;
    const result = ephemeris(module, { outputFrame: ReferenceFrame.TEME, epoch: from, stopEpoch: to });
    assert.equal(result.response.STATUS_CODE, 0, result.response.ERROR_MESSAGE);
    const [block] = decodeOem(result.outputPayloads[0].bytes).EPHEMERIS_DATA_BLOCK;
    assert.equal(block.EPHEMERIS_DATA_LINES.length, 4 * HOUR / STEP + 1);
    for (const line of block.EPHEMERIS_DATA_LINES) {
      const state = decodePropagatorState(invokePiv(module, { methodId: "propagate_state", outputStreamCap: 1,
        inputs: [{ portId: "request", typeRef: PROP_TYPE, payload: encodePropagatorBatchRequest({ epoch: jdOf(line.EPOCH), catalogNumbers: [25544], outputFrame: ReferenceFrame.TEME }) }] }).outputPayloads[0].bytes);
      assert.ok(norm(sub([line.X, line.Y, line.Z].map((x) => x * 1000), state.position)) < 1);
    }
    for (const [request, code] of [
      [{ outputFrame: ReferenceFrame.ECEF, elementSetBlocks: true }, "unsupported-frame"],
      [{ outputFrame: ReferenceFrame.TEME, elementSetBlocks: true, stepSeconds: 0 }, "invalid-input"],
      [{ outputFrame: ReferenceFrame.TEME, epoch: to, stopEpoch: from }, "invalid-input"],
      [{ outputFrame: ReferenceFrame.TEME, elementSetBlocks: true, catalogNumbers: [99999] }, "unknown-object"],
    ]) {
      const refused = ephemeris(module, request);
      assert.equal(refused.response.STATUS_CODE, 400);
      assert.equal(refused.response.ERROR_CODE, code);
    }
  } finally {
    module._plugin_destroy();
  }
});

test("analysis/maneuver-detection reads the $OEM as its ephemerides", async () => {
  const module = await loadRawSgp4Module();
  let oem;
  try {
    ingest(module, SETS);
    oem = ephemeris(module, { outputFrame: ReferenceFrame.TEME, elementSetBlocks: true, stepSeconds: 60 }).outputPayloads[0].bytes;
  } finally {
    module._plugin_destroy();
  }
  const dir = new URL("../../../analysis/maneuver-detection/", import.meta.url);
  const detector = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(new URL("dist/isomorphic/module.wasm", dir)),
    manifest: JSON.parse(fs.readFileSync(new URL("plugin-manifest.json", dir))), surface: "direct" });
  try {
    // median_sets 2: a step test over five sets (2 * 2 + 1).
    const result = await detector.invoke({ methodId: "detect_maneuvers", inputs: [
      { portId: "ephemerides", payload: oem, typeRef: { schemaName: "OEM.fbs", fileIdentifier: "$OEM", rootTypeName: "OEM", wireFormat: "flatbuffer" } },
      { portId: "options", payload: Buffer.from(JSON.stringify({ median_sets: 2 })) },
    ] });
    assert.equal(result.statusCode, 0, result.errorMessage);
    const report = JSON.parse(Buffer.from(result.outputs.find((o) => o.portId === "report").payload).toString("utf8"));
    assert.equal(report.objects_screened, 1);
    assert.equal(report.objects[0].object, "1998-067A");
    assert.equal(report.objects[0].frame, "TEMEOFDATE");
    assert.equal(report.objects[0].element_sets, SETS.length);
    assert.equal(report.objects[0].pairs.length, SETS.length - 1);
  } finally {
    detector.destroy?.();
  }
});

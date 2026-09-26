import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as flatbuffers from "flatbuffers";
import { MPE, meanElementSource } from "spacedatastandards.org/lib/js/MPE/main.js";
import { OEM, CelestialFrame, RFMUnion, timingStandard } from "spacedatastandards.org/lib/js/OEM/main.js";
import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT = fileURLToPath(new URL("../node_modules/spacedatastandards.org/", import.meta.url));

// Vallado's SGP4 verification set (SGP4-VER.TLE, tcppver.out t=0 rows):
// near-Earth, drag-heavy, 12 h and 24 h resonant, and deep-space eccentric
// cases. GCRF expectations were computed independently with pyerfa, and
// agree with astropy's TEME -> GCRS to within 0.7 m for the 2000s epochs and
// 2.5 m for 1980 (the difference between the IAU 1980 and 2000A equation of
// the equinoxes, and EOP), which confirms the frame orientation.
const FIXTURE = JSON.parse(fs.readFileSync(new URL("./vallado-verification.json", import.meta.url), "utf8"));

const manifest = () => JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
const wasm = () => fs.readFileSync(fileURLToPath(WASM_PATH));

function encodeMpe(record) {
  const builder = new flatbuffers.Builder(256);
  const entityId = record.entityId === undefined ? 0 : builder.createString(record.entityId);
  MPE.startMPE(builder);
  if (entityId) MPE.addEntityId(builder, entityId);
  MPE.addEpoch(builder, record.epochUnix);
  MPE.addMeanMotion(builder, record.MEAN_MOTION);
  MPE.addEccentricity(builder, record.ECCENTRICITY);
  MPE.addInclination(builder, record.INCLINATION);
  MPE.addRaOfAscNode(builder, record.RA_OF_ASC_NODE);
  MPE.addArgOfPericenter(builder, record.ARG_OF_PERICENTER);
  MPE.addMeanAnomaly(builder, record.MEAN_ANOMALY);
  MPE.addBstar(builder, record.BSTAR);
  MPE.addMeanElementTheory(builder, record.theory ?? meanElementSource.SGP4);
  MPE.finishSizePrefixedMPEBuffer(builder, MPE.endMPE(builder));
  return builder.asUint8Array();
}

// Size-prefixed buffers concatenated, each padded to 8 bytes with a
// zero-length prefix.
function stream(records) {
  const frames = records.map(encodeMpe);
  const padded = frames.map((frame) => frame.length + ((8 - (frame.length % 8)) % 8));
  const bytes = new Uint8Array(padded.reduce((a, b) => a + b, 0));
  let offset = 0;
  frames.forEach((frame, i) => {
    bytes.set(frame, offset);
    offset += padded[i];
  });
  return bytes;
}

async function derive(t, records) {
  const harness = await createBrowserModuleHarness({ wasmSource: wasm(), manifest: manifest(), surface: "direct" });
  t.after(() => harness.destroy());
  const payload = stream(records);
  const response = await harness.invoke({
    methodId: "derive",
    inputs: [
      {
        portId: "elements",
        typeRef: {
          schemaName: "MPE.fbs",
          fileIdentifier: "$MPE",
          rootTypeName: "MPE",
          wireFormat: "aligned-binary",
          requiredAlignment: 8,
          byteLength: payload.byteLength,
        },
        payload,
      },
    ],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  const reportFrame = response.outputs.find((frame) => frame.portId === "report");
  const statesFrame = response.outputs.find((frame) => frame.portId === "states");
  return {
    report: JSON.parse(new TextDecoder().decode(reportFrame.payload)),
    statesBytes: statesFrame ? statesFrame.payload : new Uint8Array(),
    states: statesFrame ? decodeStates(statesFrame.payload) : [],
  };
}

function decodeStates(bytes) {
  const states = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset < bytes.length) {
    const size = view.getUint32(offset, true);
    if (size === 0) {
      offset += 4;
      continue;
    }
    const frame = bytes.slice(offset, offset + 4 + size);
    states.push(OEM.getSizePrefixedRootAsOEM(new flatbuffers.ByteBuffer(frame)).unpack());
    offset += 4 + size;
  }
  return states;
}

const magnitude = (v) => Math.hypot(v[0], v[1], v[2]);
const distance = (a, b) => magnitude([a[0] - b[0], a[1] - b[1], a[2] - b[2]]);

test("artifact passes SDK compliance and is standalone WASI", async () => {
  const report = await validateArtifactWithStandards({
    manifest: manifest(),
    wasmPath: fileURLToPath(WASM_PATH),
    standardsRoot: STANDARDS_ROOT,
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
  const inspection = await inspectModule(wasm());
  assert.equal(inspection.profile, "standalone");
  assert.deepEqual([...new Set(inspection.imports.map((entry) => entry.module))], ["wasi_snapshot_preview1"]);
});

test("GCRF epoch states reproduce the Vallado verification set", async (t) => {
  const { report, states } = await derive(t, FIXTURE.cases);
  assert.equal(report.derived, FIXTURE.cases.length);
  assert.equal(report.failed, 0);
  assert.equal(states.length, FIXTURE.cases.length);
  FIXTURE.cases.forEach((expected, i) => {
    const block = states[i].EPHEMERIS_DATA_BLOCK[0];
    const [line] = block.EPHEMERIS_DATA_LINES;
    const r = [line.X, line.Y, line.Z];
    const v = [line.X_DOT, line.Y_DOT, line.Z_DOT];
    // tcppver.out prints 1e-8 km and 1e-9 km/s.
    assert.ok(distance(r, expected.gcrfR) < 5e-8, `${expected.satnum} position ${distance(r, expected.gcrfR)} km`);
    assert.ok(distance(v, expected.gcrfV) < 5e-9, `${expected.satnum} velocity ${distance(v, expected.gcrfV)} km/s`);
    // A rotation preserves |r|: SGP4 itself matches the Vallado TEME state.
    assert.ok(Math.abs(magnitude(r) - magnitude(expected.temeR)) < 5e-8);
  });
  assert.ok(report.maxRoundTripPositionKm < 1e-8);
});

test("each OEM is one GCRF row with the parent identity and lineage", async (t) => {
  const { states } = await derive(t, FIXTURE.cases);
  FIXTURE.cases.forEach((expected, i) => {
    const oem = states[i];
    assert.equal(oem.CCSDS_OEM_VERS, 3);
    assert.equal(oem.ORIGINATOR, "SDN epoch-state");
    assert.equal(oem.CREATION_DATE, null, "output depends only on input bytes");
    assert.equal(oem.EPHEMERIS_DATA_BLOCK.length, 1);
    const block = oem.EPHEMERIS_DATA_BLOCK[0];
    assert.equal(block.OBJECT.OBJECT_ID, expected.entityId);
    assert.equal(block.OBJECT.NORAD_CAT_ID, expected.entityId.startsWith("NORAD:") ? expected.satnum : 0);
    assert.equal(block.CENTER_NAME, "EARTH");
    assert.equal(block.CENTER_NAIF_ID, 399);
    assert.equal(block.REFERENCE_FRAME.REFERENCE_FRAME_type, RFMUnion.CelestialFrameWrapper);
    assert.equal(block.REFERENCE_FRAME.REFERENCE_FRAME.frame, CelestialFrame.GCRF);
    assert.equal(block.TIME_SYSTEM, timingStandard.UTC);
    for (const field of ["START_TIME", "STOP_TIME", "USEABLE_START_TIME", "USEABLE_STOP_TIME"]) {
      assert.equal(block[field], expected.epochIso);
    }
    assert.equal(block.EPHEMERIS_DATA_LINES.length, 1);
    assert.equal(block.EPHEMERIS_DATA_LINES[0].EPOCH, expected.epochIso);
    assert.match(block.COMMENT, new RegExp(`ENTITY_ID=${expected.entityId} EPOCH=${expected.epochIso}`));
    assert.match(block.COMMENT, /WGS-72 constants, opsmode i, zero elapsed time/);
    assert.match(block.COMMENT, /Initial-condition uncertainty: unknown/);
  });
});

test("output is byte-identical across invocations", async (t) => {
  const first = await derive(t, FIXTURE.cases);
  const second = await derive(t, FIXTURE.cases);
  assert.deepEqual(Buffer.from(second.statesBytes), Buffer.from(first.statesBytes));
});

test("refused element sets are reported by index and produce no OEM", async (t) => {
  const good = FIXTURE.cases[0];
  const { report, states } = await derive(t, [
    { ...good, theory: meanElementSource.SGP4XP },
    { ...good, ECCENTRICITY: 1.2 },
    { ...good, entityId: undefined },
    { ...good, MEAN_MOTION: 0 },
    good,
  ]);
  assert.equal(report.records, 5);
  assert.equal(report.derived, 1);
  assert.equal(report.failed, 4);
  assert.deepEqual(
    report.failures.map(({ index, reason }) => [index, reason]),
    [
      [0, "mean-element-theory-not-sgp4:SGP4XP"],
      [1, "sgp4-init"],
      [2, "missing-entity-id"],
      [3, "non-positive-mean-motion"],
    ],
  );
  assert.equal(report.failures[1].sgp4Error, 1);
  assert.equal(states.length, 1);
  assert.equal(states[0].EPHEMERIS_DATA_BLOCK[0].OBJECT.OBJECT_ID, good.entityId);
});

test("an epoch before UTC existed is derived and counted", async (t) => {
  // Vanguard 1, 1959-01-01T00:00:00Z: ERFA reports a dubious year and takes
  // TAI-UTC as zero, which moves TEME -> GCRF by ~1e-11 rad.
  const vanguard = { ...FIXTURE.cases[0], epochUnix: -347155200 };
  const { report, states } = await derive(t, [vanguard]);
  assert.equal(report.derived, 1);
  assert.equal(report.epochsOutsideLeapSecondTable, 1);
  assert.equal(states[0].EPHEMERIS_DATA_BLOCK[0].START_TIME, "1959-01-01T00:00:00.000000Z");
  assert.match(states[0].EPHEMERIS_DATA_BLOCK[0].COMMENT, /outside the ERFA leap-second table/);
});

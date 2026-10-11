import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as flatbuffers from "flatbuffers";
import { OMM } from "spacedatastandards.org/lib/js/OMM/main.js";
import { meanElementSource } from "spacedatastandards.org/lib/js/MPE/main.js";
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
import { FIXTURE, jsonFrame, mpeStream, mpeType, ommStream, ommType } from "./fixtures.mjs";

const manifest = () => JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
const wasm = () => fs.readFileSync(fileURLToPath(WASM_PATH));

async function derive(t, records) {
  const harness = await createBrowserModuleHarness({ wasmSource: wasm(), manifest: manifest(), surface: "direct" });
  t.after(() => harness.destroy());
  const payload = mpeStream(records);
  const response = await harness.invoke({
    methodId: "derive",
    inputs: [{ portId: "elements", typeRef: mpeType(payload.byteLength), payload }],
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

// ── derive_omm, ages, and the propagator query port ──────────────────────────
// Expected values come from tests/ages-reference.json (python-sgp4 2.27 and pyerfa 2.0.1.5, written by
// tests/ages-reference.py): they do not come from this module.
const AGES = JSON.parse(fs.readFileSync(new URL("./ages-reference.json", import.meta.url), "utf8"));

async function invokeMethod(t, methodId, inputs) {
  const harness = await createBrowserModuleHarness({ wasmSource: wasm(), manifest: manifest(), surface: "direct" });
  t.after(() => harness.destroy());
  return harness.invoke({ methodId, inputs });
}

test("derive_omm: OMM element sets at the epoch plus ages match python-sgp4 and pyerfa", async (t) => {
  const payload = ommStream(FIXTURE.cases);
  const response = await invokeMethod(t, "derive_omm", [
    { portId: "omm", payload, typeRef: ommType },
    jsonFrame("options", { ages: [0, 0.5, 1, 3] }),
  ]);
  assert.equal(response.statusCode, 0, response.errorMessage);
  const report = JSON.parse(new TextDecoder().decode(response.outputs.find((f) => f.portId === "report").payload));
  assert.equal(report.derived, FIXTURE.cases.length);
  assert.equal(report.failed, 0);
  assert.equal(report.rows, FIXTURE.cases.length * 4);
  assert.deepEqual(report.agesDays, [0, 0.5, 1, 3]);
  const states = decodeStates(response.outputs.find((f) => f.portId === "states").payload);
  assert.equal(states.length, FIXTURE.cases.length);
  FIXTURE.cases.forEach((expected, i) => {
    const block = states[i].EPHEMERIS_DATA_BLOCK[0];
    // The object is what the $OMM names: a numbered object by NORAD number, else its international designator.
    assert.equal(block.OBJECT.NORAD_CAT_ID, expected.entityId.startsWith("NORAD:") ? expected.satnum : 0);
    assert.equal(block.OBJECT.OBJECT_ID, expected.entityId);
    assert.equal(block.OBJECT.OBJECT_NAME, `VALLADO ${expected.satnum}`);
    assert.equal(block.EPHEMERIS_DATA_LINES.length, 4);
    assert.equal(block.START_TIME, expected.epochIso);
    // Age 0 is the Vallado epoch state; later ages are python-sgp4's propagation, rotated by pyerfa.
    const [first, ...later] = block.EPHEMERIS_DATA_LINES;
    assert.ok(distance([first.X, first.Y, first.Z], expected.gcrfR) < 5e-8, `${expected.satnum} age 0 position`);
    const reference = AGES.cases.find((c) => c.satnum === expected.satnum);
    later.forEach((line, k) => {
      const row = reference.rows[k];
      assert.equal(line.EPOCH, row.epochIso, `${expected.satnum} row epoch`);
      // Pure-Python and C++ SGP4 agree to ~1e-9 km at three days; 1e-6 km (1 mm) leaves room for the two ERFA builds.
      assert.ok(distance([line.X, line.Y, line.Z], row.gcrfR) < 1e-6, `${expected.satnum} age ${row.ageDays} d position ${distance([line.X, line.Y, line.Z], row.gcrfR)} km`);
      assert.ok(distance([line.X_DOT, line.Y_DOT, line.Z_DOT], row.gcrfV) < 1e-9, `${expected.satnum} age ${row.ageDays} d velocity`);
    });
    assert.match(block.COMMENT, /evaluated at the epoch plus the ages \{0, 0\.5, 1, 3\} days/);
  });
});

test("derive_omm refuses what it cannot derive and names the object it did", async (t) => {
  const good = FIXTURE.cases[1];
  const response = await invokeMethod(t, "derive_omm", [
    {
      portId: "omm",
      payload: ommStream([good, good, good, good], (_, i) => [{ MEAN_ELEMENT_THEORY: meanElementSource.SGP4XP }, { OBJECT_ID: "", NORAD_CAT_ID: 0, OBJECT_NAME: "" }, { EPOCH: "not a time" }, {}][i]),
      typeRef: ommType,
    },
  ]);
  assert.equal(response.statusCode, 0, response.errorMessage);
  const report = JSON.parse(new TextDecoder().decode(response.outputs.find((f) => f.portId === "report").payload));
  assert.deepEqual(report.failures.map(({ index, reason }) => [index, reason]), [
    [0, "mean-element-theory-not-sgp4:SGP4XP"],
    [1, "missing-object-identity"],
    [2, "invalid-epoch"],
  ]);
  assert.equal(report.derived, 1);
});

test("answer_propagation_requests: the TEME trajectory of a set matches python-sgp4; refused sets are answered REFUSED; sets and options are forwarded", async (t) => {
  const trajectory = AGES.trajectory;
  const sets = FIXTURE.cases.filter((c) => c.satnum === trajectory.satnum || c.satnum === 5);
  const index = sets.findIndex((c) => c.satnum === trajectory.satnum);
  const first = trajectory.samples[0].epochIso, last = trajectory.samples.at(-1).epochIso;
  const requests = {
    status: "needs-propagation",
    queries: [
      { sequence: 0, object: `NORAD:${trajectory.satnum}`, norad: 0, object_id: sets[index].entityId, set: index, epoch: first, start: first, stop: last, step_s: trajectory.stepSeconds },
      { sequence: 1, object: "NORAD:5", norad: 0, object_id: sets[1 - index].entityId, set: 1 - index, epoch: first, start: first, stop: last, step_s: trajectory.stepSeconds },
    ],
  };
  const options = { neighbour_sets: 2, propagator_port_id: "sgp4" };
  const response = await invokeMethod(t, "answer_propagation_requests", [
    jsonFrame("requests", requests),
    { portId: "element_sets", payload: ommStream(sets, (_, i) => (i === 1 - index ? { MEAN_ELEMENT_THEORY: meanElementSource.SGP4XP } : {})), typeRef: ommType },
    jsonFrame("options", options),
  ]);
  assert.equal(response.statusCode, 0, response.errorMessage);
  const answers = decodeStates(response.outputs.find((f) => f.portId === "propagation").payload);
  assert.equal(answers.length, 2);
  const block = answers[0].EPHEMERIS_DATA_BLOCK[0];
  assert.equal(block.CENTER_NAME, "EARTH");
  assert.equal(block.TIME_SYSTEM, timingStandard.UTC);
  assert.equal(block.REFERENCE_FRAME.REFERENCE_FRAME.frame, CelestialFrame.TEMEOFDATE);
  assert.equal(block.STEP_SIZE, trajectory.stepSeconds);
  assert.equal(block.START_TIME, first);
  assert.equal(block.STOP_TIME, last);
  assert.equal(block.EPHEMERIS_DATA.length, 6 * trajectory.samples.length);
  trajectory.samples.forEach((sample, k) => {
    const r = block.EPHEMERIS_DATA.slice(6 * k, 6 * k + 3);
    const v = block.EPHEMERIS_DATA.slice(6 * k + 3, 6 * k + 6);
    assert.ok(distance(r, sample.temeR) < 1e-6, `sample ${k} position ${distance(r, sample.temeR)} km`);
    assert.ok(distance(v, sample.temeV) < 1e-9, `sample ${k} velocity`);
  });
  // SGP4-XP is not SGP4: the query is answered with an empty block that says why.
  const refused = answers[1].EPHEMERIS_DATA_BLOCK[0];
  assert.match(refused.COMMENT, /^REFUSED mean-element-theory-not-sgp4:SGP4XP/);
  assert.equal(refused.EPHEMERIS_DATA.length, 0);
  // The second pass sees exactly what the first saw.
  const forwarded = response.outputs.filter((f) => f.portId === "element_sets").map((f) => Buffer.from(f.payload));
  assert.deepEqual(Buffer.concat(forwarded), ommStream(sets, (_, i) => (i === 1 - index ? { MEAN_ELEMENT_THEORY: meanElementSource.SGP4XP } : {})));
  assert.deepEqual(JSON.parse(new TextDecoder().decode(response.outputs.find((f) => f.portId === "options").payload)), options);
  const report = JSON.parse(new TextDecoder().decode(response.outputs.find((f) => f.portId === "report").payload));
  assert.deepEqual([report.queries, report.answered, report.refused], [2, 1, 1]);
});

test("omm_from_mpe: the archive's element sets become $OMM that derive_omm reads to the states derive gave", async (t) => {
  const payload = mpeStream(FIXTURE.cases);
  const converted = await invokeMethod(t, "omm_from_mpe", [{ portId: "mpe", payload, typeRef: mpeType(payload.byteLength) }]);
  assert.equal(converted.statusCode, 0, converted.errorMessage);
  const report = JSON.parse(new TextDecoder().decode(converted.outputs.find((f) => f.portId === "report").payload));
  assert.deepEqual([report.records, report.converted, report.failed], [FIXTURE.cases.length, FIXTURE.cases.length, 0]);
  const stream = Buffer.from(converted.outputs.find((f) => f.portId === "omm").payload);
  // Each $OMM: the entity id is the NORAD number or the object's designator; the elements are the archive's.
  let at = 0;
  FIXTURE.cases.forEach((expected) => {
    const size = stream.readUInt32LE(at);
    const omm = OMM.getSizePrefixedRootAsOMM(new flatbuffers.ByteBuffer(new Uint8Array(stream.subarray(at, at + 4 + size)))).unpack();
    at += 4 + size;
    assert.equal(omm.NORAD_CAT_ID, expected.entityId.startsWith("NORAD:") ? expected.satnum : 0);
    assert.equal(omm.OBJECT_ID, expected.entityId.startsWith("NORAD:") ? null : expected.entityId);
    assert.equal(omm.EPOCH, expected.epochIso.replace("Z", ""));
    assert.equal(omm.MEAN_MOTION, expected.MEAN_MOTION);
    assert.equal(omm.ECCENTRICITY, expected.ECCENTRICITY);
    assert.equal(omm.BSTAR, expected.BSTAR);
    assert.equal(omm.MEAN_ELEMENT_THEORY, meanElementSource.SGP4);
    assert.equal(omm.ORIGINATOR, null);
  });
  assert.equal(at, stream.length);
  // The states from the converted sets are the Vallado GCRF states derive gave from the archive's own records.
  const states = await invokeMethod(t, "derive_omm", [{ portId: "omm", payload: stream, typeRef: ommType }]);
  assert.equal(states.statusCode, 0, states.errorMessage);
  const rows = decodeStates(states.outputs.find((f) => f.portId === "states").payload);
  FIXTURE.cases.forEach((expected, i) => {
    const [line] = rows[i].EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES;
    assert.ok(distance([line.X, line.Y, line.Z], expected.gcrfR) < 5e-8, `${expected.satnum} position`);
  });
  const refused = await invokeMethod(t, "omm_from_mpe", [{ portId: "mpe", payload: mpeStream([{ ...FIXTURE.cases[0], entityId: undefined }, FIXTURE.cases[1]]), typeRef: mpeType(mpeStream([{ ...FIXTURE.cases[0], entityId: undefined }, FIXTURE.cases[1]]).byteLength) }]);
  const refusedReport = JSON.parse(new TextDecoder().decode(refused.outputs.find((f) => f.portId === "report").payload));
  assert.deepEqual(refusedReport.failures.map(({ index, reason }) => [index, reason]), [[0, "missing-entity-id"]]);
  assert.equal(refusedReport.converted, 1);
});

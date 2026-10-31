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
import { decodeFlowNotice } from "space-data-module-sdk/runtime-contracts";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT = process.env.SPACE_DATA_STANDARDS_ROOT ?? fileURLToPath(new URL("../node_modules/spacedatastandards.org/", import.meta.url));

// Vallado's SGP4 verification set (SGP4-VER.TLE, tcppver.out t=0 rows):
// near-Earth, drag-heavy, 12 h and 24 h resonant, and deep-space eccentric
// cases. GCRF expectations were computed independently with pyerfa, and
// agree with astropy's TEME -> GCRS to within 0.7 m for the 2000s epochs and
// 2.5 m for 1980 (the difference between the IAU 1980 and 2000A equation of
// the equinoxes, and EOP), which confirms the frame orientation.
import { FIXTURE, decodePrw, encodePrw, mpeStream, mpeType, ommStream, ommType, prwType, utc, windowRequest } from "./fixtures.mjs";

const manifest = () => JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
const wasm = () => fs.readFileSync(fileURLToPath(WASM_PATH));
// The node config (plugin.getConfig, one ModuleConfig) the harness host serves.
const harnessFor = (config = {}) =>
  createBrowserModuleHarness({ wasmSource: wasm(), manifest: manifest(), surface: "direct", hostOptions: { config } });

// The FlowNotice report: its ITEMS "key=value" counts as numbers, its "failure ..." items as objects.
function noticeReport(frame) {
  const notice = decodeFlowNotice(frame.payload);
  const report = { notice, failures: [] };
  for (const item of notice.items) {
    if (item.startsWith("failure ")) {
      const failure = Object.fromEntries(item.slice(8).split(" ").map((kv) => kv.split("=")));
      report.failures.push({ ...failure, index: Number(failure.index), ...(failure.sgp4_error !== undefined && { sgp4_error: Number(failure.sgp4_error) }) });
    } else {
      const [key, value] = item.split("=");
      report[key] = key === "ages_days" ? value.split(",").map(Number) : Number(value);
    }
  }
  return report;
}

async function derive(t, records, config) {
  const harness = await harnessFor(config);
  t.after(() => harness.destroy());
  const payload = mpeStream(records);
  const response = await harness.invoke({
    methodId: "derive",
    inputs: [{ portId: "elements", typeRef: mpeType(), payload }],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  const reportFrame = response.outputs.find((frame) => frame.portId === "report");
  const statesFrame = response.outputs.find((frame) => frame.portId === "states");
  return {
    report: noticeReport(reportFrame),
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

test("artifact passes SDK compliance; WASI plus the hostcall bridge", async () => {
  const report = await validateArtifactWithStandards({
    manifest: manifest(),
    wasmPath: fileURLToPath(WASM_PATH),
    standardsRoot: STANDARDS_ROOT,
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
  const inspection = await inspectModule(wasm());
  assert.equal(inspection.profile, "module-host-abi");
  // WASI plus the sync hostcall bridge for plugin.getConfig (the ages).
  assert.deepEqual([...new Set(inspection.imports.map((entry) => entry.module))].sort(), ["space_data_module_host", "wasi_snapshot_preview1"]);
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
    // A rotation preserves |r|: SGP4 itself matches the verification set's TEME state.
    assert.ok(Math.abs(magnitude(r) - magnitude(expected.temeR)) < 5e-8);
  });
  assert.ok(report.max_round_trip_position_km < 1e-8);
  assert.equal(report.notice.kind, "info");
  assert.equal(report.notice.schema, "$OEM");
  assert.equal(report.notice.reason, "derived");
  assert.equal(report.notice.count, FIXTURE.cases.length);
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
    assert.match(block.COMMENT, /foundation\/sgp4-str3 \(Spacetrack Report No\. 3\), WGS-72 constants, AFSPC mode, zero elapsed time/);
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
  assert.equal(report.failures[1].sgp4_error, 1);
  assert.equal(report.notice.reason, "refused-element-sets");
  assert.equal(states.length, 1);
  assert.equal(states[0].EPHEMERIS_DATA_BLOCK[0].OBJECT.OBJECT_ID, good.entityId);
});

test("an epoch before UTC existed is derived and counted", async (t) => {
  // Vanguard 1, 1959-01-01T00:00:00Z: ERFA reports a dubious year and takes
  // TAI-UTC as zero, which moves TEME -> GCRF by ~1e-11 rad.
  const vanguard = { ...FIXTURE.cases[0], epochUnix: -347155200 };
  const { report, states } = await derive(t, [vanguard]);
  assert.equal(report.derived, 1);
  assert.equal(report.epochs_outside_leap_second_table, 1);
  assert.equal(states[0].EPHEMERIS_DATA_BLOCK[0].START_TIME, "1959-01-01T00:00:00.000000Z");
  assert.match(states[0].EPHEMERIS_DATA_BLOCK[0].COMMENT, /outside the ERFA leap-second table/);
});

// ── derive_omm, ages, and the propagator query port ──────────────────────────
// Expected values come from tests/ages-reference.json (python-sgp4 2.26 in AFSPC mode and pyerfa 2.0.1.5, written by
// tests/ages-reference.py): they do not come from this module.
const AGES = JSON.parse(fs.readFileSync(new URL("./ages-reference.json", import.meta.url), "utf8"));

async function invokeMethod(t, methodId, inputs, config) {
  const harness = await harnessFor(config);
  t.after(() => harness.destroy());
  return harness.invoke({ methodId, inputs });
}

test("derive_omm: OMM element sets at the epoch plus ages match python-sgp4 and pyerfa", async (t) => {
  const payload = ommStream(FIXTURE.cases);
  // The ages from the node config, under this node's key; a plain "ages" (another node's) is not read.
  const response = await invokeMethod(t, "derive_omm", [{ portId: "omm", payload, typeRef: ommType }], { derive: { ages: [3, 0, 1, 0.5, 1] }, ages: [7] });
  assert.equal(response.statusCode, 0, response.errorMessage);
  const report = noticeReport(response.outputs.find((f) => f.portId === "report"));
  assert.equal(report.derived, FIXTURE.cases.length);
  assert.equal(report.failed, 0);
  assert.equal(report.rows, FIXTURE.cases.length * 4);
  assert.deepEqual(report.ages_days, [0, 0.5, 1, 3]);
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
  const report = noticeReport(response.outputs.find((f) => f.portId === "report"));
  assert.deepEqual(report.failures.map(({ index, reason }) => [index, reason]), [
    [0, "mean-element-theory-not-sgp4:SGP4XP"],
    [1, "missing-object-identity"],
    [2, "invalid-epoch"],
  ]);
  assert.equal(report.derived, 1);
});

test("ages: plain \"ages\" is read when \"derive.ages\" is absent; bad ages are refused", async (t) => {
  const payload = ommStream(FIXTURE.cases.slice(0, 1));
  const plain = await invokeMethod(t, "derive_omm", [{ portId: "omm", payload, typeRef: ommType }], { ages: [1, 0] });
  assert.equal(plain.statusCode, 0, plain.errorMessage);
  assert.deepEqual(noticeReport(plain.outputs.find((f) => f.portId === "report")).ages_days, [0, 1]);
  const late = await invokeMethod(t, "derive_omm", [{ portId: "omm", payload, typeRef: ommType }], { derive: { ages: [401] } });
  assert.notEqual(late.statusCode, 0);
  assert.match(late.errorMessage, /between 0 and 400 days/);
  const text = await invokeMethod(t, "derive_omm", [{ portId: "omm", payload, typeRef: ommType }], { ages: "1" });
  assert.notEqual(text.statusCode, 0);
  assert.match(text.errorMessage, /ages is a list of one to 64 ages/);
});

test("answer_propagation_requests: a $PRW WINDOW_REQUEST is answered with the set's TEME trajectory (python-sgp4); refused sets are answered REFUSED; sets are forwarded; a $PRW WINDOW_REPORT sums up", async (t) => {
  const trajectory = AGES.trajectory;
  const sets = FIXTURE.cases.filter((c) => c.satnum === trajectory.satnum || c.satnum === 5);
  const index = sets.findIndex((c) => c.satnum === trajectory.satnum);
  const first = trajectory.samples[0].epochIso, last = trajectory.samples.at(-1).epochIso;
  const requests = await windowRequest(
    [
      { object: `NORAD:${trajectory.satnum}`, set: index, start: first, stop: last, step_s: trajectory.stepSeconds },
      { object: "NORAD:5", set: 1 - index, start: first, stop: last, step_s: trajectory.stepSeconds },
      { object: "none", set: 9, start: first, stop: last, step_s: trajectory.stepSeconds },
    ],
    { PROPAGATOR_PORT_ID: "sgp4", NEIGHBOUR_SETS: 2 },
  );
  const elementSets = ommStream(sets, (_, i) => (i === 1 - index ? { MEAN_ELEMENT_THEORY: meanElementSource.SGP4XP } : {}));
  const response = await invokeMethod(t, "answer_propagation_requests", [
    { portId: "requests", payload: requests, typeRef: prwType },
    { portId: "element_sets", payload: elementSets, typeRef: ommType },
  ]);
  assert.equal(response.statusCode, 0, response.errorMessage);
  const answers = decodeStates(response.outputs.find((f) => f.portId === "propagation").payload);
  assert.equal(answers.length, 3);
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
  assert.match(answers[2].EPHEMERIS_DATA_BLOCK[0].COMMENT, /^REFUSED set-out-of-range/);
  // The second pass sees exactly what the first saw; no options frame is forwarded (the detector reads its config).
  const forwarded = response.outputs.filter((f) => f.portId === "element_sets").map((f) => Buffer.from(f.payload));
  assert.deepEqual(Buffer.concat(forwarded), elementSets);
  assert.equal(response.outputs.some((f) => f.portId === "options"), false);
  const reportFrame = response.outputs.find((f) => f.portId === "report");
  assert.equal(reportFrame.typeRef?.fileIdentifier ?? "$PRW", "$PRW");
  const report = (await decodePrw(reportFrame.payload)).WINDOW_REPORT;
  assert.deepEqual([report.QUERIES, report.ANSWERED, report.REFUSED, report.SOURCE_RECORDS], [3, 1, 2, 2]);
  assert.deepEqual(report.REFUSALS.map((r) => [r.SEQUENCE, r.SET_INDEX, r.REASON]), [
    [1, 1 - index, "mean-element-theory-not-sgp4:SGP4XP"],
    [2, 9, "set-out-of-range"],
  ]);
  assert.match(report.PROVIDER, /^SGP4, foundation\/sgp4-str3 \(Spacetrack Report No\. 3\), WGS-72, AFSPC mode; TEME, UTC, km and km\/s$/);
});

test("answer_propagation_requests refuses what is not a $PRW WINDOW_REQUEST", async (t) => {
  const elementSets = ommStream(FIXTURE.cases.slice(0, 1));
  const notWindow = await invokeMethod(t, "answer_propagation_requests", [
    { portId: "requests", payload: await encodePrw({ VERSION_QUERY: true }), typeRef: prwType },
    { portId: "element_sets", payload: elementSets, typeRef: ommType },
  ]);
  assert.notEqual(notWindow.statusCode, 0);
  assert.equal(notWindow.errorCode, "invalid-requests");
  const tai = await invokeMethod(t, "answer_propagation_requests", [
    { portId: "requests", payload: await encodePrw({ WINDOW_REQUEST: { QUERIES: [{ SET_INDEX: 0, START: { ...utc("2000-01-01T00:00:00Z"), TIME_SYSTEM: "TAI" }, STOP: utc("2000-01-01T01:00:00Z"), STEP_SECONDS: 60 }] } }), typeRef: prwType },
    { portId: "element_sets", payload: elementSets, typeRef: ommType },
  ]);
  assert.notEqual(tai.statusCode, 0);
  assert.match(tai.errorMessage, /START or STOP is not a UTC/);
});

test("omm_from_mpe: the archive's element sets become $OMM that derive_omm reads to the states derive gave", async (t) => {
  const payload = mpeStream(FIXTURE.cases);
  const converted = await invokeMethod(t, "omm_from_mpe", [{ portId: "mpe", payload, typeRef: mpeType() }]);
  assert.equal(converted.statusCode, 0, converted.errorMessage);
  const report = noticeReport(converted.outputs.find((f) => f.portId === "report"));
  assert.equal(report.notice.schema, "$OMM");
  assert.equal(report.notice.reason, "converted");
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
  const refused = await invokeMethod(t, "omm_from_mpe", [{ portId: "mpe", payload: mpeStream([{ ...FIXTURE.cases[0], entityId: undefined }, FIXTURE.cases[1]]), typeRef: mpeType() }]);
  const refusedReport = noticeReport(refused.outputs.find((f) => f.portId === "report"));
  assert.deepEqual(refusedReport.failures.map(({ index, reason }) => [index, reason]), [[0, "missing-entity-id"]]);
  assert.equal(refusedReport.converted, 1);
});

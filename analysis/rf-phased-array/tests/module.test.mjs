import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import * as flatbuffers from "flatbuffers";
import { validatePluginArtifact } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";
import {
  PAP,
  PAPT,
  PAPElementT,
  PAPGainCutT,
  PAPNullT,
  RFLProvenanceT,
  papArrayGeometry,
  papGainCutAxis,
  papTaperFamily,
  rflMethod,
} from "spacedatastandards.org/lib/js/PAP/main.js";
import {
  BEM,
  BEMT,
  BEMHopScheduleT,
  BEMHopSlotT,
  BEMProvenanceT,
  bemHopSlotState,
} from "spacedatastandards.org/lib/js/BEM/main.js";
import { RFL } from "spacedatastandards.org/lib/js/RFL/main.js";
import { CVP } from "spacedatastandards.org/lib/js/CVP/main.js";

const wasmPath = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const manifestPath = new URL("../plugin-manifest.json", import.meta.url);
const wavelength = 299792458 / 1.0e9;
const zeroSignature = new Array(64).fill(0);

function provenance() {
  const value = new RFLProvenanceT();
  value.METHOD = rflMethod.MODELED;
  value.SOURCE = "authoritative phased-array test vector";
  value.MODULE_ID = "test-vector";
  value.MODULE_VERSION = "1";
  return value;
}

function encodePAP(value) {
  const builder = new flatbuffers.Builder(4096);
  const root = value.pack(builder);
  PAP.finishPAPBuffer(builder, root);
  return builder.asUint8Array();
}

function encodeBEM(value) {
  const builder = new flatbuffers.Builder(2048);
  const root = value.pack(builder);
  BEM.finishBEMBuffer(builder, root);
  return builder.asUint8Array();
}

function makeElementPattern() {
  const cuts = [0, 180].map(
    (clock) =>
      new PAPGainCutT(
        `element-${clock}`,
        papGainCutAxis.CONE,
        clock,
        [0, 90],
        [0, 0],
      ),
  );
  const pattern = new PAPT();
  pattern.PAP_ID = "isotropic-element";
  pattern.ELEMENTS = [];
  pattern.GAIN_CUTS = cuts;
  pattern.PROVENANCE = provenance();
  pattern.COMPUTED_AT = 1700000000000n;
  pattern.PRODUCER_ID = "test-vector";
  pattern.SIGNATURE = zeroSignature;
  pattern.CANONICAL_JSON_SIGNATURE = zeroSignature;
  return encodePAP(pattern);
}

function makeConfig({
  count = 8,
  spacingRatio = 0.5,
  steeringCone = 0,
  steeringClock = 0,
  threadCount = 1,
  taper = papTaperFamily.UNIFORM,
  sidelobeDb = -30,
  nbar = 4,
  nulls = [],
} = {}) {
  const elements = [];
  for (let index = 0; index < count; index++) {
    const centered = index - (count - 1) / 2;
    elements.push(
      new PAPElementT(
        `e-${index}`,
        centered * spacingRatio * wavelength,
        0,
        0,
        1,
        0,
        1,
        0,
        "isotropic-element",
        0,
        false,
      ),
    );
  }
  const config = new PAPT();
  config.PAP_ID = "ula-test";
  config.NAME = "ULA authoritative vector";
  config.SCENARIO_ID = "phased-array-tests";
  config.RFE_ID = "test-rfe";
  config.GEOMETRY = papArrayGeometry.LINEAR;
  config.ELEMENTS = elements;
  config.TAPER = taper;
  config.TAPER_PARAMETERS = [sidelobeDb, nbar, threadCount];
  config.STEERING_AZIMUTH_DEG = steeringClock;
  config.STEERING_ELEVATION_DEG = 90 - steeringCone;
  config.STEERING_CONE_DEG = steeringCone;
  config.STEERING_CLOCK_DEG = steeringClock;
  config.GAIN_CUTS = [];
  config.NULLS = nulls;
  config.PROVENANCE = provenance();
  config.COMPUTED_AT = 1700000000000n;
  config.PRODUCER_ID = "test-vector";
  config.SIGNATURE = zeroSignature;
  config.CANONICAL_JSON_SIGNATURE = zeroSignature;
  return encodePAP(config);
}

function makeBeam() {
  const beamProvenance = new BEMProvenanceT(
    "authoritative phased-array test vector",
    null,
    "test",
    "1",
    null,
    "test-vector",
    "1",
    null,
    1700000000000n,
  );
  const slots = [
    new BEMHopSlotT("high-demand", 0, 5, bemHopSlotState.ACTIVE, "beam-test", "cell-a", 32, -117, 1e9, 42, 10),
    new BEMHopSlotT("low-demand", 5, 5, bemHopSlotState.ACTIVE, "beam-test", "cell-b", 34, -119, 1e9, 41, 2),
  ];
  const schedule = new BEMHopScheduleT("schedule-test", 1700000000, 10, true, slots, beamProvenance);
  const beam = new BEMT();
  beam.ID = "beam-test";
  beam.BEAM_NAME = "Test beam";
  beam.ID_ENTITY = "spacecraft-test";
  beam.ID_ANTENNA = "array-test";
  beam.PEAK_GAIN = 20;
  beam.CENTER_LATITUDE = 33;
  beam.CENTER_LONGITUDE = -118;
  beam.BEAMWIDTH = 4;
  beam.FREQUENCY = 1000;
  beam.EIRP = 42;
  beam.HOP_SCHEDULE = schedule;
  beam.PROVENANCE = beamProvenance;
  beam.COMPUTED_AT = 1700000000000n;
  beam.PRODUCER_ID = "test-vector";
  beam.SIGNATURE = zeroSignature;
  beam.CANONICAL_JSON_SIGNATURE = zeroSignature;
  return encodeBEM(beam);
}

function decode(type, bytes) {
  return type[`getRootAs${type.name}`](new flatbuffers.ByteBuffer(bytes));
}

async function invoke(harness, config) {
  const papType = { schemaName: "PAP.fbs", fileIdentifier: "$PAP", schemaVersion: null, acceptsAnyFlatbuffer: false, wireFormat: "flatbuffer", rootTypeName: "PAP" };
  const bemType = { schemaName: "BEM.fbs", fileIdentifier: "$BEM", schemaVersion: null, acceptsAnyFlatbuffer: false, wireFormat: "flatbuffer", rootTypeName: "BEM" };
  const response = await harness.invoke({
    methodId: "synthesize",
    inputs: [
      { portId: "arrayConfig", typeRef: papType, payload: config },
      { portId: "elementPattern", typeRef: papType, payload: makeElementPattern() },
      { portId: "beamModel", typeRef: bemType, payload: makeBeam() },
    ],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.outputs.length, 3);
  return Object.fromEntries(response.outputs.map((entry) => [entry.portId, entry.payload]));
}

async function withHarness(run) {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(wasmPath),
    surface: "direct",
  });
  try {
    return await run(harness);
  } finally {
    harness.destroy();
  }
}

function gainCut(pattern, clockDegrees = 0) {
  for (let index = 0; index < pattern.gainCutsLength(); index++) {
    const cut = pattern.GAIN_CUTS(index);
    if (cut.FIXED_ANGLE_DEG() === clockDegrees) return cut;
  }
  assert.fail(`missing ${clockDegrees}-degree gain cut`);
}

test("fixed-index pthread ranges are byte-identical at 1, 2, 4, and 8", async () => {
  await withHarness(async (harness) => {
    const outputs = [];
    for (const threadCount of [1, 2, 4, 8]) {
      outputs.push(await invoke(harness, makeConfig({ threadCount })));
    }
    for (const port of ["pattern", "links", "footprints"]) {
      for (let index = 1; index < outputs.length; index++) {
        assert.deepEqual(outputs[index][port], outputs[0][port], `${port} drift at thread count ${2 ** index}`);
      }
    }
  });
});

test("ULA array factor, scan loss, grating onset, and white MVDR identity match closed forms", async () => {
  await withHarness(async (harness) => {
    const baseline = await invoke(harness, makeConfig({ count: 8, steeringCone: 30 }));
    const pattern = decode(PAP, baseline.pattern);
    const expectedScanLoss = -10 * Math.log10(Math.cos(Math.PI / 6) ** 1.5);
    assert.ok(Math.abs(pattern.SCAN_LOSS_DB() - expectedScanLoss) < 1e-12);

    const cut = gainCut(pattern);
    const boresight = cut.GAIN_DBI(30);
    const theta = 10 * Math.PI / 180;
    const steering = 30 * Math.PI / 180;
    const psi = Math.PI * (Math.sin(theta) - Math.sin(steering));
    const expectedRelative = 20 * Math.log10(Math.abs(Math.sin(8 * psi / 2) / (8 * Math.sin(psi / 2))));
    assert.ok(Math.abs((cut.GAIN_DBI(10) - boresight) - expectedRelative) < 0.12);

    for (let index = 0; index < pattern.elementsLength(); index++) {
      const element = pattern.ELEMENTS(index);
      assert.ok(Math.abs(Math.hypot(element.WEIGHT_REAL(), element.WEIGHT_IMAGINARY()) - 1 / 8) < 1e-12);
    }

    const threshold = 1 / (1 + Math.abs(Math.sin(Math.PI / 6)));
    const atOnset = decode(PAP, (await invoke(harness, makeConfig({ spacingRatio: threshold, steeringCone: 30 }))).pattern);
    const below = decode(PAP, (await invoke(harness, makeConfig({ spacingRatio: threshold - 0.001, steeringCone: 30 }))).pattern);
    assert.equal(atOnset.GRATING_LOBE_PRESENT(), true);
    assert.equal(below.GRATING_LOBE_PRESENT(), false);
  });
});

test("Dolph-Chebyshev, Taylor n-bar, and adaptive null products are recorded in $PAP", async () => {
  await withHarness(async (harness) => {
    const dolph = decode(PAP, (await invoke(harness, makeConfig({ count: 16, taper: papTaperFamily.EQUAL_SIDELOBE, sidelobeDb: -25 }))).pattern);
    assert.equal(dolph.FIRST_SIDELOBE_LEVEL_DB(), -25);
    assert.equal(dolph.PEAK_SIDELOBE_LEVEL_DB(), -25);

    const taylor = decode(PAP, (await invoke(harness, makeConfig({ count: 16, taper: papTaperFamily.CONTROLLED_SIDELOBE, sidelobeDb: -30, nbar: 4 }))).pattern);
    const edge = Math.hypot(taylor.ELEMENTS(0).WEIGHT_REAL(), taylor.ELEMENTS(0).WEIGHT_IMAGINARY());
    const center = Math.hypot(taylor.ELEMENTS(7).WEIGHT_REAL(), taylor.ELEMENTS(7).WEIGHT_IMAGINARY());
    assert.ok(center > edge, "Taylor n-bar envelope must taper the aperture edge");

    const nullRequest = new PAPNullT("null-1", "interferer-1", 0, 60, 60, 0, 0);
    const nulled = decode(PAP, (await invoke(harness, makeConfig({ count: 16, nulls: [nullRequest] }))).pattern);
    assert.equal(nulled.nullsLength(), 1);
    assert.ok(nulled.NULLS(0).ACHIEVED_DEPTH_DB() > 50);
  });
});

test("beam hopping emits demand-ranked $RFL samples and $CVP footprints", async () => {
  await withHarness(async (harness) => {
    const outputs = await invoke(harness, makeConfig());
    assert.equal(new TextDecoder().decode(outputs.links.slice(4, 8)), "$RFL");
    assert.equal(new TextDecoder().decode(outputs.footprints.slice(4, 8)), "$CVP");
    const links = decode(RFL, outputs.links);
    const footprints = decode(CVP, outputs.footprints);
    assert.equal(links.SAMPLE_COUNT(), 2);
    assert.equal(footprints.POLYGON_COUNT(), 2);
    assert.equal(footprints.POLYGON_LEVEL_VALUES(0), 10);
    assert.equal(footprints.POLYGON_LEVEL_VALUES(1), 2);
  });
});

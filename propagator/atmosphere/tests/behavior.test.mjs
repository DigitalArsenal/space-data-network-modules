import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import * as flatbuffers from "flatbuffers";
import {
  AtmosphericModelFamily,
  ATMT,
  HFC,
  HFCT,
  hfcAtmosphereCouplingMode,
} from "spacedatastandards.org/lib/js/HFC/main.js";
import {
  F107DataType,
  SPW,
} from "spacedatastandards.org/lib/js/SPW/main.js";
import {
  OEM,
} from "spacedatastandards.org/lib/js/OEM/main.js";
import {
  WXF,
  WXFGridT,
  WXFT,
  wxfLevelKind,
  wxfModelClass,
  wxfTimeBasis,
  wxfVariable,
} from "spacedatastandards.org/lib/js/WXF/main.js";
import {
  CelestialFrame,
  CelestialFrameWrapperT,
  HeaderT,
  MetadataT,
  OCM,
  OCMT,
  PhysicalPropertiesT,
  RFMT,
  RFMUnion,
  trajectoryType,
} from "spacedatastandards.org/lib/js/OCM/main.js";
import {
  STANDALONE_RUNTIME_KINDS,
  assertSuccessfulResponse,
  createStandaloneHarness,
  createStandaloneHarnessOrSkip,
} from "space-data-module-sdk/testing/isomorphic";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const BROWSER_WASM_PATH = new URL("../dist/browser/module.wasm", import.meta.url);

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function encodeHfcAtmosphereRequest({
  model = AtmosphericModelFamily.USSA_XX,
  year = 1976,
  timeSystem = "UTC",
  sampleEpochs = [],
  latitudesDeg = [],
  longitudesDeg = [],
  altitudesM = [0, 10_000],
  speedsMps = [],
} = {}) {
  const builder = new flatbuffers.Builder(512);
  const envelope = new HFCT(
    "atmosphere-query-reference",
    "2026-05-25T00:00:00Z",
    "DigitalArsenal",
    "ATMOSPHERE-QUERY",
    timeSystem,
    "ITRF",
    null,
    null,
    0.0,
    null,
    null,
    new ATMT(model, year),
    null,
    null,
    hfcAtmosphereCouplingMode.BATCH_QUERY,
    null,
    null,
    undefined,
    0,
    [],
    sampleEpochs,
    latitudesDeg,
    longitudesDeg,
    altitudesM,
    speedsMps,
  );
  const root = envelope.pack(builder);
  HFC.finishHFCBuffer(builder, root);
  return builder.asUint8Array();
}

function encodeSpwRecord({
  date = "2024-01-01",
  f107Obs = 150,
  f107Adj = f107Obs,
  f107ObsCenter81 = f107Obs,
  f107AdjCenter81 = f107Adj,
  f107DataType = F107DataType.OBS,
  ap = 4,
  ap3Hour = [ap, ap, ap, ap, ap, ap, ap, ap],
  apAvg = ap,
} = {}) {
  const builder = new flatbuffers.Builder(256);
  const dateOffset = builder.createString(date);
  const root = SPW.createSPW(
    builder,
    dateOffset,
    0,
    1,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    ...ap3Hour,
    apAvg,
    0,
    0,
    0,
    f107Obs,
    f107Adj,
    f107DataType,
    f107ObsCenter81,
    f107Obs,
    f107AdjCenter81,
    f107Adj,
  );
  SPW.finishSPWBuffer(builder, root);
  return builder.asUint8Array();
}

// Four consecutive UTC days, 2024-06-18..21. The 3-hour ap of day offset o
// (0..3) and bin b is 10 * o + b + 1. Adjusted fluxes are deliberately far
// from the observed ones: the model must read only the observed values.
function spwWindow({ days = [0, 1, 2, 3], forecastDay = -1 } = {}) {
  return days.map((offset) => encodeSpwRecord({
    date: `2024-06-${String(18 + offset).padStart(2, "0")}`,
    f107Obs: 100 + 10 * offset,
    f107Adj: 500 + 10 * offset,
    f107ObsCenter81: 140 + offset,
    f107AdjCenter81: 600 + offset,
    f107DataType: offset === forecastDay ? F107DataType.PRD : F107DataType.OBS,
    ap3Hour: Array.from({ length: 8 }, (_, bin) => 10 * offset + bin + 1),
    apAvg: 5 + offset,
  }));
}

function spwInputs(payloads) {
  return payloads.map((payload) => ({
    portId: "space_weather",
    typeRef: { schemaName: "SPW.fbs", fileIdentifier: "$SPW", rootTypeName: "SPW" },
    payload,
  }));
}

function hfcInput(payload) {
  return {
    portId: "atmosphere",
    typeRef: { schemaName: "HFC.fbs", fileIdentifier: "$HFC", rootTypeName: "HFC" },
    payload,
  };
}

function nrlmsiseHfcRequest(overrides = {}) {
  return encodeHfcAtmosphereRequest({
    model: AtmosphericModelFamily.NRLMSIS00E,
    year: 2000,
    sampleEpochs: ["2024-06-21T12:30:00Z"],
    latitudesDeg: [45],
    longitudesDeg: [-100],
    altitudesM: [400_000],
    ...overrides,
  });
}

// Basilisk atmosphericDrag reference: 50 kg, 2 m^2, Cd 0.2.
function encodeOcmDragReferenceState() {
  const metadata = new MetadataT();
  metadata.OBJECT_NAME = "BASILISK-ATMOSPHERIC-DRAG";
  metadata.INTERNATIONAL_DESIGNATOR = "BASILISK-ORBITAL-MOTION";
  metadata.TIME_SYSTEM = "UTC";
  metadata.EPOCH_TZERO = "2026-05-26T00:00:00Z";
  metadata.START_TIME = "2026-05-26T00:00:00Z";
  const physical = new PhysicalPropertiesT();
  physical.WET_MASS = 50.0;
  physical.DRAG_CONST_AREA = 2.0;
  physical.DRAG_COEFF_NOM = 0.2;
  const ocm = new OCMT();
  ocm.HEADER = new HeaderT("3.0", [], "U", "2026-05-26T00:00:00Z", "DigitalArsenal");
  ocm.METADATA = metadata;
  ocm.TRAJ_TYPE = trajectoryType.CARTESIAN_PV;
  ocm.STATE_VECTOR_SIZE = 6;
  ocm.STATE_DATA = [6200.0, 100.0, 2000.0, 1.0, 9.0, 1.0];
  ocm.PHYSICAL_PROPERTIES = physical;
  ocm.CENTER_NAME = "EARTH";
  ocm.TRAJ_REF_FRAME = new RFMT(RFMUnion.CelestialFrameWrapper, new CelestialFrameWrapperT(CelestialFrame.EME2000));
  const builder = new flatbuffers.Builder(1024);
  OCM.finishOCMBuffer(builder, ocm.pack(builder));
  return builder.asUint8Array();
}

// HWM14 anchor: NRL's published test output (third_party/hwm14/nrl/Check/
// gfortran.txt, height profile) at day 150, 12:00 UT, 45 S, 85 W, 250 km with
// ap = 80 gives quiet (-4.150, -68.595) and total (40.408, -87.560) m/s,
// meridional and zonal, printed to 1 mm/s.
const WIND_ANCHOR = {
  epoch: "1995-05-30T12:00:00Z",  // day 150
  validTimeMs: 801835200000n,
  latitudeDeg: -45,
  longitudeDeg: -85,
  altitudeM: 250_000,
  quiet: { north: -4.150, east: -68.595 },
  total: { north: 40.408, east: -87.560 },
};
const WIND_TOLERANCE = 6e-4;

// The anchor day with the 12-15 UT bin (AP5) at 80.
function windAnchorSpw() {
  return encodeSpwRecord({ date: "1995-05-30", ap3Hour: [4, 4, 4, 4, 80, 4, 4, 4], apAvg: 15 });
}

function windAnchorHfcRequest() {
  return encodeHfcAtmosphereRequest({
    sampleEpochs: [WIND_ANCHOR.epoch],
    latitudesDeg: [WIND_ANCHOR.latitudeDeg],
    longitudesDeg: [WIND_ANCHOR.longitudeDeg],
    altitudesM: [WIND_ANCHOR.altitudeM],
  });
}

function assertWind(north, east, expected, label) {
  assert.ok(Math.abs(north - expected.north) < WIND_TOLERANCE, `${label} north ${north}`);
  assert.ok(Math.abs(east - expected.east) < WIND_TOLERANCE, `${label} east ${east}`);
}

function encodeWindTemplate({
  levelKind = wxfLevelKind.HeightAboveEllipsoid,
  levelValue = WIND_ANCHOR.altitudeM,
  nlat = 3,
  nlon = 4,
} = {}) {
  const w = new WXFT();
  w.FIELD_ID = "hwm14-anchor-250km";
  w.TIME_BASIS = wxfTimeBasis.ValidTimeOnly;
  w.VALID_TIME_MS = WIND_ANCHOR.validTimeMs;
  w.LEVEL_KIND = levelKind;
  w.LEVEL_VALUE = levelValue;
  const grid = new WXFGridT();
  grid.LAT0 = -45;
  grid.DLAT = 45;
  grid.NLAT = nlat;
  grid.LON0 = -85;
  grid.DLON = 90;
  grid.NLON = nlon;
  w.GRID = grid;
  const builder = new flatbuffers.Builder(256);
  WXF.finishWXFBuffer(builder, w.pack(builder));
  return builder.asUint8Array();
}

function windFieldInputs(template, spw = []) {
  return [
    { portId: "template", typeRef: { schemaName: "WXF.fbs", fileIdentifier: "$WXF", rootTypeName: "WXF" }, payload: template },
    ...spwInputs(spw),
  ];
}

function decodeWindField(response, portId) {
  const payload = assertSuccessfulResponse(response, { outputPortId: portId });
  const bb = new flatbuffers.ByteBuffer(payload);
  assert.equal(WXF.bufferHasIdentifier(bb), true);
  return WXF.getRootAsWXF(bb).unpack();
}

function decodeHfcResponse(response) {
  const payload = assertSuccessfulResponse(response, { outputPortId: "states" });
  const [frame] = response.outputs.filter((entry) => entry.portId === "states");
  assert.equal(frame.typeRef?.schemaName, "HFC.fbs");
  assert.equal(frame.typeRef?.fileIdentifier, "$HFC");
  assert.equal(frame.typeRef?.rootTypeName, "HFC");
  const bb = new flatbuffers.ByteBuffer(payload);
  assert.equal(HFC.bufferHasIdentifier(bb), true);
  return HFC.getRootAsHFC(bb);
}

async function queryUs76(harness, altitudesM) {
  const response = await harness.invoke({
    methodId: "query_atmosphere_state_batch",
    inputs: [hfcInput(encodeHfcAtmosphereRequest({ altitudesM }))],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  return decodeHfcResponse(response);
}

function relClose(a, b, tol, label) {
  const rel = Math.abs(a - b) / Math.abs(b);
  assert.ok(rel <= tol, `${label}: ${a} not within rel ${tol} of ${b}`);
}

function decodeDragOemResponse(response) {
  const payload = assertSuccessfulResponse(response, { outputPortId: "drag_acceleration" });
  const [frame] = response.outputs.filter((entry) => entry.portId === "drag_acceleration");
  assert.equal(frame.typeRef?.schemaName, "OEM.fbs");
  assert.equal(frame.typeRef?.fileIdentifier, "$OEM");
  assert.equal(frame.typeRef?.rootTypeName, "OEM");
  const bb = new flatbuffers.ByteBuffer(payload);
  assert.equal(OEM.bufferHasIdentifier(bb), true);
  return OEM.getRootAsOEM(bb);
}

test("manifest names one concrete FlatBuffer type on every port and no untyped method", () => {
  const manifest = readManifest();
  assert.deepEqual(manifest.methods.map((m) => m.methodId),
    ["query_atmosphere_state_batch", "query_wind_field", "ocm_state_to_drag_acceleration_oem"]);
  for (const method of manifest.methods) {
    for (const port of [...method.inputPorts, ...method.outputPorts]) {
      assert.equal(port.acceptedTypeSets.length, 1, `${method.methodId}.${port.portId}`);
      const types = port.acceptedTypeSets[0].allowedTypes;
      assert.equal(types.length, 1, `${method.methodId}.${port.portId}`);
      assert.equal(types[0].wireFormat, "flatbuffer");
      assert.ok(types[0].fileIdentifier && !types[0].acceptsAnyFlatbuffer);
    }
  }
});

test("manifest declares Basilisk atmospheric drag direct OCM/OEM surface", () => {
  const manifest = readManifest();
  const method = manifest.methods.find((entry) => entry.methodId === "ocm_state_to_drag_acceleration_oem");
  assert.ok(method, "missing ocm_state_to_drag_acceleration_oem method");
  assert.equal(method.inputPorts[0].portId, "vector_state");
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[0].schemaName, "OCM.fbs");
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[0].fileIdentifier, "$OCM");
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[0].rootTypeName, "OCM");
  assert.equal(method.outputPorts[0].portId, "drag_acceleration");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[0].schemaName, "OEM.fbs");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[0].fileIdentifier, "$OEM");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[0].rootTypeName, "OEM");
});

for (const runtimeKind of STANDALONE_RUNTIME_KINDS) {
  test(`HFC batch adds HWM14 winds, quiet time without SPW, on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) return;
    t.after(async () => { await harness.destroy(); });
    const hfc = decodeHfcResponse(await harness.invoke({
      methodId: "query_atmosphere_state_batch",
      inputs: [hfcInput(windAnchorHfcRequest())],
    }));
    assert.equal(hfc.windNorthMPerSLength(), 1);
    assertWind(hfc.WIND_NORTH_M_PER_S(0), hfc.WIND_EAST_M_PER_S(0), WIND_ANCHOR.quiet, "quiet");
    assert.match(hfc.WIND_MODEL(), /^HWM14\.123114 quiet time only/);
  });

  test(`HFC batch adds DWM07 storm-time winds from the SPW 3-hour ap on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) return;
    t.after(async () => { await harness.destroy(); });
    const hfc = decodeHfcResponse(await harness.invoke({
      methodId: "query_atmosphere_state_batch",
      inputs: [hfcInput(windAnchorHfcRequest()), ...spwInputs([windAnchorSpw()])],
    }));
    assertWind(hfc.WIND_NORTH_M_PER_S(0), hfc.WIND_EAST_M_PER_S(0), WIND_ANCHOR.total, "total");
    assert.match(hfc.WIND_MODEL(), /DWM07/);
  });

  test(`HFC batch without sample epochs or positions carries no winds on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) return;
    t.after(async () => { await harness.destroy(); });
    const hfc = decodeHfcResponse(await harness.invoke({
      methodId: "query_atmosphere_state_batch",
      inputs: [hfcInput(encodeHfcAtmosphereRequest())],
    }));
    assert.equal(hfc.windNorthMPerSLength(), 0);
    assert.equal(hfc.WIND_MODEL(), null);
  });

  test(`HFC winds refuse SPW that lacks the sample's day on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) return;
    t.after(async () => { await harness.destroy(); });
    const response = await harness.invoke({
      methodId: "query_atmosphere_state_batch",
      inputs: [hfcInput(windAnchorHfcRequest()), ...spwInputs([encodeSpwRecord({ date: "1995-05-29" })])],
    });
    assert.notEqual(response.statusCode, 0);
    assert.equal(response.errorCode, "missing-space-weather-day");
  });

  test(`query_wind_field fills a WXF grid that matches point queries on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) return;
    t.after(async () => { await harness.destroy(); });
    const response = await harness.invoke({
      methodId: "query_wind_field",
      inputs: windFieldInputs(encodeWindTemplate(), [windAnchorSpw()]),
    });
    const u = decodeWindField(response, "eastward_wind");
    const v = decodeWindField(response, "northward_wind");
    assert.equal(u.VARIABLE, wxfVariable.WindU);
    assert.equal(v.VARIABLE, wxfVariable.WindV);
    assert.equal(u.MODEL_CLASS, wxfModelClass.EmpiricalClimatology);
    assert.equal(u.LEVEL_KIND, wxfLevelKind.HeightAboveEllipsoid);
    assert.equal(u.LEVEL_VALUE, WIND_ANCHOR.altitudeM);
    assert.equal(u.VALID_TIME_MS, WIND_ANCHOR.validTimeMs);
    assert.match(u.VARIABLE_NAME, /DWM07 disturbance, 3-hour ap 80/);
    assert.equal(u.VALUES.length, 12);
    assertWind(v.VALUES[0], u.VALUES[0], WIND_ANCHOR.total, "grid cell (-45, -85)");
    // Every cell is exactly the HFC point value at the same place and time
    // (both are the float32 HWM14 output).
    const cells = [];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 4; j++) cells.push([-45 + 45 * i, -85 + 90 * j]);
    }
    const points = decodeHfcResponse(await harness.invoke({
      methodId: "query_atmosphere_state_batch",
      inputs: [
        hfcInput(encodeHfcAtmosphereRequest({
          sampleEpochs: cells.map(() => WIND_ANCHOR.epoch),
          latitudesDeg: cells.map(([lat]) => lat),
          longitudesDeg: cells.map(([, lon]) => lon),
          altitudesM: cells.map(() => WIND_ANCHOR.altitudeM),
        })),
        ...spwInputs([windAnchorSpw()]),
      ],
    }));
    cells.forEach(([lat, lon], k) => {
      assert.equal(u.VALUES[k], Math.fround(points.WIND_EAST_M_PER_S(k)), `east cell ${lat},${lon}`);
      assert.equal(v.VALUES[k], Math.fround(points.WIND_NORTH_M_PER_S(k)), `north cell ${lat},${lon}`);
    });
    const quiet = await harness.invoke({ methodId: "query_wind_field", inputs: windFieldInputs(encodeWindTemplate()) });
    const uq = decodeWindField(quiet, "eastward_wind");
    const vq = decodeWindField(quiet, "northward_wind");
    assert.match(uq.VARIABLE_NAME, /quiet time only/);
    assertWind(vq.VALUES[0], uq.VALUES[0], WIND_ANCHOR.quiet, "quiet grid cell");
  });

  test(`query_wind_field refuses templates it cannot answer on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) return;
    t.after(async () => { await harness.destroy(); });
    const pressure = await harness.invoke({
      methodId: "query_wind_field",
      inputs: windFieldInputs(encodeWindTemplate({ levelKind: wxfLevelKind.PressureLevel, levelValue: 50000 })),
    });
    assert.equal(pressure.errorCode, "invalid-level");
    const huge = await harness.invoke({
      methodId: "query_wind_field",
      inputs: windFieldInputs(encodeWindTemplate({ nlat: 1, nlon: 300000 })),
    });
    assert.equal(huge.errorCode, "grid-too-large");
  });

  test(`US76 sea-level and 10 km values stay near standard atmosphere on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) return;
    t.after(async () => { await harness.destroy(); });
    const hfc = await queryUs76(harness, [0, 10_000]);
    assert.ok(Math.abs(hfc.DENSITY_KG_PER_M3(0) - 1.225) < 0.001);
    assert.ok(Math.abs(hfc.PRESSURE_PA(0) - 101_325) < 0.1);
    assert.ok(Math.abs(hfc.TEMPERATURE_K(0) - 288.15) < 1e-9);
    assert.ok(Math.abs(hfc.DENSITY_KG_PER_M3(1) - 0.4135) < 0.002);
    assert.ok(hfc.TEMPERATURE_K(1) > 223 && hfc.TEMPERATURE_K(1) < 224);
    assert.ok(hfc.SPEED_OF_SOUND_M_PER_S(1) < hfc.SPEED_OF_SOUND_M_PER_S(0));
  });

  test(`HFC batch preserves sample order and monotonic density on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) return;
    t.after(async () => { await harness.destroy(); });
    const hfc = await queryUs76(harness, [0, 10_000, 20_000]);
    assert.equal(hfc.ATMOSPHERE_PROVIDER(), "atmosphere-model");
    assert.deepEqual(Array.from(hfc.altitudeMArray()), [0, 10_000, 20_000]);
    assert.ok(hfc.DENSITY_KG_PER_M3(0) > hfc.DENSITY_KG_PER_M3(1));
    assert.ok(hfc.DENSITY_KG_PER_M3(1) > hfc.DENSITY_KG_PER_M3(2));
    assert.ok(hfc.PRESSURE_PA(0) > hfc.PRESSURE_PA(1));
    assert.ok(hfc.PRESSURE_PA(1) > hfc.PRESSURE_PA(2));
  });

  test(`direct atmosphere batch method uses fixed provider method id on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const response = await harness.invoke({
      methodId: "query_atmosphere_state_batch",
      inputs: [
        {
          portId: "atmosphere",
          typeRef: {
            schemaName: "HFC.fbs",
            fileIdentifier: "$HFC",
            rootTypeName: "HFC",
          },
          payload: encodeHfcAtmosphereRequest({
            altitudesM: [10_000],
          }),
        },
      ],
    });

    assert.equal(response.statusCode, 0, response.errorMessage);
    const result = decodeHfcResponse(response);
    assert.equal(result.ATMOSPHERE_PROVIDER(), "atmosphere-model");
    assert.equal(result.ALTITUDE_M(0), 10_000);
    assert.ok(Math.abs(result.DENSITY_KG_PER_M3(0) - 0.4135) < 0.002);
  });

  test(`atmosphere port refuses anything but an SDS $HFC on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) return;
    t.after(async () => { await harness.destroy(); });
    // The legacy JSON request this port once fell back to is refused now.
    const response = await harness.invoke({
      methodId: "query_atmosphere_state_batch",
      inputs: [hfcInput(Buffer.from(JSON.stringify({ model: "US76", samples: [{ id: "ten-km", altitudeM: 10_000 }] }), "utf8"))],
    });
    assert.notEqual(response.statusCode, 0);
    assert.equal(response.errorCode, "invalid-hfc-buffer");
  });

  test(`US76 reproduces published 1976 Standard Atmosphere values on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    // Published values: US Standard Atmosphere 1976 (NOAA-S/T 76-1562),
    // Table I. All tolerances <= 0.1%.
    //   Z = 0 m:        T = 288.150 K, P = 101325 Pa, rho = 1.2250 kg/m^3
    //   Z = 10 km geom: T = 223.252 K, P = 26500 Pa, rho = 0.41351 kg/m^3
    //   H = 20 km geopotential (Z = 20063.1 m): T = 216.65 K, P = 5474.9 Pa
    //   H = 47 km geopotential (Z = 47350.1 m): T = 270.65 K
    const z20 = (6356766 * 20000) / (6356766 - 20000);  // geometric Z = r0*H/(r0-H), r0 = 6 356 766 m
    const z47 = (6356766 * 47000) / (6356766 - 47000);
    const hfc = await queryUs76(harness, [0, 10_000, z20, z47]);
    relClose(hfc.TEMPERATURE_K(0), 288.15, 1e-3, "T 0 km");
    relClose(hfc.PRESSURE_PA(0), 101325, 1e-3, "P 0 km");
    relClose(hfc.DENSITY_KG_PER_M3(0), 1.225, 1e-3, "rho 0 km");
    relClose(hfc.TEMPERATURE_K(1), 223.252, 1e-3, "T 10 km geometric");
    relClose(hfc.PRESSURE_PA(1), 26500, 1e-3, "P 10 km geometric");
    relClose(hfc.DENSITY_KG_PER_M3(1), 0.41351, 1e-3, "rho 10 km geometric");
    relClose(hfc.TEMPERATURE_K(2), 216.65, 1e-3, "T 20 km geopotential");
    relClose(hfc.PRESSURE_PA(2), 5474.9, 1e-3, "P 20 km geopotential");
    relClose(hfc.TEMPERATURE_K(3), 270.65, 1e-3, "T 47 km geopotential");
  });

  test(`direct drag method computes Basilisk atmosphericDrag acceleration from OCM spacecraft state on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const response = await harness.invoke({
      methodId: "ocm_state_to_drag_acceleration_oem",
      inputs: [
        {
          portId: "vector_state",
          typeRef: {
            schemaName: "OCM.fbs",
            fileIdentifier: "$OCM",
            rootTypeName: "OCM",
          },
          payload: encodeOcmDragReferenceState(),
        },
      ],
    });

    assert.equal(response.statusCode, 0, response.errorMessage);
    const oem = decodeDragOemResponse(response);
    const block = oem.EPHEMERIS_DATA_BLOCK(0);
    assert.ok(block, "missing OEM ephemeris block");
    assert.equal(block.ephemerisDataLinesLength(), 1);
    assert.equal(block.CENTER_NAME(), "EARTH");
    assert.equal(block.START_TIME(), "2026-05-26T00:00:00Z");
    assert.equal(block.REFERENCE_FRAME()?.REFERENCE_FRAME_type(), RFMUnion.CelestialFrameWrapper);
    const line = block.EPHEMERIS_DATA_LINES(0);
    assert.ok(line, "missing OEM ephemeris data line");
    assert.equal(line.X(), 6200.0);

    const assertNear = (actual, expected, tolerance, label) => {
      assert.ok(
        Math.abs(actual - expected) <= tolerance,
        `${label}: ${actual} not within ${tolerance} of ${expected}`,
      );
    };
    assertNear(line.X_DDOT(), -2.8245395411253663e-7, 1e-18, "drag ax km/s2");
    assertNear(line.Y_DDOT(), -2.5420855870128297e-6, 1e-18, "drag ay km/s2");
    assertNear(line.Z_DDOT(), -2.8245395411253663e-7, 1e-18, "drag az km/s2");
  });

  test(`NRLMSISE00 responds to solar activity at 400 km on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) return;
    t.after(async () => { await harness.destroy(); });
    const weather = (f107, f107a, ap) => ["2024-06-20", "2024-06-21"].map((date) => encodeSpwRecord({
      date, f107Obs: f107, f107ObsCenter81: f107a, ap,
    }));
    const query = async (spw) => decodeHfcResponse(await harness.invoke({
      methodId: "query_atmosphere_state_batch",
      inputs: [hfcInput(nrlmsiseHfcRequest()), ...spwInputs(spw)],
    }));
    const low = await query(weather(70, 70, 0));
    const high = await query(weather(200, 180, 50));
    assert.ok(high.TEMPERATURE_K(0) > low.TEMPERATURE_K(0));
    assert.ok(high.DENSITY_KG_PER_M3(0) > low.DENSITY_KG_PER_M3(0));
  });

  test(`HFC NRLMSISE00 selects observed previous-day flux and epoch-relative ap history on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const response = await harness.invoke({
      methodId: "query_atmosphere_state_batch",
      inputs: [hfcInput(nrlmsiseHfcRequest()), ...spwInputs(spwWindow())],
    });
    assert.equal(response.statusCode, 0, response.errorMessage);
    const hfc = decodeHfcResponse(response);
    const assumptions = Array.from({ length: hfc.assumptionsLength() }, (_, i) => hfc.ASSUMPTIONS(i));
    assert.ok(assumptions.some((line) => line.includes("3-hour ap history for 1 of 1 samples")), assumptions.join(" | "));

    // Expected inputs, by the nrlmsise-00.h definitions, for 2024-06-21
    // (day of year 173) 12:30 UT, which is in 3-hour bin 4:
    //   F10.7  = observed flux of 06-20                    = 120
    //   F10.7A = observed 81-day centered mean of 06-21    = 143
    //   daily Ap of 06-21                                  = 8
    //   ap now, -3 h, -6 h, -9 h = 06-21 bins 4, 3, 2, 1   = 35, 34, 33, 32
    //   mean 12-33 h before = 31, 28, 27, 26, 25, 24, 23, 22 -> 206 / 8
    //   mean 36-57 h before = 21, 18, 17, 16, 15, 14, 13, 12 -> 126 / 8
    // The same model evaluated with exactly these inputs stated directly
    // (switch 9 = -1, 400 km, 45 N 100 W, day 173, 45000 s UT) gives the
    // values below, recorded from the retired JSON surface of 0.1.0. Equality
    // checks the selection; the native published vectors check the model.
    assert.equal(hfc.DENSITY_KG_PER_M3(0), 2.4114616569297282e-12);
    assert.equal(hfc.TEMPERATURE_K(0), 1154.2710897873123);
  });

  test(`HFC NRLMSISE00 uses daily Ap when the ap history is incomplete and reports forecasts on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const response = await harness.invoke({
      methodId: "query_atmosphere_state_batch",
      inputs: [
        hfcInput(nrlmsiseHfcRequest()),
        ...spwInputs(spwWindow({ days: [2, 3], forecastDay: 2 })),
      ],
    });
    assert.equal(response.statusCode, 0, response.errorMessage);
    const hfc = decodeHfcResponse(response);
    const assumptions = Array.from({ length: hfc.assumptionsLength() }, (_, i) => hfc.ASSUMPTIONS(i));
    assert.ok(assumptions.some((line) => line.includes("3-hour ap history for 0 of 1 samples")), assumptions.join(" | "));
    assert.ok(assumptions.some((line) => line.includes("Forecast F10.7")), assumptions.join(" | "));

    // Daily-Ap evaluation with F10.7 120, F10.7A 143, Ap 8 stated directly,
    // recorded from the retired JSON surface of 0.1.0.
    assert.equal(hfc.DENSITY_KG_PER_M3(0), 2.0043441114325766e-12);
  });

  test(`HFC NRLMSISE00 refuses missing weather, time, position and range on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const cases = [
      ["missing-space-weather", [hfcInput(nrlmsiseHfcRequest())]],
      ["missing-previous-day-f107", [hfcInput(nrlmsiseHfcRequest()), ...spwInputs(spwWindow({ days: [3] }))]],
      ["missing-space-weather-day", [hfcInput(nrlmsiseHfcRequest()), ...spwInputs(spwWindow({ days: [0, 1, 2] }))]],
      ["missing-sample-epochs", [hfcInput(nrlmsiseHfcRequest({ sampleEpochs: [] })), ...spwInputs(spwWindow())]],
      ["missing-sample-positions", [hfcInput(nrlmsiseHfcRequest({ latitudesDeg: [], longitudesDeg: [] })), ...spwInputs(spwWindow())]],
      ["altitude-out-of-range", [hfcInput(nrlmsiseHfcRequest({ altitudesM: [1_200_000] })), ...spwInputs(spwWindow())]],
      ["unsupported-time-system", [hfcInput(nrlmsiseHfcRequest({ timeSystem: "TAI" })), ...spwInputs(spwWindow())]],
      ["duplicate-spw-day", [hfcInput(nrlmsiseHfcRequest()), ...spwInputs([...spwWindow(), ...spwWindow({ days: [3] })])]],
      ["unsupported-atmosphere-model", [hfcInput(nrlmsiseHfcRequest({ model: AtmosphericModelFamily.JB08, year: 2008 }))]],
    ];
    for (const [code, inputs] of cases) {
      const response = await harness.invoke({ methodId: "query_atmosphere_state_batch", inputs });
      assert.notEqual(response.statusCode, 0, `${code}: expected a refusal`);
      assert.equal(response.errorCode, code, `${code}: ${response.errorMessage}`);
    }
  });
}

test("query_wind_field emits byte-identical fields in the browser and WasmEdge", async (t) => {
  const outputs = [];
  for (const runtimeKind of STANDALONE_RUNTIME_KINDS) {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) return;
    try {
      const response = await harness.invoke({
        methodId: "query_wind_field",
        inputs: windFieldInputs(encodeWindTemplate(), [windAnchorSpw()]),
      });
      outputs.push(response.outputs.map((frame) => Buffer.from(frame.payload).toString("hex")));
    } finally {
      await harness.destroy();
    }
  }
  assert.ok(outputs.length >= 2, "both runtimes produced output");
  assert.deepEqual(outputs[1], outputs[0]);
});

// A direct-surface host never enters _start, so it must construct the guest
// through the exported _initialize before its first call; without it the first
// call traps with "memory access out of bounds". US76 sea level (1.225 kg/m^3,
// 101325 Pa, 288.15 K) as in the command-surface case, twice on one instance.
for (const [label, wasmPath] of [["isomorphic", WASM_PATH], ["browser", BROWSER_WASM_PATH]]) {
  test(`direct surface constructs the ${label} artifact before its first call`, async (t) => {
    const harness = await createStandaloneHarness("browser", wasmPath, { surface: "direct" });
    t.after(async () => {
      await harness.destroy();
    });
    for (let call = 0; call < 2; call += 1) {
      const seaLevel = await queryUs76(harness, [0]);
      assert.ok(Math.abs(seaLevel.DENSITY_KG_PER_M3(0) - 1.225) < 0.001);
      assert.ok(Math.abs(seaLevel.PRESSURE_PA(0) - 101_325) < 0.1);
      assert.ok(Math.abs(seaLevel.TEMPERATURE_K(0) - 288.15) < 1e-9);
    }
  });
}

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
  VCM,
  VCMStateVectorT,
  VCMT,
} from "spacedatastandards.org/lib/js/VCM/main.js";
import {
  STANDALONE_RUNTIME_KINDS,
  assertSuccessfulResponse,
  createStandaloneHarnessOrSkip,
  invokeJsonRequest,
} from "space-data-module-sdk/testing/isomorphic";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);

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

function encodeVcmDragReferenceState() {
  const builder = new flatbuffers.Builder(512);
  const envelope = new VCMT(
    2.0,
    "2026-05-26T00:00:00Z",
    "DigitalArsenal",
    "BASILISK-ATMOSPHERIC-DRAG",
    "BASILISK-ORBITAL-MOTION",
    "EARTH",
    "EME2000",
    "UTC",
    new VCMStateVectorT(
      "2026-05-26T00:00:00Z",
      6200.0,
      100.0,
      2000.0,
      1.0,
      9.0,
      1.0,
    ),
    null,
    null,
    398600.436,
    null,
    null,
    null,
    50.0,
    0.0,
    0.0,
    2.0,
    0.2,
  );
  const root = envelope.pack(builder);
  VCM.finishVCMBuffer(builder, root);
  return builder.asUint8Array();
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

test("manifest declares Basilisk atmospheric drag direct VCM/OEM surface", () => {
  const manifest = readManifest();
  const method = manifest.methods.find((entry) => entry.methodId === "vcm_state_to_drag_acceleration_oem");
  assert.ok(method, "missing vcm_state_to_drag_acceleration_oem method");
  assert.equal(method.inputPorts[0].portId, "vector_state");
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[0].schemaName, "VCM.fbs");
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[0].rootTypeName, "VCM");
  assert.equal(method.outputPorts[0].portId, "drag_acceleration");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[0].schemaName, "OEM.fbs");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[0].fileIdentifier, "$OEM");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[0].rootTypeName, "OEM");
});

for (const runtimeKind of STANDALONE_RUNTIME_KINDS) {
  test(`version request returns the package version on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const result = await invokeJsonRequest(harness, {
      operation: "version",
      params: {},
    });
    assert.equal(result.version, "0.1.0");
  });

  test(`US76 sea-level and 10 km values stay near standard atmosphere on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const seaLevel = await invokeJsonRequest(harness, {
      operation: "queryAltitude",
      params: { altitudeM: 0, model: "US76" },
    });
    const tenKm = await invokeJsonRequest(harness, {
      operation: "queryAltitude",
      params: { altitudeM: 10_000, model: "US76" },
    });

    assert.ok(Math.abs(seaLevel.state.density - 1.225) < 0.001);
    assert.ok(Math.abs(seaLevel.state.pressure - 101_325) < 0.1);
    assert.ok(Math.abs(seaLevel.state.temperature - 288.15) < 1e-9);

    assert.ok(Math.abs(tenKm.state.density - 0.4135) < 0.002);
    assert.ok(tenKm.state.temperature > 223 && tenKm.state.temperature < 224);
    assert.ok(tenKm.state.soundSpeed < seaLevel.state.soundSpeed);
  });

  test(`batch altitude queries preserve ordering and monotonic density on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const result = await invokeJsonRequest(harness, {
      operation: "queryAltitudes",
      params: {
        altitudesM: [0, 10_000, 20_000],
        model: "US76",
      },
    });

    assert.equal(result.count, 3);
    assert.deepEqual(
      result.results.map((entry) => entry.altitudeM),
      [0, 10_000, 20_000],
    );
    assert.ok(result.results[0].state.density > result.results[1].state.density);
    assert.ok(result.results[1].state.density > result.results[2].state.density);
    assert.ok(result.results[0].state.pressure > result.results[1].state.pressure);
    assert.ok(result.results[1].state.pressure > result.results[2].state.pressure);
  });

  test(`atmosphere state batch exposes the provider contract on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const result = await invokeJsonRequest(harness, {
      operation: "queryAtmosphereStateBatch",
      params: {
        model: "US76",
        samples: [
          { id: "sea-level", altitudeM: 0 },
          { id: "ten-km", altitudeM: 10_000 },
        ],
      },
    });

    assert.equal(result.provider, "atmosphere-model");
    assert.equal(result.model, "US76");
    assert.equal(result.count, 2);
    assert.deepEqual(
      result.states.map((entry) => entry.id),
      ["sea-level", "ten-km"],
    );
    assert.ok(Math.abs(result.states[0].densityKgM3 - 1.225) < 0.001);
    assert.ok(Math.abs(result.states[0].pressurePa - 101_325) < 0.1);
    assert.ok(Math.abs(result.states[1].densityKgM3 - 0.4135) < 0.002);
    assert.ok(result.states[1].soundSpeedMps < result.states[0].soundSpeedMps);
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

  test(`direct atmosphere JSON fallback rejects the fixed provider method id on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    await assert.rejects(
      () => invokeJsonRequest(
        harness,
        {
          model: "US76",
          samples: [{ id: "ten-km", altitudeM: 10_000 }],
        },
        {
          methodId: "query_atmosphere_state_batch",
          inputPortId: "atmosphere",
          outputPortId: "states",
        },
      ),
      /WASI exit|exited with code 1/,
    );
  });

  test(`generic atmosphere invoke method still accepts JSON batch requests on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const result = await invokeJsonRequest(
      harness,
      {
        operation: "queryAtmosphereStateBatch",
        params: {
          model: "US76",
          samples: [{ id: "ten-km", altitudeM: 10_000 }],
        },
      },
      {
        methodId: "invoke",
        inputPortId: "request",
        outputPortId: "response",
      },
    );

    assert.equal(result.provider, "atmosphere-model");
    assert.equal(result.model, "US76");
    assert.equal(result.count, 1);
    assert.equal(result.states[0].id, "ten-km");
    assert.ok(Math.abs(result.states[0].densityKgM3 - 0.4135) < 0.002);
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
    const relClose = (a, b, tol, label) => {
      const rel = Math.abs(a - b) / Math.abs(b);
      assert.ok(rel <= tol, `${label}: ${a} not within rel ${tol} of ${b}`);
    };

    const sea = await invokeJsonRequest(harness, {
      operation: "queryAltitude",
      params: { altitudeM: 0, model: "US76" },
    });
    relClose(sea.state.temperature, 288.15, 1e-3, "T 0 km");
    relClose(sea.state.pressure, 101325, 1e-3, "P 0 km");
    relClose(sea.state.density, 1.225, 1e-3, "rho 0 km");

    const tenKm = await invokeJsonRequest(harness, {
      operation: "queryAltitude",
      params: { altitudeM: 10_000, model: "US76" },
    });
    relClose(tenKm.state.temperature, 223.252, 1e-3, "T 10 km geometric");
    relClose(tenKm.state.pressure, 26500, 1e-3, "P 10 km geometric");
    relClose(tenKm.state.density, 0.41351, 1e-3, "rho 10 km geometric");

    // 20 km geopotential -> geometric Z = r0*H/(r0-H), r0 = 6 356 766 m
    const z20 = (6356766 * 20000) / (6356766 - 20000);
    const twentyKm = await invokeJsonRequest(harness, {
      operation: "queryAltitude",
      params: { altitudeM: z20, model: "US76" },
    });
    relClose(twentyKm.state.temperature, 216.65, 1e-3, "T 20 km geopotential");
    relClose(twentyKm.state.pressure, 5474.9, 1e-3, "P 20 km geopotential");

    const z47 = (6356766 * 47000) / (6356766 - 47000);
    const fortySevenKm = await invokeJsonRequest(harness, {
      operation: "queryAltitude",
      params: { altitudeM: z47, model: "US76" },
    });
    relClose(fortySevenKm.state.temperature, 270.65, 1e-3, "T 47 km geopotential");
  });

  test(`NRLMSISE00 reproduces the canonical published test vector on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    // Canonical case 1 of the 17-case output table distributed with the
    // NRLMSISE-00 C reference package (release 20041227, Brodowski port of
    // Picone/Hedin/Drob; DOCUMENTATION file, also at
    // https://github.com/magnific0/nrlmsise-00/blob/master/DOCUMENTATION):
    //   doy=172, sec=29000 s UT, alt=400 km, lat=60, lon=-70, lst=16 h,
    //   F107A=150, F107=150, ap=4
    //   -> TINF = 1250.54 K, TG = 1241.42 K, RHO(gtd7) = 4.075e-15 g/cm^3,
    //      HE = 6.665e+05, O = 1.139e+08, N2 = 1.998e+07 [1/cm^3]
    // This module reports the gtd7d drag-effective density; at 400 km the
    // anomalous-oxygen contribution is < 0.1%, hence the 2e-3 tolerance on
    // mass density and 1e-3 elsewhere.
    const result = await invokeJsonRequest(harness, {
      operation: "queryAltitude",
      params: {
        altitudeM: 400_000,
        model: "NRLMSISE00",
        position: { latitudeDeg: 60, longitudeDeg: -70 },
        epoch: { year: 0, dayOfYear: 172, secondOfDay: 29_000 },
        localSolarTimeHours: 16,
        solar: { F107: 150, F107A: 150, Ap: [4, 4, 4, 4, 4, 4, 4] },
      },
    });

    const relClose = (a, b, tol, label) => {
      const rel = Math.abs(a - b) / Math.abs(b);
      assert.ok(rel <= tol, `${label}: ${a} not within rel ${tol} of ${b}`);
    };

    relClose(result.state.exosphericTemp, 1250.54, 1e-3, "TINF");
    relClose(result.state.temperature, 1241.42, 1e-3, "TG");
    relClose(result.state.density, 4.075e-15 * 1000, 2e-3, "rho kg/m^3");
    relClose(result.state.numDensityHe, 6.665e5 * 1e6, 1e-3, "He 1/m^3");
    relClose(result.state.numDensityO, 1.139e8 * 1e6, 1e-3, "O 1/m^3");
    relClose(result.state.numDensityN2, 1.998e7 * 1e6, 1e-3, "N2 1/m^3");
  });

  test(`direct drag method computes Basilisk atmosphericDrag acceleration from VCM spacecraft state on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const response = await harness.invoke({
      methodId: "vcm_state_to_drag_acceleration_oem",
      inputs: [
        {
          portId: "vector_state",
          typeRef: {
            schemaName: "VCM.fbs",
            rootTypeName: "VCM",
          },
          payload: encodeVcmDragReferenceState(),
        },
      ],
    });

    assert.equal(response.statusCode, 0, response.errorMessage);
    const oem = decodeDragOemResponse(response);
    const block = oem.EPHEMERIS_DATA_BLOCK(0);
    assert.ok(block, "missing OEM ephemeris block");
    assert.equal(block.ephemerisDataLinesLength(), 1);
    const line = block.EPHEMERIS_DATA_LINES(0);
    assert.ok(line, "missing OEM ephemeris data line");

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
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const place = {
      position: { latitudeDeg: 60, longitudeDeg: -70 },
      epoch: { year: 2024, dayOfYear: 172, secondOfDay: 29_000 },
    };
    const lowSolar = await invokeJsonRequest(harness, {
      operation: "queryAltitude",
      params: {
        altitudeM: 400_000,
        model: "NRLMSISE00",
        ...place,
        solar: { F107: 70, F107A: 70, Ap: [0] },
      },
    });
    const highSolar = await invokeJsonRequest(harness, {
      operation: "queryAltitude",
      params: {
        altitudeM: 400_000,
        model: "NRLMSISE00",
        ...place,
        solar: { F107: 200, F107A: 180, Ap: [50] },
      },
    });

    assert.ok(highSolar.state.exosphericTemp > lowSolar.state.exosphericTemp);
    assert.ok(highSolar.state.temperature > lowSolar.state.temperature);
    assert.ok(highSolar.state.density > lowSolar.state.density);
  });

  test(`NRLMSISE00 JSON requests without place, time or weather are refused on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const complete = {
      altitudeM: 400_000,
      model: "NRLMSISE00",
      position: { latitudeDeg: 60, longitudeDeg: -70 },
      epoch: { year: 2024, dayOfYear: 172, secondOfDay: 29_000 },
      solar: { F107: 150, F107A: 150, Ap: [4] },
    };
    const expectJsonRefusal = async (params, code, label) => {
      const response = await harness.invoke({
        methodId: "invoke",
        inputs: [{
          portId: "request",
          typeRef: null,
          payload: Buffer.from(JSON.stringify({ operation: "queryAltitude", params }), "utf8"),
        }],
      });
      assert.notEqual(response.statusCode, 0, `${label}: expected a refusal`);
      assert.equal(response.errorCode, code, `${label}: ${response.errorMessage}`);
    };
    for (const missing of ["position", "epoch", "solar"]) {
      const params = { ...complete };
      delete params[missing];
      await expectJsonRefusal(params, "missing-nrlmsise-input", `${missing} must be required`);
    }
    await expectJsonRefusal({ ...complete, altitudeM: 1_200_000 }, "altitude-out-of-range", "1200 km");
    await expectJsonRefusal({ ...complete, model: "JB2008" }, "unsupported-atmosphere-model", "unknown model");
  });

  test(`NRLMSISE00 JSON ap history reproduces published case 16 on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    // NRLMSISE-00 C package DOCUMENTATION, case 16: case-1 inputs with
    // switch 9 = -1 and ap_a[0..6] = 100. Published (7 significant digits):
    // TINF 1.426412E+03 K, TG 1.408608E+03 K, O 1.274494E+08 1/cm^3.
    // https://github.com/magnific0/nrlmsise-00/blob/master/DOCUMENTATION
    const result = await invokeJsonRequest(harness, {
      operation: "queryAltitude",
      params: {
        altitudeM: 400_000,
        model: "NRLMSISE00",
        position: { latitudeDeg: 60, longitudeDeg: -70 },
        epoch: { year: 0, dayOfYear: 172, secondOfDay: 29_000 },
        localSolarTimeHours: 16,
        apHistory: true,
        solar: { F107: 150, F107A: 150, Ap: [100, 100, 100, 100, 100, 100, 100] },
      },
    });
    const relClose = (a, b, tol, label) => {
      assert.ok(Math.abs(a - b) / Math.abs(b) <= tol, `${label}: ${a} not within rel ${tol} of ${b}`);
    };
    relClose(result.state.exosphericTemp, 1426.412, 1e-5, "TINF");
    relClose(result.state.temperature, 1408.608, 1e-5, "TG");
    relClose(result.state.numDensityO, 1.274494e8 * 1e6, 1e-5, "O 1/m^3");
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
    // The same model evaluated through the JSON surface with exactly these
    // inputs must give the same density: this checks the selection, while the
    // published vectors check the model.
    const expected = await invokeJsonRequest(harness, {
      operation: "queryAltitude",
      params: {
        altitudeM: 400_000,
        model: "NRLMSISE00",
        position: { latitudeDeg: 45, longitudeDeg: -100 },
        epoch: { year: 2024, dayOfYear: 173, secondOfDay: 45_000 },
        apHistory: true,
        solar: { F107: 120, F107A: 143, Ap: [8, 35, 34, 33, 32, 206 / 8, 126 / 8] },
      },
    });
    assert.equal(hfc.DENSITY_KG_PER_M3(0), expected.state.density);
    assert.equal(hfc.TEMPERATURE_K(0), expected.state.temperature);
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

    const expected = await invokeJsonRequest(harness, {
      operation: "queryAltitude",
      params: {
        altitudeM: 400_000,
        model: "NRLMSISE00",
        position: { latitudeDeg: 45, longitudeDeg: -100 },
        epoch: { year: 2024, dayOfYear: 173, secondOfDay: 45_000 },
        solar: { F107: 120, F107A: 143, Ap: [8] },
      },
    });
    assert.equal(hfc.DENSITY_KG_PER_M3(0), expected.state.density);
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

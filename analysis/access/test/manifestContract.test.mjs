import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath, URL } from "node:url";

import * as flatbuffers from "flatbuffers";
import { createAccessAnalyzer } from "../index.js";
import { validatePluginArtifact } from "space-data-module-sdk/compliance";
import {
  decodePluginInvokeResponse,
  encodePluginInvokeRequest,
} from "space-data-module-sdk/invoke";
import {
  InvokeSurface,
  PluginFamily,
} from "space-data-module-sdk/manifest";
import { ACW, ACWT } from "spacedatastandards.org/lib/js/ACW/ACW.js";
import { ACWElevationMaskPointT } from "spacedatastandards.org/lib/js/ACW/ACWElevationMaskPoint.js";
import { ACWGroundStationT } from "spacedatastandards.org/lib/js/ACW/ACWGroundStation.js";
import { ACWRefractionModelT } from "spacedatastandards.org/lib/js/ACW/ACWRefractionModel.js";
import { ACWRequestT } from "spacedatastandards.org/lib/js/ACW/ACWRequest.js";
import { ACWStateSampleT } from "spacedatastandards.org/lib/js/ACW/ACWStateSample.js";
import { acwOperationCode } from "spacedatastandards.org/lib/js/ACW/acwOperationCode.js";
import { acwRefractionModelKind } from "spacedatastandards.org/lib/js/ACW/acwRefractionModelKind.js";
import { acwResultStatus } from "spacedatastandards.org/lib/js/ACW/acwResultStatus.js";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL(
  "../dist/isomorphic/module.wasm",
  import.meta.url,
);
const ACW_SCHEMA_NAME = "ACW.fbs";
const ACW_FILE_IDENTIFIER = "$ACW";
const ACW_ROOT_TYPE = "ACW";
const EARTH_RADIUS_METERS = 6378137.0;
const ORBIT_RADIUS_METERS = EARTH_RADIUS_METERS + 500000.0;
const SAMPLE_STEP_DAYS = 60.0 / 86400.0;

function degreesToRadians(value) {
  return (value * Math.PI) / 180.0;
}

function radiansToDegrees(value) {
  return (value * 180.0) / Math.PI;
}

function orekitStandardAtmosphereRefractionRad(trueElevationRad) {
  const trueElevationDeg = radiansToDegrees(trueElevationRad);
  if (trueElevationDeg <= -2.0 || trueElevationDeg >= 89.89) {
    return 0.0;
  }

  const refractionArgumentDeg =
    trueElevationDeg + 10.3 / (trueElevationDeg + 5.11);
  const refractionDeg =
    1.02 / Math.tan(degreesToRadians(refractionArgumentDeg)) / 60.0;
  return degreesToRadians(refractionDeg);
}

function interpolateCrossingSeconds(
  previousSeconds,
  previousValue,
  currentSeconds,
  currentValue,
) {
  const delta = currentValue - previousValue;
  if (Math.abs(delta) < 1.0e-12) {
    return previousSeconds;
  }
  const fraction = Math.max(0.0, Math.min(1.0, -previousValue / delta));
  return previousSeconds + (currentSeconds - previousSeconds) * fraction;
}

function createEquatorialStateSample(theta, julianDate) {
  return new ACWStateSampleT(
    julianDate,
    ORBIT_RADIUS_METERS * Math.cos(theta),
    ORBIT_RADIUS_METERS * Math.sin(theta),
    0.0,
  );
}

function topocentricToEquatorialEcef(azimuthRad, elevationRad, rangeM) {
  const east = Math.sin(azimuthRad) * Math.cos(elevationRad) * rangeM;
  const north = Math.cos(azimuthRad) * Math.cos(elevationRad) * rangeM;
  const up = Math.sin(elevationRad) * rangeM;
  return {
    x: EARTH_RADIUS_METERS + up,
    y: east,
    z: north,
  };
}

function createTopocentricStateSample(
  azimuthRad,
  elevationRad,
  rangeM,
  julianDate,
) {
  const position = topocentricToEquatorialEcef(
    azimuthRad,
    elevationRad,
    rangeM,
  );
  return new ACWStateSampleT(
    julianDate,
    position.x,
    position.y,
    position.z,
  );
}

function encodeAcwEnvelope(envelope) {
  const builder = new flatbuffers.Builder(1024);
  ACW.finishACWBuffer(builder, envelope.pack(builder));
  return builder.asUint8Array();
}

function decodeAcwEnvelope(bytes) {
  const bb = new flatbuffers.ByteBuffer(bytes);
  assert.equal(ACW.bufferHasIdentifier(bb), true);
  return ACW.getRootAsACW(bb);
}

function assertAcwSchemaRef(typeRef) {
  assert.equal(typeRef.schemaName, ACW_SCHEMA_NAME);
  assert.equal(typeRef.fileIdentifier, ACW_FILE_IDENTIFIER);
  assert.equal(typeRef.rootTypeName, ACW_ROOT_TYPE);
}

function assertAcwAcceptedTypes(allowedTypes) {
  assert.equal(allowedTypes.length, 2);
  const byWireFormat = new Map(
    allowedTypes.map((typeRef) => [typeRef.wireFormat ?? "flatbuffer", typeRef]),
  );
  const flatbufferType = byWireFormat.get("flatbuffer");
  const alignedType = byWireFormat.get("aligned-binary");
  assert.ok(flatbufferType, "missing ACW flatbuffer type ref");
  assert.ok(alignedType, "missing ACW aligned-binary type ref");

  assertAcwSchemaRef(flatbufferType);
  assert.equal(flatbufferType.requiredAlignment ?? 0, 0);
  assertAcwSchemaRef(alignedType);
  assert.equal(alignedType.requiredAlignment, 8);
}

test("Access analyzer exposes the expected manifest metadata", async function () {
  const analyzer = await createAccessAnalyzer();

  try {
    assert.equal(analyzer.manifestSource, "embedded-flatbuffer");
    assert.equal(analyzer.manifest.pluginId, "com.orbpro.access");
    assert.equal(analyzer.manifest.name, "Access Analysis");
    assert.equal(analyzer.manifest.pluginFamily, PluginFamily.ANALYSIS);
    assert.equal(analyzer.manifest.methods.length, 1);
    assert.equal(analyzer.manifest.methods[0].methodId, "compute_access_windows");
    assert.equal(analyzer.manifest.capabilities.length, 0);
    assert.equal(analyzer.manifest.timers.length, 0);
    assert.equal(analyzer.manifest.protocols.length, 0);
    assert.equal(analyzer.manifest.schemasUsed.length, 1);
    assertAcwSchemaRef(analyzer.manifest.schemasUsed[0]);
    assertAcwAcceptedTypes(
      analyzer.manifest.methods[0].inputPorts[0].acceptedTypeSets[0]
        .allowedTypes,
    );
    assert.match(
      analyzer.manifest.methods[0].inputPorts[0].acceptedTypeSets[0]
        .description,
      /SDS ACW/,
    );
    assertAcwAcceptedTypes(
      analyzer.manifest.methods[0].outputPorts[0].acceptedTypeSets[0]
        .allowedTypes,
    );
    assert.match(
      analyzer.manifest.methods[0].outputPorts[0].acceptedTypeSets[0]
        .description,
      /SDS ACW/,
    );
    assert.equal(analyzer.manifest.buildArtifacts.length, 1);
    assert.equal(analyzer.manifest.buildArtifacts[0].artifactId, "access-runtime");
    assert.equal(analyzer.manifest.buildArtifacts[0].kind, "wasm");
    assert.equal(
      analyzer.manifest.buildArtifacts[0].path,
      "dist/isomorphic/module.wasm",
    );
    assert.equal(analyzer.manifest.buildArtifacts[0].target, "browser,wasmedge");
    assert.deepEqual(analyzer.manifest.invokeSurfaces, [InvokeSurface.DIRECT, InvokeSurface.COMMAND]);
    assert.deepEqual(analyzer.manifest.runtimeTargets, ["browser", "wasmedge"]);
    assert.equal(analyzer.metadata.id, "com.orbpro.access");
    assert.equal(analyzer.metadata.name, "Access Analysis");
  } finally {
    analyzer.destroy();
  }
});

test("Access isomorphic artifact passes SDK compliance checks", async () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  assert.deepEqual(manifest.runtimeTargets, ["browser", "wasmedge"]);
  assert.equal(manifest.schemasUsed.length, 1);
  assertAcwSchemaRef(manifest.schemasUsed[0]);
  assertAcwAcceptedTypes(
    manifest.methods[0].inputPorts[0].acceptedTypeSets[0].allowedTypes,
  );
  assertAcwAcceptedTypes(
    manifest.methods[0].outputPorts[0].acceptedTypeSets[0].allowedTypes,
  );

  const report = await validatePluginArtifact({
    manifest,
    wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH),
  });

  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

function invokeAccessModule(module, request) {
  const requestBytes = encodePluginInvokeRequest(request);
  const requestPointer = module._plugin_alloc(requestBytes.length);
  assert.notEqual(requestPointer, 0, "plugin_alloc returned null for request");
  module.HEAPU8.set(requestBytes, requestPointer);

  const responseLengthPointer = module._plugin_alloc(4);
  assert.notEqual(
    responseLengthPointer,
    0,
    "plugin_alloc returned null for response length",
  );
  new DataView(module.HEAPU8.buffer).setUint32(responseLengthPointer, 0, true);

  const responsePointer = module._plugin_invoke_stream(
    requestPointer,
    requestBytes.length,
    responseLengthPointer,
  );
  const responseLength = new DataView(module.HEAPU8.buffer).getUint32(
    responseLengthPointer,
    true,
  );

  module._plugin_free(requestPointer, requestBytes.length);
  module._plugin_free(responseLengthPointer, 4);

  assert.notEqual(
    responsePointer,
    0,
    "plugin_invoke_stream should return a response pointer",
  );
  assert.notEqual(
    responseLength,
    0,
    "plugin_invoke_stream should return response bytes",
  );

  const responseBytes = new Uint8Array(
    module.HEAPU8.slice(responsePointer, responsePointer + responseLength),
  );
  module._plugin_free(responsePointer, responseLength);
  return decodePluginInvokeResponse(responseBytes);
}

test("Access stream invoke returns a decoded SDK response envelope", async () => {
  const analyzer = await createAccessAnalyzer();
  try {
    const response = invokeAccessModule(analyzer.module, {
      methodId: "compute_access_windows",
      inputs: [],
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.errorCode, "missing-required-input");
    assert.equal(response.errorMessage, "Missing required input port: request");
    assert.deepEqual(response.outputs, []);
  } finally {
    analyzer.destroy();
  }
});

test("Access stream invoke computes access windows from an SDS ACW FlatBuffer request", async () => {
  const analyzer = await createAccessAnalyzer();
  try {
    const startJulianDate = 2460400.5;
    const requestPayload = encodeAcwEnvelope(
      new ACWT(
        new ACWRequestT(
          acwOperationCode.COMPUTE_ACCESS_WINDOWS,
          [
            new ACWGroundStationT(
              "equator-west",
              "Equator West",
              0.0,
              0.0,
              0.0,
              degreesToRadians(10.0),
              1,
              [],
            ),
          ],
          [
            createEquatorialStateSample(
              -0.45,
              startJulianDate + SAMPLE_STEP_DAYS * 0,
            ),
            createEquatorialStateSample(
              -0.3,
              startJulianDate + SAMPLE_STEP_DAYS * 1,
            ),
            createEquatorialStateSample(
              -0.2,
              startJulianDate + SAMPLE_STEP_DAYS * 2,
            ),
            createEquatorialStateSample(
              -0.1,
              startJulianDate + SAMPLE_STEP_DAYS * 3,
            ),
            createEquatorialStateSample(
              0.0,
              startJulianDate + SAMPLE_STEP_DAYS * 4,
            ),
            createEquatorialStateSample(
              0.1,
              startJulianDate + SAMPLE_STEP_DAYS * 5,
            ),
            createEquatorialStateSample(
              0.2,
              startJulianDate + SAMPLE_STEP_DAYS * 6,
            ),
            createEquatorialStateSample(
              0.3,
              startJulianDate + SAMPLE_STEP_DAYS * 7,
            ),
            createEquatorialStateSample(
              0.45,
              startJulianDate + SAMPLE_STEP_DAYS * 8,
            ),
          ],
          "equator-west",
          degreesToRadians(10.0),
          "trace-acw-stream",
        ),
        null,
      ),
    );

    const response = invokeAccessModule(analyzer.module, {
      methodId: "compute_access_windows",
      inputs: [
        {
          portId: "request",
          payload: requestPayload,
          typeRef: {
            schemaName: ACW_SCHEMA_NAME,
            fileIdentifier: ACW_FILE_IDENTIFIER,
            rootTypeName: ACW_ROOT_TYPE,
            wireFormat: "flatbuffer",
          },
        },
      ],
    });

    assert.equal(response.statusCode, 0);
    assert.equal(response.errorCode, null);
    assert.equal(response.errorMessage, null);
    assert.equal(response.outputs.length, 1);
    assert.equal(response.outputs[0].portId, "results");
    assertAcwSchemaRef(response.outputs[0].typeRef);
    assert.equal(response.outputs[0].typeRef.wireFormat, "flatbuffer");

    const resultEnvelope = decodeAcwEnvelope(response.outputs[0].payload);
    const result = resultEnvelope.RESULT();
    assert.ok(result, "ACW response must carry RESULT");
    assert.equal(result.STATUS(), acwResultStatus.OK);
    assert.equal(result.ERROR_MESSAGE(), null);
    assert.equal(result.TRACE_ID(), "trace-acw-stream");
    assert.equal(result.windowsLength(), 1);
    const window = result.WINDOWS(0);
    assert.equal(window.STATION_ID(), "equator-west");
    assert.ok(window.START_JULIAN_DATE_TT() > startJulianDate);
    assert.ok(
      window.START_JULIAN_DATE_TT() <
        startJulianDate + SAMPLE_STEP_DAYS * 4,
    );
    assert.ok(
      window.END_JULIAN_DATE_TT() > startJulianDate + SAMPLE_STEP_DAYS * 4,
    );
    assert.ok(
      window.END_JULIAN_DATE_TT() < startJulianDate + SAMPLE_STEP_DAYS * 8,
    );
    assert.ok(window.MAX_ELEVATION_RAD() > 1.2);
    assert.ok(window.SAMPLE_COUNT() >= 3);
  } finally {
    analyzer.destroy();
  }
});

test("Access stream invoke applies ACW elevation mask and refraction request fields", async () => {
  const analyzer = await createAccessAnalyzer();
  try {
    const startJulianDate = 2460400.5;
    const stepSeconds = 60.0;
    const stepDays = stepSeconds / 86400.0;
    const azimuthRad = degreesToRadians(45.0);
    const rangeM = 1000000.0;
    const maskElevationRad = degreesToRadians(3.5);
    const sampledElevationDeg = [2.9, 3.1, 3.4, 3.8, 3.2, 2.8];
    const switchingValues = sampledElevationDeg.map((elevationDeg) => {
      const elevationRad = degreesToRadians(elevationDeg);
      return (
        elevationRad +
        orekitStandardAtmosphereRefractionRad(elevationRad) -
        maskElevationRad
      );
    });
    const expectedAosSeconds = interpolateCrossingSeconds(
      stepSeconds,
      switchingValues[1],
      stepSeconds * 2.0,
      switchingValues[2],
    );
    const expectedLosSeconds = interpolateCrossingSeconds(
      stepSeconds * 3.0,
      switchingValues[3],
      stepSeconds * 4.0,
      switchingValues[4],
    );
    const requestPayload = encodeAcwEnvelope(
      new ACWT(
        new ACWRequestT(
          acwOperationCode.COMPUTE_ACCESS_WINDOWS,
          [
            new ACWGroundStationT(
              "orekit-stream-effects-origin",
              "Orekit Stream Effects Origin",
              0.0,
              0.0,
              0.0,
              0.0,
              1,
              [],
            ),
          ],
          sampledElevationDeg.map((elevationDeg, index) =>
            createTopocentricStateSample(
              azimuthRad,
              degreesToRadians(elevationDeg),
              rangeM,
              startJulianDate + stepDays * index,
            ),
          ),
          "orekit-stream-effects-origin",
          0.0,
          "trace-acw-stream-effects",
          [
            new ACWElevationMaskPointT(degreesToRadians(0.0), maskElevationRad),
            new ACWElevationMaskPointT(
              degreesToRadians(90.0),
              maskElevationRad,
            ),
            new ACWElevationMaskPointT(
              degreesToRadians(180.0),
              maskElevationRad,
            ),
            new ACWElevationMaskPointT(
              degreesToRadians(270.0),
              maskElevationRad,
            ),
          ],
          new ACWRefractionModelT(
            acwRefractionModelKind.EARTH_STANDARD_ATMOSPHERE,
          ),
        ),
        null,
      ),
    );

    const response = invokeAccessModule(analyzer.module, {
      methodId: "compute_access_windows",
      inputs: [
        {
          portId: "request",
          payload: requestPayload,
          typeRef: {
            schemaName: ACW_SCHEMA_NAME,
            fileIdentifier: ACW_FILE_IDENTIFIER,
            rootTypeName: ACW_ROOT_TYPE,
            wireFormat: "flatbuffer",
          },
        },
      ],
    });

    assert.equal(response.statusCode, 0);
    assert.equal(response.errorCode, null);
    assert.equal(response.errorMessage, null);
    assert.equal(response.outputs.length, 1);

    const resultEnvelope = decodeAcwEnvelope(response.outputs[0].payload);
    const result = resultEnvelope.RESULT();
    assert.ok(result, "ACW response must carry RESULT");
    assert.equal(result.STATUS(), acwResultStatus.OK);
    assert.equal(result.TRACE_ID(), "trace-acw-stream-effects");
    assert.equal(result.windowsLength(), 1);
    const window = result.WINDOWS(0);
    assert.equal(window.STATION_ID(), "orekit-stream-effects-origin");
    assert.ok(
      Math.abs(
        (window.START_JULIAN_DATE_TT() - startJulianDate) * 86400.0 -
          expectedAosSeconds,
      ) < 1.0e-3,
      `stream effects AOS should occur ${expectedAosSeconds} seconds after start`,
    );
    assert.ok(
      Math.abs(
        (window.END_JULIAN_DATE_TT() - startJulianDate) * 86400.0 -
          expectedLosSeconds,
      ) < 1.0e-3,
      `stream effects LOS should occur ${expectedLosSeconds} seconds after start`,
    );
    assert.ok(
      Math.abs(window.MAX_ELEVATION_RAD() - degreesToRadians(3.8)) < 1.0e-10,
      "stream effects max elevation should remain geometric elevation",
    );
  } finally {
    analyzer.destroy();
  }
});

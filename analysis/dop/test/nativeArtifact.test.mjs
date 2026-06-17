import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT = fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));

const WGS84_A = 6378137.0;
const REQUEST_HEADER_SIZE = 80;
const SATELLITE_RECORD_SIZE = 32;

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function writeFloat64(bytes, offset, value) {
  new DataView(bytes.buffer).setFloat64(offset, value, true);
}

function writeUint32(bytes, offset, value) {
  new DataView(bytes.buffer).setUint32(offset, value, true);
}

function encodeRequest({
  receiverPosition = { x: WGS84_A, y: 0.0, z: 0.0 },
  receiverLongitudeRad = 0.0,
  receiverLatitudeRad = 0.0,
  elevationMaskRad = -Math.PI * 0.5,
  satellites = [],
} = {}) {
  const bytes = new Uint8Array(
    REQUEST_HEADER_SIZE + satellites.length * SATELLITE_RECORD_SIZE,
  );
  writeUint32(bytes, 0, satellites.length);
  writeFloat64(bytes, 8, elevationMaskRad);
  writeFloat64(bytes, 16, receiverPosition.x);
  writeFloat64(bytes, 24, receiverPosition.y);
  writeFloat64(bytes, 32, receiverPosition.z);
  writeFloat64(bytes, 40, receiverLongitudeRad);
  writeFloat64(bytes, 48, receiverLatitudeRad);
  let offset = REQUEST_HEADER_SIZE;
  for (const satellite of satellites) {
    writeFloat64(bytes, offset, satellite.x);
    writeFloat64(bytes, offset + 8, satellite.y);
    writeFloat64(bytes, offset + 16, satellite.z);
    writeFloat64(bytes, offset + 24, satellite.weight ?? 1.0);
    offset += SATELLITE_RECORD_SIZE;
  }
  return bytes;
}

function decodeResult(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    gdop: view.getFloat64(0, true),
    pdop: view.getFloat64(8, true),
    hdop: view.getFloat64(16, true),
    vdop: view.getFloat64(24, true),
    tdop: view.getFloat64(32, true),
    usedSatellites: view.getUint32(40, true),
    status: view.getUint32(44, true),
  };
}

function tetrahedronSatellites(range = 20200000.0) {
  const s = 1 / Math.sqrt(3);
  const receiver = { x: WGS84_A, y: 0.0, z: 0.0 };
  return [
    { x: receiver.x + range * s, y: range * s, z: range * s },
    { x: receiver.x + range * s, y: -range * s, z: -range * s },
    { x: receiver.x - range * s, y: range * s, z: -range * s },
    { x: receiver.x - range * s, y: -range * s, z: range * s },
  ];
}

async function withHarness(t, callback) {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());
  await callback(harness);
}

test("DOP manifest declares the shared browser/WasmEdge artifact", () => {
  const manifest = readManifest();
  assert.deepEqual(manifest.runtimeTargets, ["browser", "wasmedge"]);
  assert.equal(manifest.buildArtifacts?.[0]?.path, "dist/isomorphic/module.wasm");
});

test("DOP C++ artifact passes SDK compliance checks", async () => {
  const report = await validateArtifactWithStandards({
    manifest: readManifest(),
    wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH),
    standardsRoot: STANDARDS_ROOT,
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("DOP C++ artifact exposes the standalone isomorphic surface", async () => {
  const inspection = await inspectModule(fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)));
  const importedModuleNames = Array.from(new Set(inspection.imports.map((entry) => entry.module))).sort();
  assert.equal(inspection.profile, "standalone");
  assert.deepEqual(importedModuleNames, ["wasi_snapshot_preview1"]);
  assert.ok(inspection.exports.includes("compute_dop"));
});

test("DOP C++ artifact computes closed-form tetrahedral geometry dilution", async (t) => {
  await withHarness(t, async (harness) => {
    const response = await harness.invoke({
      methodId: "compute_dop",
      inputs: [
        {
          portId: "request",
          typeRef: {
            schemaName: "orbpro.analysis.DopRequest",
            fileIdentifier: "DOPQ",
            rootTypeName: "DopRequest",
          },
          payload: encodeRequest({ satellites: tetrahedronSatellites() }),
        },
      ],
    });

    assert.equal(response.statusCode, 0, response.errorMessage);
    assert.equal(response.outputs.length, 1);
    const [frame] = response.outputs;
    assert.equal(frame.portId, "results");
    assert.equal(frame.typeRef?.schemaName, "orbpro.analysis.DopResult");
    assert.equal(frame.typeRef?.fileIdentifier, "DOPR");

    const result = decodeResult(frame.payload);
    assert.equal(result.status, 0);
    assert.equal(result.usedSatellites, 4);
    assert.ok(Math.abs(result.pdop - 1.5) < 1e-12);
    assert.ok(Math.abs(result.tdop - 0.5) < 1e-12);
    assert.ok(Math.abs(result.gdop - Math.sqrt(2.5)) < 1e-12);
    assert.ok(Math.abs(result.hdop - Math.sqrt(1.5)) < 1e-12);
    assert.ok(Math.abs(result.vdop - Math.sqrt(0.75)) < 1e-12);
  });
});

test("DOP C++ artifact reports insufficient visible satellites after elevation mask", async (t) => {
  await withHarness(t, async (harness) => {
    const response = await harness.invoke({
      methodId: "compute_dop",
      inputs: [
        {
          portId: "request",
          typeRef: {
            schemaName: "orbpro.analysis.DopRequest",
            fileIdentifier: "DOPQ",
            rootTypeName: "DopRequest",
          },
          payload: encodeRequest({
            satellites: tetrahedronSatellites(),
            elevationMaskRad: 0.0,
          }),
        },
      ],
    });

    assert.equal(response.statusCode, 0, response.errorMessage);
    const result = decodeResult(response.outputs[0].payload);
    assert.equal(result.status, 2);
    assert.equal(result.usedSatellites, 2);
    assert.equal(result.gdop, 0.0);
  });
});

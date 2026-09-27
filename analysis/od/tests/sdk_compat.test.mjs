import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validatePluginArtifact } from "space-data-module-sdk/compliance";
import { inspectModule, loadModule } from "space-data-module-sdk/host/isomorphic";
import {
  createBrowserModuleHarness,
  generateManifestHarnessPlan,
  materializeHarnessScenario,
} from "space-data-module-sdk/testing";
import { verifyModuleArtifact } from "space-data-module-sdk/bundle";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const BROWSER_MODULE_PATH = new URL("../dist/browser/module.js", import.meta.url);
const BROWSER_WASM_PATH = new URL("../dist/browser/module.wasm", import.meta.url);
// Owner-authorized development node publication key; signing occurs inside
// the node, so rebuilding never reads a repository private-key fixture.
const DEV_MODULE_SIGNER_PUBLIC_KEY_HEX =
  "49f6454d9f3c20209671081363d979e830d524a9fd040a82c603eb43a953db1c";
const MINIMAL_MEME = `created:2026-03-10 20:32:53 UTC
ephemeris_start:2026-03-10 20:16:42 UTC ephemeris_stop:2026-03-13 20:16:42 UTC step_size:60
ephemeris_source:blend
UVW
2026069201642.000 2331.2303823166 -3812.9956790343 -5288.3093377396 7.1279396227 1.8278970842 1.8252801029
5.0574356535e-07 -4.0409074495e-07 7.9867014315e-07 -1.5244353051e-10 2.2405205309e-10 1.3019804582e-06 8.6964446628e-10
-9.2645027173e-10 -1.4154697945e-12 2.0332016107e-12 -4.8806160534e-10 4.2160627916e-10 1.9653622789e-12 -8.4753151771e-13
5.2167151149e-13 -3.5430236412e-13 -1.9835853617e-13 1.7374846904e-09 -6.5771401381e-16 2.6012134046e-15 5.4232564737e-12
2026069201742.000 2753.5753612189 -3695.1830223004 -5167.4424341778 6.9451594823 2.0977895841 2.2021774396
5.5877928873e-07 -4.7375264519e-07 9.1102189897e-07 -2.1752319120e-10 4.1022000836e-10 1.5237983513e-06 9.7534909273e-10
-1.0742139295e-09 -1.7844400970e-12 2.2539013390e-12 -5.4098450089e-10 4.9252228263e-10 2.2865893169e-12 -9.5425673314e-13
5.7442159873e-13 -5.2862580271e-13 2.2079571161e-13 1.9544407278e-09 -1.3018409197e-15 3.0161098392e-15 5.1863337220e-12
2026069201842.000 3164.0497097397 -3561.4406046759 -5024.2367974268 6.7323931239 2.3586995247 2.5696384902
6.1526243750e-07 -5.5175648026e-07 1.0420883160e-06 -2.9911207274e-10 6.5538787474e-10 1.7697659451e-06 1.0887857305e-09
-1.2415650564e-09 -2.2403173610e-12 2.4917480116e-12 -5.9748245532e-10 5.7189693440e-10 2.6325665880e-12 -1.0690003735e-12
6.3090290772e-13 -7.1251333042e-13 6.7782739014e-13 2.1394109823e-09 -1.9784042803e-15 3.3732085227e-15 4.9203888241e-12
`;

function readFixtureBytes() {
  return new TextEncoder().encode(MINIMAL_MEME);
}

function createHarnessScenario(surface) {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const plan = generateManifestHarnessPlan({
    manifest,
    payloadForPort({ portId }) {
      if (portId !== "meme") {
        return null;
      }
      return readFixtureBytes();
    },
  });
  const scenario = plan.generatedCases.find((entry) => entry.surface === surface);
  assert.ok(scenario, `missing ${surface} harness scenario`);
  return materializeHarnessScenario(scenario);
}

function createInvokeRequest() {
  const scenario = createHarnessScenario("command");
  return {
    methodId: scenario.methodId,
    // MEME is optional in the manifest (OEM is the alternative), so the
    // generated minimal request intentionally contains no input. Supply the
    // selected text fixture explicitly for this command-compatibility test.
    inputs: [{portId: "meme", payload: readFixtureBytes()}],
  };
}

function assertSuccessfulResponse(response) {
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  assert.ok(response.errorCode === "" || response.errorCode === null);
  assert.equal(response.outputs.length, 1);
  assert.equal(response.outputs[0].portId, "result");

  const payloadText = new TextDecoder().decode(response.outputs[0].payload);
  const payload = JSON.parse(payloadText);
  assert.equal(payload.error, undefined);
  assert.equal(typeof payload.RMS, "string");
}

function isWasmEdgeAvailable() {
  const result = spawnSync("wasmedge", ["--version"], { stdio: "ignore" });
  return result.status === 0;
}

test("build publishes canonical browser and isomorphic artifact paths", () => {
  assert.equal(fs.existsSync(fileURLToPath(ISOMORPHIC_WASM_PATH)), true);
  assert.equal(fs.existsSync(fileURLToPath(BROWSER_MODULE_PATH)), true);
  assert.equal(fs.existsSync(fileURLToPath(BROWSER_WASM_PATH)), true);
});

test("built artifact passes SDK compliance checks", async () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const report = await validatePluginArtifact({
    manifest,
    wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH),
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("built artifact carries a trusted SDS module signature", async () => {
  const signature = await verifyModuleArtifact(
    fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    {
      trustedPublicKeys: [DEV_MODULE_SIGNER_PUBLIC_KEY_HEX],
      requireSignature: true,
    },
  );
  assert.equal(signature.publicKeyHex, DEV_MODULE_SIGNER_PUBLIC_KEY_HEX);
});

test("built artifact exposes the standalone isomorphic surface", async () => {
  const inspection = await inspectModule(
    fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
  );
  const importedModuleNames = Array.from(
    new Set(inspection.imports.map((entry) => entry.module)),
  ).sort();

  assert.equal(inspection.profile, "standalone");
  assert.deepEqual(importedModuleNames, ["wasi_snapshot_preview1"]);
  assert.ok(inspection.exports.includes("_start"));
  assert.ok(inspection.exports.includes("plugin_alloc"));
  assert.ok(inspection.exports.includes("plugin_free"));
  assert.ok(inspection.exports.includes("plugin_invoke_stream"));
  assert.ok(inspection.exports.includes("plugin_get_manifest_flatbuffer"));
  assert.ok(inspection.exports.includes("plugin_get_manifest_flatbuffer_size"));
});

test("built artifact loads through the SDK browser harness", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "command",
  });
  t.after(() => {
    harness.destroy();
  });

  const response = await harness.invoke(createInvokeRequest());
  assertSuccessfulResponse(response);
});

test("built artifact loads through the WasmEdge server path", async (t) => {
  if (!isWasmEdgeAvailable()) {
    t.skip("Install wasmedge to verify the server-path harness.");
    return;
  }

  let harness;
  try {
    harness = await loadModule({
      wasmSource: fileURLToPath(ISOMORPHIC_WASM_PATH),
      runtimeKind: "wasmedge",
      enableThreads: true,
    });
  } catch (error) {
    if (/spawn wasmedge ENOENT|command not found|Failed to launch/i.test(String(error))) {
      t.skip("Install wasmedge to verify the server-path harness.");
      return;
    }
    throw error;
  }
  t.after(async () => {
    await harness.destroy();
  });

  const response = await harness.invoke(createInvokeRequest());
  assertSuccessfulResponse(response);
});


test("resident direct invocation remains reusable alongside the command surface", async (t) => {
  const harness = await createBrowserModuleHarness({wasmSource: fs.readFileSync(ISOMORPHIC_WASM_PATH), surface: "direct"});
  t.after(() => harness.destroy());
  for (let i = 0; i < 3; i++) assertSuccessfulResponse(await harness.invoke(createInvokeRequest()));
});

// The browser bundle is the Emscripten command build: a direct-surface host
// never enters its _start, so it constructs the guest through the exported
// _initialize. Without it the first direct call trapped with "memory access
// out of bounds".
test("browser bundle serves the direct surface after its exported _initialize", async (t) => {
  const harness = await createBrowserModuleHarness({wasmSource: fs.readFileSync(BROWSER_WASM_PATH), surface: "direct"});
  t.after(() => harness.destroy());
  for (let i = 0; i < 2; i++) assertSuccessfulResponse(await harness.invoke(createInvokeRequest()));
});

async function createOemInput(wireFormat = "flatbuffer") {
  const {Builder} = await import("flatbuffers");
  const names = ["OEM", "ephemerisDataBlock", "ephemerisDataLine", "CAT", "RFM", "CelestialFrameWrapper"];
  const [OEM, Block, Line, CAT, RFM, Frame] = await Promise.all(names.map(async name =>
    (await import(`spacedatastandards.org/lib/js/OEM/${name}.js`))[`${name}T`]));
  const {CelestialFrame} = await import("spacedatastandards.org/lib/js/OEM/CelestialFrame.js");
  const {RFMUnion} = await import("spacedatastandards.org/lib/js/OEM/RFMUnion.js");
  const {timingStandard} = await import("spacedatastandards.org/lib/js/OEM/timingStandard.js");
  const text = fs.readFileSync(new URL("./data/supgp-reference/iss/ISS.OEM_J2K_EPH.trimmed.txt", import.meta.url), "utf8");
  const lines = text.split(/\r?\n/).filter(line => /^\d{4}-\d{2}-\d{2}T/.test(line.trim())).map(line => {
    const [epoch, ...numbers] = line.trim().split(/\s+/);
    return new Line(epoch, ...numbers.map(Number));
  });
  assert.ok(lines.length > 10);
  const cat = Object.assign(new CAT(), {OBJECT_NAME: "ISS", OBJECT_ID: "1998-067-A", NORAD_CAT_ID: 25544});
  const frame = new RFM(RFMUnion.CelestialFrameWrapper, new Frame(CelestialFrame.EME2000));
  const block = Object.assign(new Block(), {OBJECT: cat, CENTER_NAME: "EARTH", REFERENCE_FRAME: frame,
    TIME_SYSTEM: timingStandard.UTC, EPHEMERIS_DATA_LINES: lines});
  const oem = Object.assign(new OEM(), {EPHEMERIS_DATA_BLOCK: [block]});
  const builder = new Builder(65536); builder.finish(oem.pack(builder), "$OEM");
  return {portId: "oem", typeRef: {schemaName: "OEM.fbs", fileIdentifier: "$OEM", rootTypeName: "OEM", wireFormat, requiredAlignment: 8, byteLength: builder.asUint8Array().length},
    wireFormat, requiredAlignment: 8, payload: builder.asUint8Array()};
}

for (const surface of ["direct", "command", "wasmedge"]) {
  test(`typed OEM fits to a valid OMM on ${surface}`, async t => {
    const {ByteBuffer} = await import("flatbuffers");
    const {OMM} = await import("spacedatastandards.org/lib/js/OMM/OMM.js");
    const harness = surface === "wasmedge"
      ? await loadModule({wasmSource: fileURLToPath(ISOMORPHIC_WASM_PATH), runtimeKind: "wasmedge", enableThreads: true})
      : await createBrowserModuleHarness({wasmSource: fs.readFileSync(ISOMORPHIC_WASM_PATH), surface});
    t.after(() => harness.destroy());
    for (const wireFormat of ["flatbuffer", "aligned-binary"]) {
      const response = await harness.invoke({methodId: "fit", inputs: [await createOemInput(wireFormat)]});
      assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
      assert.equal(response.outputs.length, 2);
      const {OCM} = await import("spacedatastandards.org/lib/js/OCM/OCM.js");
      const ocmFrame = response.outputs.find(x => x.portId === "ocm");
      assert.ok(ocmFrame);
      const ocm = OCM.getSizePrefixedRootAsOCM(new ByteBuffer(ocmFrame.payload));
      assert.equal(ocm.ORBIT_DETERMINATION().OD_COV_REDUCTION(), "UNAVAILABLE");
      assert.equal(ocm.covarianceDataArray(), null);
      assert.ok(ocm.METADATA().START_TIME());
      assert.equal(ocm.METADATA().TIME_SYSTEM(), "UTC");
      const output = response.outputs.find(x => x.portId === "omm");
      assert.equal(output.portId, "omm");
      const buffer = new ByteBuffer(output.payload);
      assert.equal(buffer.readUint32(0), output.payload.byteLength - 4);
      buffer.setPosition(4);
      assert.equal(OMM.bufferHasIdentifier(buffer), true);
      buffer.setPosition(0);
      const omm = OMM.getSizePrefixedRootAsOMM(buffer);
      assert.equal(omm.NORAD_CAT_ID(), 25544);
      assert.equal(omm.OBJECT_NAME(), "ISS");
      assert.ok(omm.MEAN_MOTION() > 15 && omm.MEAN_MOTION() < 16);
      assert.ok(Math.abs(omm.INCLINATION() - 51.6) < 0.2);
    }
  });
}

test("resident fitter rejects missing, mixed, and duplicate ephemerides", async t => {
  const harness = await createBrowserModuleHarness({wasmSource: fs.readFileSync(ISOMORPHIC_WASM_PATH), surface: "direct"});
  t.after(() => harness.destroy());
  const oem = await createOemInput();
  for (const inputs of [[], [oem, oem], [oem, ...createInvokeRequest().inputs]]) {
    const response = await harness.invoke({methodId: "fit", inputs});
    assert.notEqual(response.statusCode, 0);
    assert.equal(response.errorCode, "invalid-ephemeris-count");
    assert.equal(response.outputs.length, 0);
  }
});

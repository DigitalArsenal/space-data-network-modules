// Verifies that the SGP4 wasm artifact exposes the SDS PIV invoke surface,
// OrbPro's direct-call surface, and an embedded PLG manifest whose identity
// matches the authored `plugin-manifest.json`. If this test drifts from the
// manifest the build is wired up incorrectly (manifest bytes baked in by
// `generate-manifest-header.mjs` didn't match what the plugin reports at
// runtime), so failures here should be treated as hard errors.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { inspectModule } from "space-data-module-sdk";
import {
  decodePlgManifest,
  encodePlgManifest,
  isPlgManifestBuffer,
  legacyManifestToPlg,
} from "space-data-module-sdk/manifest";

import { invokePiv, loadRawSgp4Module } from "./lib/pivInvokeHelper.mjs";
import {
  CatalogQueryKind,
  decodeCatalogQueryResult,
  decodePropagatorState,
  encodeCatPayload,
  encodeCatalogQueryRequest,
  encodeOmmPayload,
  encodePropagatorBatchRequest,
  encodeRecWithCat,
  encodeRecWithOmm,
} from "./lib/payloadEncoders.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const wasmPath = path.join(packageRoot, "dist", "isomorphic", "module.wasm");
const manifestJsonPath = path.join(packageRoot, "plugin-manifest.json");

test("SGP4 wasm artifact exports SDS PIV invoke surface alongside OrbPro direct-call exports", async () => {
  const wasmBytes = await readFile(wasmPath);
  const { exports } = await inspectModule(wasmBytes);
  const exportSet = new Set(exports);

  for (const required of [
    "plugin_invoke_stream",
    "plugin_get_input_frame",
    "plugin_push_output_typed",
    "plugin_set_error",
    "plugin_get_manifest_flatbuffer",
    "plugin_get_manifest_flatbuffer_size",
    "plugin_alloc",
    "plugin_free",
  ]) {
    assert.ok(
      exportSet.has(required),
      `expected SDS PIV export ${required}`,
    );
  }

  for (const required of [
    "plugin_init",
    "plugin_init_omm",
    "plugin_destroy",
    "plugin_propagate",
    "plugin_propagate_batch",
    "plugin_propagate_path",
    "get_satellite_count",
  ]) {
    assert.ok(
      exportSet.has(required),
      `expected OrbPro direct-call export ${required}`,
    );
  }

  assert.equal(
    exportSet.has("plugin_stream_invoke"),
    false,
    "legacy StreamInvoke export must not be present",
  );
});

test("PIV outputs declare the FlatBuffer representation actually emitted", async () => {
  const module = await loadRawSgp4Module();
  try {
    const ingested = invokePiv(module, {
      methodId: "ingest_omm",
      inputs: [{ portId: "omm", payload: encodeOmmPayload(),
        typeRef: { schemaName: "orbpro.sds.omm", fileIdentifier: "$OMM", rootTypeName: "OMM" } }],
    });
    assert.equal(ingested.response.STATUS_CODE, 0);
    const propagated = invokePiv(module, {
      methodId: "propagate_state",
      inputs: [{ portId: "request", payload: encodePropagatorBatchRequest({ epoch: 2460310.5, entityHandles: [0], maxCount: 1 }),
        typeRef: { schemaName: "orbpro.propagator.PropagatorBatchRequest", fileIdentifier: "PROP", rootTypeName: "PropagatorBatchRequest" } }],
      outputStreamCap: 1,
    });
    const queried = invokePiv(module, {
      methodId: "catalog_query",
      inputs: [{ portId: "request", payload: encodeCatalogQueryRequest({ queryKind: CatalogQueryKind.CATALOG_ROW, entityIndex: 0 }),
        typeRef: { schemaName: "orbpro.query.CatalogQueryRequest", fileIdentifier: "CQRQ", rootTypeName: "CatalogQueryRequest" } }],
      outputStreamCap: 1,
    });
    for (const result of [propagated, queried]) {
      assert.equal(result.response.STATUS_CODE, 0);
      assert.equal(result.outputPayloads.length, 1);
      assert.equal(result.outputPayloads[0].wireFormat, "flatbuffer");
    }
    assert.ok(decodePropagatorState(propagated.outputPayloads[0].bytes));
    assert.equal(decodeCatalogQueryResult(queried.outputPayloads[0].bytes).row?.noradCatId, 25544);
  } finally {
    module._plugin_destroy();
  }
});

test("the manifest does not advertise an unimplemented PIV path method", async () => {
  const manifest = JSON.parse(await readFile(manifestJsonPath, "utf8"));
  const module = await loadRawSgp4Module();
  try {
    assert.equal(manifest.methods.some((method) => method.methodId === "propagate_path"), false);
    const response = invokePiv(module, { methodId: "propagate_path" }).response;
    assert.equal(response.STATUS_CODE, 404);
    assert.equal(response.ERROR_CODE, "unknown-method");
    assert.equal(typeof module._plugin_propagate_path, "function", "direct native path API remains available");
  } finally {
    module._plugin_destroy();
  }
});

test("REC alternatives use separately typed ports and retain native ingestion", async () => {
  const manifest = JSON.parse(await readFile(manifestJsonPath, "utf8"));
  const module = await loadRawSgp4Module();
  try {
    for (const [methodId, payload] of [
      ["ingest_omm", encodeRecWithOmm(encodeOmmPayload())],
      ["upsert_cat", encodeRecWithCat(encodeCatPayload())],
    ]) {
      const method = manifest.methods.find((entry) => entry.methodId === methodId);
      const records = method.inputPorts.find((port) => port.portId === "records");
      assert.equal(records.acceptedTypeSets[0].allowedTypes[0].rootTypeName, "REC");
      const result = invokePiv(module, { methodId, inputs: [{ portId: "records", payload,
        typeRef: { schemaName: "orbpro.sds.rec", fileIdentifier: "$REC", rootTypeName: "REC" } }] });
      assert.equal(result.response.STATUS_CODE, 0);
      assert.equal(invokePiv(module, { methodId }).response.STATUS_CODE, 0, "empty stream ingestion remains a no-op");
    }
    assert.equal(module._get_satellite_count(), 1);
  } finally {
    module._plugin_destroy();
  }
});

test("SGP4 embedded manifest identity matches plugin-manifest.json", async () => {
  const module = await loadRawSgp4Module();
  try {
    const size = module._plugin_get_manifest_flatbuffer_size();
    assert.ok(size > 0, "embedded manifest should have non-zero size");
    const pointer = module._plugin_get_manifest_flatbuffer();
    assert.ok(pointer > 0, "embedded manifest pointer should be non-zero");
    const bytes = new Uint8Array(module.HEAPU8.slice(pointer, pointer + size));
    assert.equal(isPlgManifestBuffer(bytes), true);

    const runtimeManifest = decodePlgManifest(bytes);
    const authoredManifest = JSON.parse(
      await readFile(manifestJsonPath, "utf8"),
    );

    assert.equal(runtimeManifest.pluginId, "com.orbpro.sgp4");
    assert.equal(runtimeManifest.pluginId, authoredManifest.pluginId);
    assert.equal(runtimeManifest.name, authoredManifest.name);
    assert.equal(runtimeManifest.version, authoredManifest.version);
    assert.deepEqual(
      runtimeManifest.entryFunctions.map((entry) => entry.name),
      authoredManifest.methods.map((method) => method.methodId),
    );

    assert.deepEqual(
      runtimeManifest,
      decodePlgManifest(encodePlgManifest(legacyManifestToPlg(authoredManifest))),
      "embedded ports and type identities must match the full authored SDK contract",
    );
  } finally {
    module._plugin_destroy();
  }
});

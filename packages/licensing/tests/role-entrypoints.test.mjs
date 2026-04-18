import assert from "node:assert/strict";
import fs from "node:fs";
import { WASI } from "node:wasi";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { decodePluginManifest } from "space-data-module-sdk/manifest";
import { DEFAULT_HOSTCALL_IMPORT_MODULE } from "../node_modules/space-data-module-sdk/src/host/abi.js";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const PACKAGE_JSON_PATH = new URL("../package.json", import.meta.url);
const BUILD_SCRIPT_PATH = new URL("../build.sh", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const BROWSER_MODULE_PATH = new URL("../dist/browser/module.js", import.meta.url);
const BROWSER_WASM_PATH = new URL("../dist/browser/module.wasm", import.meta.url);

test("licensing package publishes canonical artifacts and both role entrypoints", () => {
  assert.equal(fs.existsSync(fileURLToPath(PACKAGE_JSON_PATH)), true);
  assert.equal(fs.existsSync(fileURLToPath(MANIFEST_PATH)), true);
  assert.equal(fs.existsSync(fileURLToPath(BUILD_SCRIPT_PATH)), true);
  assert.equal(fs.existsSync(fileURLToPath(ISOMORPHIC_WASM_PATH)), true);
  assert.equal(fs.existsSync(fileURLToPath(BROWSER_MODULE_PATH)), true);
  assert.equal(fs.existsSync(fileURLToPath(BROWSER_WASM_PATH)), true);

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const methods = new Set((manifest.methods ?? []).map((entry) => entry.methodId));
  const protocols = new Map(
    (manifest.protocols ?? []).map((entry) => [entry.wireId, entry.methodId]),
  );

  assert.equal(manifest.pluginId, "licensing");
  assert.equal(manifest.capabilities.includes("ipfs"), true);
  assert.equal(manifest.capabilities.includes("wallet_sign"), true);
  assert.equal(manifest.capabilities.includes("protocol_handle"), true);
  assert.equal(manifest.capabilities.includes("crypto_sign"), true);
  assert.equal(manifest.capabilities.includes("crypto_verify"), true);
  assert.equal(methods.has("server_configure_runtime"), true);
  assert.equal(methods.has("server_publish_module"), true);
  assert.equal(methods.has("server_handle_message"), true);
  assert.equal(methods.has("client_request_grant"), true);
  assert.equal(methods.has("client_fetch_and_decrypt"), true);
  assert.equal(methods.has("decrypt_and_verify"), true);
  assert.equal(
    protocols.get("/space-data-network/module-delivery/1.0.0"),
    "server_handle_message",
  );

  const configureMethod = manifest.methods.find(
    (entry) => entry.methodId === "server_configure_runtime",
  );
  const grantMethod = manifest.methods.find(
    (entry) => entry.methodId === "client_request_grant",
  );
  assert.equal(
    configureMethod.inputPorts[0].acceptedTypeSets[0].allowedTypes[0].fileIdentifier,
    "$LCF",
  );
  assert.equal(
    configureMethod.outputPorts[0].acceptedTypeSets[0].allowedTypes[0].fileIdentifier,
    "$LCF",
  );
  assert.equal(
    grantMethod.inputPorts[0].acceptedTypeSets[0].allowedTypes[0].fileIdentifier,
    "$LCH",
  );
  assert.equal(
    grantMethod.inputPorts[1].portId,
    "requester_signing_key",
  );
  assert.equal(
    grantMethod.inputPorts[1].acceptedTypeSets[0].allowedTypes[0].fileIdentifier,
    "$KMF",
  );
  assert.equal(
    grantMethod.outputPorts[0].acceptedTypeSets[0].allowedTypes[0].fileIdentifier,
    "$LGR",
  );
});

test("embedded manifest in the built wasm matches the licensing package manifest", async () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const wasmBytes = fs.readFileSync(ISOMORPHIC_WASM_PATH);

  const inspection = await inspectModule(wasmBytes);
  assert.equal(inspection.profile, "sdn-abi");
  assert.ok(inspection.exports.includes("plugin_get_manifest_flatbuffer"));
  assert.ok(inspection.exports.includes("plugin_get_manifest_flatbuffer_size"));
  assert.ok(
    inspection.imports.some(
      (entry) => entry.module === DEFAULT_HOSTCALL_IMPORT_MODULE,
    ),
  );

  const wasi = new WASI({
    version: "preview1",
    args: ["licensing-manifest"],
    env: {},
    preopens: {},
    returnOnExit: true,
  });
  const hostImports = Object.fromEntries(
    inspection.imports
      .filter((entry) => entry.module === DEFAULT_HOSTCALL_IMPORT_MODULE)
      .map((entry) => [entry.name, () => 0]),
  );
  const { instance } = await WebAssembly.instantiate(
    wasmBytes,
    {
      ...wasi.getImportObject(),
      [DEFAULT_HOSTCALL_IMPORT_MODULE]: hostImports,
    },
  );
  const manifestPtr = Number(instance.exports.plugin_get_manifest_flatbuffer());
  const manifestSize = Number(
    instance.exports.plugin_get_manifest_flatbuffer_size(),
  );
  const memory = instance.exports.memory;
  const embeddedManifest = decodePluginManifest(
    new Uint8Array(memory.buffer, manifestPtr, manifestSize).slice(),
  );

  assert.equal(embeddedManifest.pluginId, manifest.pluginId);
  assert.deepEqual(
    embeddedManifest.methods.map((entry) => entry.methodId),
    manifest.methods.map((entry) => entry.methodId),
  );
});

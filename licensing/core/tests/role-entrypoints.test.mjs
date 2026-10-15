import assert from "node:assert/strict";
import fs from "node:fs";
import { WASI } from "node:wasi";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_HOSTCALL_IMPORT_MODULE,
  inspectModule,
} from "space-data-module-sdk";
import {
  decodePlgManifest,
  isPlgManifestBuffer,
} from "space-data-module-sdk/manifest";
import { toLoadableWasmBytes } from "space-data-module-sdk/testing/browser";

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

  assert.equal(manifest.capabilities.includes("secrets"), true);

  // Typed contracts 1.0: every port names exactly one concrete SDS FlatBuffer type.
  const portTypes = {};
  for (const method of manifest.methods) {
    for (const [direction, ports] of [["in", method.inputPorts], ["out", method.outputPorts]]) {
      for (const port of ports) {
        const types = port.acceptedTypeSets.flatMap((set) => set.allowedTypes);
        assert.equal(types.length, 1, `${method.methodId}.${port.portId} names one type`);
        const [type] = types;
        assert.equal(type.acceptsAnyFlatbuffer, undefined, `${method.methodId}.${port.portId} is not a wildcard`);
        assert.equal(type.wireFormat, "flatbuffer");
        assert.equal(type.schemaName, `${type.rootTypeName}.fbs`);
        assert.equal(type.fileIdentifier, `$${type.rootTypeName}`);
        portTypes[`${method.methodId}.${direction}.${port.portId}`] = type.fileIdentifier;
      }
    }
  }
  assert.deepEqual(portTypes, {
    "server_configure_runtime.in.config": "$LCF",
    "server_configure_runtime.out.status": "$LCF",
    "server_publish_module.in.module_descriptor": "$PLG",
    "server_publish_module.in.protected_content": "$FIL",
    "server_publish_module.out.response": "$PLG",
    "server_handle_message.in.request": "$LCH",
    "server_handle_message.in.proof": "$LPF",
    "server_handle_message.out.challenge": "$LCH",
    "server_handle_message.out.grant": "$LGR",
    "client_request_grant.in.request": "$LCH",
    "client_request_grant.out.response": "$LGR",
    "client_fetch_and_decrypt.in.grant_response": "$LGR",
    "client_fetch_and_decrypt.in.protected_content": "$FIL",
    "client_fetch_and_decrypt.out.plaintext": "$FIL",
    "decrypt_and_verify.in.protected_content": "$FIL",
    "decrypt_and_verify.in.signer_key": "$KMF",
    "decrypt_and_verify.out.plaintext": "$FIL",
  });
  // The only $KMF port is the public verification key: secrets never travel on a port.
  assert.deepEqual(
    Object.entries(portTypes).filter(([, id]) => id === "$KMF").map(([port]) => port),
    ["decrypt_and_verify.in.signer_key"],
  );
});

test("embedded manifest in the built wasm matches the licensing package manifest", async () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const wasmBytes = fs.readFileSync(ISOMORPHIC_WASM_PATH);

  const inspection = await inspectModule(wasmBytes);
  assert.equal(inspection.profile, "module-host-abi");
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
    toLoadableWasmBytes(wasmBytes),
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
  const embeddedManifestBytes = new Uint8Array(
    memory.buffer,
    manifestPtr,
    manifestSize,
  ).slice();
  assert.equal(isPlgManifestBuffer(embeddedManifestBytes), true);
  const embeddedManifest = decodePlgManifest(embeddedManifestBytes);

  assert.equal(embeddedManifest.pluginId, manifest.pluginId);
  assert.deepEqual(
    embeddedManifest.entryFunctions.map((entry) => entry.name),
    manifest.methods.map((entry) => entry.methodId),
  );
});

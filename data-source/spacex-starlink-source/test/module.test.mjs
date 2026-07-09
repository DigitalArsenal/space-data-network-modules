import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyModuleArtifact } from "space-data-module-sdk/bundle";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { decodePluginManifest } from "space-data-module-sdk";
import { encodePlgManifest, legacyManifestToPlg } from "space-data-module-sdk/manifest";
import createStarlinkSourcePluginManifest from "../manifest.js";

// Encode the canonical manifest exactly as the build embeds it: the SDK's $PLG
// encoder (the format the Go node's PLG parser reads).
function encodeEmbeddedManifest() {
  return encodePlgManifest(legacyManifestToPlg(createStarlinkSourcePluginManifest()));
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = path.join(__dirname, "..", "dist", "spacex-starlink-source.wasm");
const KEYPAIR_PATH =
  process.env.SDN_MODULE_SIGNING_KEYPAIR ||
  path.resolve(__dirname, "../../../../../ancillary-packages/space-data-module-sdk/test/support/dev-module-signing-keypair.json");

const REQUIRED_EXPORTS = [
  "plugin_invoke_stream",
  "plugin_alloc",
  "plugin_free",
  "plugin_get_manifest_flatbuffer",
  "plugin_get_manifest_flatbuffer_size",
];

// The pull's host-call HTTP fetch requires these space_data_module_host imports.
const REQUIRED_HOST_IMPORTS = ["call", "response_len", "read_response"];

function loadWasm() {
  assert.ok(fs.existsSync(WASM_PATH), `built module not found at ${WASM_PATH}; run \`node build.mjs\` first`);
  return new Uint8Array(fs.readFileSync(WASM_PATH));
}

test("module builds as a valid signed SDN artifact", async () => {
  const keypair = JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf8"));
  await verifyModuleArtifact(loadWasm(), {
    trustedPublicKeys: [keypair.publicKeyHex],
    requireSignature: true,
  });
});

test("module exports the canonical plugin ABI", async () => {
  // inspectModule handles the signed artifact via the SDK's canonical
  // signature-strip (no hand-rolled section walking).
  const { exports } = await inspectModule(loadWasm());
  const names = exports.map((e) => (typeof e === "string" ? e : e.name));
  for (const name of REQUIRED_EXPORTS) {
    assert.ok(names.includes(name), `missing ABI export: ${name}`);
  }
});

test("pull imports the space_data_module_host host-call bridge", async () => {
  const { imports } = await inspectModule(loadWasm());
  const hostImports = imports.filter((i) => i.module === "space_data_module_host").map((i) => i.name);
  for (const name of REQUIRED_HOST_IMPORTS) {
    assert.ok(hostImports.includes(name), `missing host-call import: ${name} (have: ${hostImports.join(", ")})`);
  }
});

// The manifest the build embeds (via the SDK encoder) is what the node reads to
// grant host capabilities + schedule the timer. Round-trip it through the SDK
// codec and assert the data-source contract (family, pull method, the 5 host
// caps the pull's host-calls need, and the hourly pull timer).
test("manifest declares the executable data-source contract", async () => {
  const manifest = decodePluginManifest(encodeEmbeddedManifest());

  assert.equal(manifest.pluginId, "com.orbpro.spacex-starlink-source");
  assert.equal(manifest.pluginFamily, "data_source");

  const methodIds = (manifest.methods || []).map((m) => m.methodId);
  assert.ok(methodIds.includes("pull"), `missing pull method (have: ${methodIds.join(", ")})`);

  const caps = (manifest.hostCapabilities || []).map((c) => c.capability);
  for (const cap of ["http", "storage_write", "wallet_sign", "crypto_sign", "pubsub"]) {
    assert.ok(caps.includes(cap), `missing host capability: ${cap} (have: ${caps.join(", ")})`);
  }

  const timers = manifest.timers || [];
  const pullTimer = timers.find((t) => t.timerId === "starlink-pull");
  assert.ok(pullTimer, `missing starlink-pull timer (have: ${timers.map((t) => t.timerId).join(", ")})`);
  assert.equal(pullTimer.methodId, "pull", "starlink-pull timer must invoke the pull method");
});

// Prove the manifest is actually embedded in (and returned by) the built WASM:
// instantiate the loadable module with stub host imports and assert
// plugin_get_manifest_flatbuffer_size() matches the SDK-encoded length, then
// decode the exact bytes the module returns and re-assert the plugin id.
test("built WASM embeds + returns the real manifest", async () => {
  const encoded = encodeEmbeddedManifest();
  const { stripWasmCustomSections } = await import("space-data-module-sdk/bundle");
  const loadable = stripWasmCustomSections(loadWasm());

  const stub = () => 0;
  const { instance } = await WebAssembly.instantiate(loadable, {
    space_data_module_host: {
      call: stub,
      response_len: stub,
      read_response: stub,
      clear_response: stub,
      last_status_code: stub,
    },
  });
  const ex = instance.exports;
  const size = ex.plugin_get_manifest_flatbuffer_size();
  assert.equal(size, encoded.length, `embedded manifest size ${size} != encoded ${encoded.length}`);

  const ptr = ex.plugin_get_manifest_flatbuffer();
  const mem = new Uint8Array(ex.memory.buffer, ptr, size);
  const fromWasm = decodePluginManifest(new Uint8Array(mem));
  assert.equal(fromWasm.pluginId, "com.orbpro.spacex-starlink-source");
});

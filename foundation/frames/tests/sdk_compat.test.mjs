import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { toLoadableWasmBytes, verifyModuleArtifact } from "space-data-module-sdk/bundle";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule, loadModule } from "space-data-module-sdk/host/isomorphic";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT = fileURLToPath(new URL("../node_modules/spacedatastandards.org/", import.meta.url));

// The dev signer this repo signs committed artifacts with
// (space-data-module-sdk/test/support/dev-module-signing-keypair.json). It is a
// DEV key with a published seed: it proves the artifact was produced by this
// build lane, not that it is trustworthy for production delivery.
const DEV_MODULE_SIGNER_PUBLIC_KEY_HEX =
  "cf4625795484d8efe18860141cfdeaaaed7bbee9209488405b6ddeac7543fe78";

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

test("foundation/frames artifact passes SDK compliance", async () => {
  const report = await validateArtifactWithStandards({
    manifest: readManifest(),
    wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH),
    standardsRoot: STANDARDS_ROOT,
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("foundation/frames artifact is standalone WASI with canonical exports", async () => {
  const inspection = await inspectModule(fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)));
  const importedModuleNames = Array.from(new Set(inspection.imports.map((entry) => entry.module))).sort();
  assert.equal(inspection.profile, "standalone");
  assert.deepEqual(importedModuleNames, ["wasi_snapshot_preview1"]);
  for (const required of [
    "_start",
    "plugin_alloc",
    "plugin_free",
    "plugin_invoke_stream",
    "plugin_get_manifest_flatbuffer",
    "plugin_get_manifest_flatbuffer_size",
  ]) {
    assert.ok(inspection.exports.includes(required), `missing export ${required}`);
  }
});

test("foundation/frames artifact loads in the browser harness", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());
  assert.ok(harness);
});

test("foundation/frames artifact loads in WasmEdge when available", async (t) => {
  let harness;
  try {
    harness = await loadModule({
      wasmSource: fileURLToPath(ISOMORPHIC_WASM_PATH),
      runtimeKind: "wasmedge",
      enableThreads: false,
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
  assert.ok(harness);
});

// The committed artifact must carry its publication signature, and the
// signature must not be able to move a single executed byte.
//
// Consumers of this module verify before they instantiate and offer no
// unsigned fallback, so "unsigned" is not a softer state here — it is a load
// failure. `4f3e925` rebuilt this artifact without re-signing it and shipped an
// artifact that no such consumer could load; build.mjs now signs in the build,
// and this is the check that says so about the bytes actually committed.
//
// The second assertion is the isomorphism one: signing appends a `$REC`
// publication trailer, and every SDK loader strips that trailer (and the
// `sds.manifest` section) through `toLoadableWasmBytes` before compiling. The
// browser, native WasmEdge and Docker WasmEdge lanes must therefore compile
// bytes whose hash is exactly what the signature commits to — if those ever
// differ, one runtime is executing something the signature never covered.
test("foundation/frames artifact is signed, and the signature covers exactly what every runtime executes", async () => {
  const bytes = fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH));

  const report = await verifyModuleArtifact(bytes, {
    trustedPublicKeys: [DEV_MODULE_SIGNER_PUBLIC_KEY_HEX],
    requireSignature: true,
  });
  assert.equal(report.signed, true);
  assert.equal(report.verified, true);
  assert.equal(report.keyId, "sdm-dev-test-2026");

  const loadable = Buffer.from(toLoadableWasmBytes(bytes));
  const loadableHashHex = createHash("sha256").update(loadable).digest("hex");
  assert.equal(loadableHashHex, report.contentHashHex);

  // and those stripped bytes are what a runtime actually accepts
  await WebAssembly.compile(loadable);
});

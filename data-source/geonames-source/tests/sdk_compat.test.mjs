// data-source/geonames-source SDK-compat tests: the compiled artifact must pass
// SDK compliance against the pinned standards checkout (which is what proves the
// $GNP typed port resolves to a real schema) and must import nothing beyond the
// runtime surfaces this plugin is allowed to touch.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT =
  process.env.SPACE_DATA_STANDARDS_ROOT ??
  fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function readWasm() {
  return fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH));
}

test("geonames-source artifact passes SDK compliance", async () => {
  const report = await validateArtifactWithStandards({
    manifest: readManifest(),
    wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH),
    standardsRoot: STANDARDS_ROOT,
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("geonames-source imports only WASI (and the sync hostcall bridge)", async () => {
  const inspection = await inspectModule(readWasm());
  const modules = Array.from(new Set(inspection.imports.map((entry) => entry.module))).sort();
  for (const name of modules) {
    assert.ok(
      name === "wasi_snapshot_preview1" || name === "space_data_module_host",
      `unexpected import module "${name}": this plugin is capabilities [] and performs no I/O`,
    );
  }
});

test("the manifest declares capabilities [] and both runtime targets", () => {
  const manifest = readManifest();
  assert.deepEqual(manifest.capabilities, []);
  assert.deepEqual(manifest.runtimeTargets, ["browser", "wasmedge"]);
  assert.deepEqual(manifest.invokeSurfaces, ["direct", "command"]);
  assert.equal(manifest.pluginId, "com.digitalarsenal.data-source.geonames-source");
  // The $GNP record ports are TYPED, not wildcards: a record stream is SDS and
  // an intra-flow control frame is not, and the two must not be spelled alike.
  const places = manifest.methods.find((m) => m.methodId === "parse_places");
  const records = places.outputPorts.find((p) => p.portId === "records");
  assert.equal(records.acceptedTypeSets[0].allowedTypes[0].fileIdentifier, "$GNP");
  assert.equal(records.acceptedTypeSets[0].allowedTypes[0].schemaName, "GNP.fbs");
});

test("the guest-link metadata declares single-thread", () => {
  const metadata = JSON.parse(
    fs.readFileSync(fileURLToPath(new URL("../dist/guest-link/metadata.json", import.meta.url)), "utf8"),
  );
  assert.equal(metadata.threadModel, "single-thread");
});

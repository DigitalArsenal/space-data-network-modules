// data-source/osm-source SDK-compat tests: the compiled artifact must pass
// SDK compliance against the pinned standards package (which is what proves
// the $HTQ and $HTR typed ports resolve to real schemas) and must import
// nothing beyond the runtime surfaces this plugin is allowed to touch.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";

import { publishedStandardsRoot } from "../sds-headers.mjs";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
// THE VALIDATOR READS THE PACKAGE THE BUILD READ. It used to default to a
// SIBLING GIT CHECKOUT outside both repositories, which made compliance
// unreproducible for anyone who did not have that checkout at that commit —
// and the SDK's own resolution finds its NESTED copy of the standards
// package (a GitHub tarball pin, 1.178.0 at SDK 0.8.15), which predates
// $DTT and $IRM entirely. Both are wrong for the same reason: the artifact
// is built from the PUBLISHED package this package.json pins, so that is
// what compliance has to be measured against.
const STANDARDS_ROOT =
  process.env.SPACE_DATA_STANDARDS_ROOT ?? publishedStandardsRoot(import.meta.url);

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function readWasm() {
  return fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH));
}

test("osm-source artifact passes SDK compliance", async () => {
  const report = await validateArtifactWithStandards({
    manifest: readManifest(),
    wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH),
    standardsRoot: STANDARDS_ROOT,
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("osm-source imports only WASI (and the sync hostcall bridge)", async () => {
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
  assert.equal(manifest.pluginId, "com.digitalarsenal.data-source.osm-source");
  assert.equal(manifest.pluginFamily, "data_source");
  // route takes the canonical $HTQ envelope and answers the canonical $HTR
  // envelope, never a JSON control frame (Janus ruling on HTTP-response-shaped
  // outputs); nothing else is typed because nothing else crosses.
  assert.equal(manifest.methods.length, 1);
  const route = manifest.methods[0];
  assert.equal(route.methodId, "route");
  const request = route.inputPorts.find((p) => p.portId === "request");
  const requestType = request.acceptedTypeSets[0].allowedTypes[0];
  assert.equal(requestType.schemaName, "HttpRequestAbi.fbs");
  assert.equal(requestType.fileIdentifier, "$HTQ");
  assert.equal(requestType.rootTypeName, "HttpRequest");
  const response = route.outputPorts.find((p) => p.portId === "response");
  const responseType = response.acceptedTypeSets[0].allowedTypes[0];
  assert.equal(responseType.schemaName, "HttpResponseAbi.fbs");
  assert.equal(responseType.fileIdentifier, "$HTR");
  assert.equal(responseType.rootTypeName, "HttpResponse");
  assert.equal(response.required, true);
});

test("the guest-link metadata declares single-thread", () => {
  const metadata = JSON.parse(
    fs.readFileSync(
      fileURLToPath(new URL("../dist/guest-link/metadata.json", import.meta.url)),
      "utf8",
    ),
  );
  assert.equal(metadata.threadModel, "single-thread");
});

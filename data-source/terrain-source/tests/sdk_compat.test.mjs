// data-source/terrain-source SDK-compat tests: the compiled artifact must pass
// SDK compliance against the pinned standards checkout (which is what proves
// the $DTT and $HTR typed ports resolve to real schemas) and must import
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

test("terrain-source artifact passes SDK compliance", async () => {
  const report = await validateArtifactWithStandards({
    manifest: readManifest(),
    wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH),
    standardsRoot: STANDARDS_ROOT,
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("terrain-source imports only WASI (and the sync hostcall bridge)", async () => {
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
  assert.equal(manifest.pluginId, "com.digitalarsenal.data-source.terrain-source");
  assert.equal(manifest.pluginFamily, "data_source");
  // The $DTT record port is TYPED, not a wildcard: a record stream is SDS and
  // an intra-flow control frame is not, and the two must not be spelled alike.
  const tile = manifest.methods.find((m) => m.methodId === "tile");
  const records = tile.outputPorts.find((p) => p.portId === "records");
  const recordType = records.acceptedTypeSets[0].allowedTypes[0];
  assert.equal(recordType.schemaName, "DTT.fbs");
  assert.equal(recordType.fileIdentifier, "$DTT");
  assert.equal(recordType.rootTypeName, "DTT");
  assert.equal(recordType.wireFormat, "flatbuffer");
  // Body units admit up to sixteen label/range frames; Earth still uses four granules.
  const dem = tile.inputPorts.find((p) => p.portId === "dem");
  assert.equal(dem.maxStreams, 16);
  // layer_json's serving output is the canonical $HTR envelope, never a JSON
  // control frame (Janus ruling on HTTP-response-shaped outputs).
  const layer = manifest.methods.find((m) => m.methodId === "layer_json");
  const response = layer.outputPorts.find((p) => p.portId === "response");
  const responseType = response.acceptedTypeSets[0].allowedTypes[0];
  assert.equal(responseType.schemaName, "HttpResponseAbi.fbs");
  assert.equal(responseType.fileIdentifier, "$HTR");
  assert.equal(responseType.rootTypeName, "HttpResponse");
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

test("every port names ONE concrete FlatBuffer type (typed contracts 1.0: no JSON lane, no wildcard)", () => {
  const ids = {};
  for (const method of readManifest().methods) {
    for (const port of [...method.inputPorts, ...method.outputPorts]) {
      assert.equal(port.acceptedTypeSets.length, 1, `${method.methodId}.${port.portId}`);
      assert.equal(port.acceptedTypeSets[0].allowedTypes.length, 1, `${method.methodId}.${port.portId}`);
      const [type] = port.acceptedTypeSets[0].allowedTypes;
      assert.equal(type.acceptsAnyFlatbuffer, undefined);
      assert.equal(type.wireFormat, "flatbuffer");
      ids[`${method.methodId}.${port.portId}`] = type.fileIdentifier;
    }
  }
  assert.deepEqual(ids, {
    "reduce_parent.children": "$DTT", "reduce_parent.records": "$DTT",
    "tile.plan": "$DTT", "tile.options": "MCFG", "tile.dem": "HRSP", "tile.water": "HRSP", "tile.records": "$DTT", "tile.report": "FNTC",
    "layer_json.plan": "$HTQ", "layer_json.config": "MCFG", "layer_json.response": "$HTR",
    "route.request": "$HTQ", "route.config": "MCFG", "route.query": "$FSO", "route.context": "$HTQ", "route.layer_plan": "$HTQ", "route.response": "$HTR",
    "respond.status": "$FSO", "respond.records": "$FSB", "respond.context": "$HTQ", "respond.config": "MCFG", "respond.response": "$HTR",
    "pack.records": "$DTT", "pack.options": "MCFG", "pack.file": "$DTT", "pack.names": "$PNM",
  });
});

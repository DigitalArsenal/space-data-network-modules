// The parity artifact is only worth measuring if it encodes THE SAME BYTES as
// the shipped one.
//
// dist/parity/module.wasm exists because the SDK's tri-runtime lane cannot run
// a module that imports space_data_module_host (see build-parity.mjs). It is
// the same source with those three imports compiled out. That makes it a
// stand-in, and a stand-in is worthless unless the substitution is proven — so
// every case in the parity fixture is run through BOTH artifacts here and the
// output frames compared byte for byte. If they ever diverge, the tri-runtime
// result stops describing the shipped artifact and this test says so.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const MANIFEST = JSON.parse(fs.readFileSync(path.join(HERE, "../plugin-manifest.json"), "utf8"));
const SHIPPED = path.join(HERE, "../dist/isomorphic/module.wasm");
const PARITY = path.join(HERE, "../dist/parity/module.wasm");
const FIXTURE = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/terrain-parity.json"), "utf8"));

const requestCases = FIXTURE.cases.filter((c) => c.request);

function inputsOf(caseSpec) {
  return caseSpec.request.inputs.map((input) => ({
    portId: input.portId,
    typeRef: input.typeRef,
    payload: new Uint8Array(fs.readFileSync(path.join(HERE, "fixtures", input.payloadFile))),
  }));
}

async function runAll(wasmPath) {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(wasmPath),
    manifest: MANIFEST,
    surface: "direct",
  });
  try {
    const results = new Map();
    for (const caseSpec of requestCases) {
      const response = await harness.invoke({
        methodId: caseSpec.request.methodId,
        inputs: inputsOf(caseSpec),
      });
      results.set(caseSpec.id, {
        statusCode: response.statusCode,
        errorCode: response.errorCode,
        errorMessage: response.errorMessage,
        outputs: response.outputs.map((o) => ({
          portId: o.portId,
          bytes: Buffer.from(o.payload).toString("base64"),
        })),
      });
    }
    return results;
  } finally {
    harness.destroy();
  }
}

test("the parity artifact drops the host bridge and NOTHING else", async () => {
  const shipped = await WebAssembly.compile(fs.readFileSync(SHIPPED));
  const parity = await WebAssembly.compile(fs.readFileSync(PARITY));
  const importModulesOf = (m) => [...new Set(WebAssembly.Module.imports(m).map((i) => i.module))].sort();
  assert.deepEqual(importModulesOf(shipped), ["space_data_module_host", "wasi_snapshot_preview1"]);
  assert.deepEqual(importModulesOf(parity), ["wasi_snapshot_preview1"]);
  const exportsOf = (m) => WebAssembly.Module.exports(m).map((e) => e.name).sort();
  assert.deepEqual(
    exportsOf(shipped),
    exportsOf(parity),
    "same source, same ABI: only the imports differ",
  );
});

test("both artifacts encode byte-identical outputs for every parity case", async () => {
  const [shipped, parity] = await Promise.all([runAll(SHIPPED), runAll(PARITY)]);
  assert.equal(shipped.size, requestCases.length);
  for (const [id, a] of shipped) {
    assert.deepEqual(parity.get(id), a, `case ${id} must be byte-identical across both artifacts`);
  }
});

test("the over-budget case really refuses; an 'ok' exit class is not a silent pass", async () => {
  const caseSpec = requestCases.find((c) => c.id === "tile-over-decode-budget");
  assert.ok(caseSpec, "the fixture carries the over-budget case");
  for (const wasmPath of [SHIPPED, PARITY]) {
    const harness = await createBrowserModuleHarness({
      wasmSource: fs.readFileSync(wasmPath),
      manifest: MANIFEST,
      surface: "direct",
    });
    try {
      const response = await harness.invoke({
        methodId: caseSpec.request.methodId,
        inputs: inputsOf(caseSpec),
      });
      assert.equal(response.errorCode, "decode-budget-exceeded", path.basename(path.dirname(wasmPath)));
      assert.match(response.errorMessage, /268435456-byte in-guest decode budget/);
    } finally {
      harness.destroy();
    }
  }
});

// ── THE $DTT CATALOGUE SURFACE IS REACHED IN THE PARITY ARTIFACT ────────────
//
// It was not, and that was not disclosed. dist/parity/module.wasm is compiled
// with TERRAIN_SOURCE_NO_HOST_BRIDGE, so plugin.getConfig answered nothing and
// /api/v1/terrain/tileset.json was a 503 in EVERY configuration — the record
// builder, the PAYLOAD-always-present shape and the lineage refusal were
// structurally unreachable in the artifact the browser / WasmEdge /
// docker-WasmEdge lanes measure. The whole surface this round was convened to
// fix answered 100 tests in ONE runtime, through ONE harness, against an
// artifact tri-runtime parity never touches.
//
// route() now takes the mount config on an optional frame — compiled into BOTH
// artifacts, so the substitution above still holds byte for byte — and the
// fixture carries three catalogue cases. This test is the other half the
// parity CLI cannot do: the CLI compares outputs across lanes, and what has to
// be true of THIS output is that it is a RECORD. So the body the bridge-free
// artifact produced goes through the SAME projector the builder writes
// tileset-catalogue.dttstream with, and writeFB is what enforces `required`.
test("the parity artifact's catalogue answer is a $DTT, PAYLOAD always present", async (t) => {
  const { createBrowserModuleHarness: makeHarness } = await import("space-data-module-sdk/testing");
  const { decodeHttpResponse } = await import("space-data-module-sdk/http");
  const sds = await import("spacedatastandards.org");
  const { writeDttRecord } = await import("../../../tools/terrain-pyramid/dtt-projection.mjs");

  const harness = await makeHarness({
    wasmSource: fs.readFileSync(PARITY),
    manifest: MANIFEST,
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const answerOf = async (caseId) => {
    const spec = FIXTURE.cases.find((c) => c.id === caseId);
    assert.ok(spec, `${caseId} is in the committed parity fixture`);
    const response = await harness.invoke({
      methodId: spec.request.methodId,
      inputs: inputsOf(spec),
    });
    const out = response.outputs.find((o) => o.portId === "response");
    assert.ok(out, `${caseId} answers directly`);
    const http = decodeHttpResponse(new Uint8Array(out.payload));
    return {
      status: http.status,
      cacheControl: http.headers.find((h) => h.name === "cache-control")?.value,
      body: JSON.parse(Buffer.from(http.body).toString("utf8")),
    };
  };

  // 1. A node serving a published directory.
  const withCid = await answerOf("route-catalogue-record");
  assert.equal(withCid.status, 200);
  assert.ok(withCid.body.PAYLOAD, "PAYLOAD is `required` and is always present");
  assert.match(withCid.body.PAYLOAD.CID, /^b[a-z2-7]{58,}$/, "the tileset directory is PAYLOAD.CID");
  assert.equal(
    withCid.body.PROVENANCE.DATASET_CID,
    undefined,
    "and the tileset CID is NOT copied into the source dataset's provenance field",
  );
  assert.equal(withCid.body.VERTICAL_DATUM, "GEOID");
  assert.equal(withCid.body.VERTICAL_DATUM_NAME, "EGM2008");
  assert.ok(writeDttRecord(sds, withCid.body).length > 0, "it serializes as a $DTT");

  // 2. A node serving no IPFS tileset: PAYLOAD present and EMPTY, which is the
  //    shape that used to be omitted entirely ("field 34 must be set").
  const noCid = await answerOf("route-catalogue-no-cid");
  assert.equal(noCid.status, 200);
  assert.deepEqual(noCid.body.PAYLOAD, {}, "present and empty, never omitted");
  assert.ok(writeDttRecord(sds, noCid.body).length > 0, "and that shape is a $DTT too");

  // 3. One required lineage field short: a refusal, not a 200 with a document
  //    that is not a record.
  const refused = await answerOf("route-catalogue-lineage-refused");
  assert.equal(refused.status, 503);
  assert.equal(refused.cacheControl, "no-store");
  assert.deepEqual(refused.body.missingConfigKeys, ["terrain_dataset_retrieved_at"]);
});

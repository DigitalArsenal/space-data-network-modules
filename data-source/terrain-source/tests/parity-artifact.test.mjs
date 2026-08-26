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

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const standardsRoot = process.env.SPACE_DATA_STANDARDS_ROOT ??
  path.join(packageRoot, "node_modules/spacedatastandards.org");
const standardsRequire = createRequire(path.join(standardsRoot, "package.json"));
const flatbuffers = await import(
  pathToFileURL(standardsRequire.resolve("flatbuffers")).href,
);
const slp = await import(
  pathToFileURL(path.join(standardsRoot, "lib/js/SLP/main.js")).href,
);

function problemBytes(signatureLength = 64) {
  const variables = [
    new slp.SLPVariableT("dv", 0, null, 2400, 0, 5000, 0.01, 1),
    new slp.SLPVariableT("epoch", 0, null, 600, -3000, 3000, 0.1, 1),
  ];
  const goals = [
    new slp.SLPGoalT("apogee", 0, null, 1, 1e-9, 1),
    new slp.SLPGoalT("inclination", 0, null, 0, 1e-9, 1),
  ];
  const settings = new slp.SLPSolverSettingsT(
    slp.slpAlgorithm.NEWTON_RAPHSON,
    slp.slpDifferenceMode.CENTRAL,
    50,
    1000,
    1e-9,
    1e-12,
    1e-10,
    1e-8,
    1e-6,
  );
  const attestation = new slp.SLPAttestationT(
    "00".repeat(32),
    "2026-08-30T00:00:00Z",
    Array(signatureLength).fill(1),
    Array(64).fill(2),
  );
  const problem = new slp.SLPT(
    "typed-target",
    "Typed target",
    slp.slpProblemKind.TARGET,
    "selected-propagator",
    "selected-objective-evaluator",
    variables,
    goals,
    null,
    [],
    settings,
    null,
    "2026-08-30T00:00:00Z",
    attestation,
  );
  const builder = new flatbuffers.Builder(2048);
  const offset = problem.pack(builder);
  slp.SLP.finishSLPBuffer(builder, offset);
  return builder.asUint8Array();
}

function request(payload) {
  return {
    methodId: "solve",
    inputs: [{
      portId: "problem",
      typeRef: {
        schemaName: "SLP.fbs",
        fileIdentifier: "$SLP",
        rootTypeName: "SLP",
      },
      payload,
    }],
  };
}

test("typed SLP entry queues the first generic propagator evaluation", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(path.join(packageRoot, "dist/isomorphic/module.wasm")),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await harness.invoke(request(problemBytes()));
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.deepEqual(response.outputs, []);
  assert.equal(typeof harness.instance.exports.plugin_solver_next, "function");

  const pointer = harness.instance.exports.plugin_alloc(144);
  t.after(() => harness.instance.exports.plugin_free(pointer));
  assert.equal(harness.instance.exports.plugin_solver_next(pointer), 1);
  const view = new DataView(harness.memory.buffer, pointer, 144);
  assert.equal(view.getBigUint64(0, true), 1n);
  assert.equal(view.getUint32(12, true), 2);
  assert.equal(view.getFloat64(16, true), 2400);
  assert.equal(view.getFloat64(24, true), 600);
});

test("typed SLP entry refuses an incomplete dual-signature shape", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(path.join(packageRoot, "dist/isomorphic/module.wasm")),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await harness.invoke(request(problemBytes(63)));
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "unsigned-problem");
  assert.match(response.errorMessage, /both signatures/i);
});

import assert from "node:assert/strict";
import test from "node:test";

import { buildNativeWasiThreadsRunner } from "./lib/wasmedgeWasiThreadsRunner.mjs";
import { initCqrFlatc, encodeCqr, decodeCqr } from "./lib/cqr.mjs";
import { createConjunctionAssessmentPlugin, metadata } from "../index.js";

test("conjunction-assessment direct entry loads the shipped pthread wasm module", async (t) => {
  const plugin = await createConjunctionAssessmentPlugin({
    runtimeKind: "wasmedge",
    enableThreads: true,
    wasmEdgeBinary: await buildNativeWasiThreadsRunner(),
  });
  t.after(async () => {
    await plugin.destroy?.();
  });

  assert.equal(plugin.manifest.pluginId, metadata.id);
  assert.equal(typeof plugin.invoke, "function");
  assert.equal(typeof plugin.streamInvoke, "function");
  // The same NIST Rayleigh CDF oracle as cqrAuthoritative.test.mjs:
  // radius10m, sigma100m, arbitrary orthonormal plane, epoch-independent,
  // absolute tolerance1e-12 for converged integration.
  // https://www.itl.nist.gov/div898/software/dataplot/refman2/auxillar/raycdf.htm
  const flatc = await initCqrFlatc();
  const payload = encodeCqr(flatc, { PROBABILITY_REQUEST: {
    GEOMETRY: { VARIANCE_XI_M2: 10000, VARIANCE_ZETA_M2: 10000, COMBINED_RADIUS_M: 10 },
    ALGORITHM: "LAAS_2015",
  }});
  const result = await plugin.invoke({methodId:"compute_pc",inputs:[{
    portId:"request",payload,
    typeRef:{schemaName:"CQR.fbs",fileIdentifier:"$CQR",rootTypeName:"CQR",wireFormat:"flatbuffer"},
  }]});
  assert.equal(result.statusCode, 0, result.errorMessage);
  const pc = decodeCqr(flatc, result.outputs[0].payload).PROBABILITY_RESULT;
  assert.equal(pc.CONVERGED, true);
  assert.ok(Math.abs(pc.PROBABILITY - 0.00498752080731768) <= 1e-12);
});

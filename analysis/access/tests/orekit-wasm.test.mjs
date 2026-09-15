import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createBrowserModuleHarness } from "space-data-module-sdk/host/browser-module";
import { vectors, requestFor, elevationFrom, toleranceRad } from "./orekit-fixture.mjs";

test("primary SDK WASM ACW elevations match the six Orekit inverse-coordinate cases", async (t) => {
  const harness = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(new URL("../dist/isomorphic/module.wasm", import.meta.url)), surface: "direct" });
  try {
    let maximum = 0;
    for (const vector of vectors) {
      const response = await harness.invoke(requestFor(vector));
      assert.equal(response.statusCode, 0, response.errorMessage);
      const error = Math.abs(elevationFrom(response) - vector[1]);
      maximum = Math.max(maximum, error);
      assert.ok(error < toleranceRad, `elevation error ${error} rad exceeds ${toleranceRad}`);
    }
    t.diagnostic(`Orekit six cases: maximum elevation error=${maximum} rad; tolerance=${toleranceRad} rad`);
  } finally { await harness.destroy(); }
});

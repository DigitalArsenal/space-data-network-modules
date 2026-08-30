import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const vector = JSON.parse(fs.readFileSync(
  new URL("../vectors/orekit-finite-difference.json", import.meta.url),
  "utf8",
));

test("finite-difference authority is pinned to the Orekit source test", () => {
  assert.equal(vector.authority.name, "Orekit");
  assert.equal(vector.authority.commit, "7b39f84999bca5b51b11f216befd6555116f8f52");
  assert.equal(
    vector.authority.test,
    "testGetObjectiveFunctionParametersOnlyScaledOnce",
  );
  assert.deepEqual(vector.case.normalizedSamples, [0, 1]);
  assert.deepEqual(vector.case.expectedBuilderParameters, [[0], [1]]);
});

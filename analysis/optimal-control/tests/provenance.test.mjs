import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const vector = JSON.parse(fs.readFileSync(
  new URL("../vectors/hs1.json", import.meta.url),
  "utf8",
));

test("HS1 authority and published optimum are explicit", () => {
  assert.equal(vector.authority.problem, "HS1");
  assert.equal(vector.authority.year, 1981);
  assert.deepEqual(vector.case.initial, [-2, 1]);
  assert.deepEqual(vector.case.optimum, [1, 1]);
  assert.equal(vector.case.objective, 0);
});

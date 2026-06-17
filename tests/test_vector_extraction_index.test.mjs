import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

const REPO_ROOT = new URL("..", import.meta.url);
const INDEX_PATH = new URL("../docs/test-vector-extraction-index.json", import.meta.url);

function runChecker(args = []) {
  return spawnSync(
    process.execPath,
    ["scripts/check-test-vector-extraction-index.mjs", ...args],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
    },
  );
}

function writeMutatedIndex(mutate) {
  const index = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
  mutate(index);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdn-test-vector-index-"));
  const file = path.join(dir, "test-vector-extraction-index.json");
  fs.writeFileSync(file, `${JSON.stringify(index, null, 2)}\n`);
  return file;
}

test("test-vector extraction index validates selected Orekit and Basilisk numeric ports", () => {
  const result = runChecker();
  if (result.status !== 0) {
    throw new Error(`${result.stdout}\n${result.stderr}`);
  }
  assert.match(result.stdout, /validated \d+ Orekit and \d+ Basilisk test-vector mappings/);
});

test("test-vector extraction index fails closed for missing upstream test files", () => {
  const file = writeMutatedIndex((index) => {
    index.orekit.mappings[0].upstreamTestFile = "src/test/java/org/orekit/time/MissingTest.java";
  });
  const result = runChecker(["--index", file]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing Orekit upstream test file/i);
});

test("test-vector extraction index fails closed for missing SDN test files", () => {
  const file = writeMutatedIndex((index) => {
    index.basilisk.mappings[0].sdnTests[0].file = "foundation/orbits/tests/missing.test.mjs";
  });
  const result = runChecker(["--index", file]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing SDN test file/i);
});

test("test-vector extraction index fails closed for unmapped SDN test names", () => {
  const file = writeMutatedIndex((index) => {
    index.orekit.mappings[0].sdnTests[0].name = "not a real SDN test name";
  });
  const result = runChecker(["--index", file]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SDN test name.*not found/i);
});

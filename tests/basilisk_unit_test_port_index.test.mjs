import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

const REPO_ROOT = new URL("..", import.meta.url);
const INDEX_PATH = new URL("../docs/basilisk-unit-test-port-index.json", import.meta.url);

function runChecker(args = []) {
  return spawnSync(
    process.execPath,
    ["scripts/check-basilisk-unit-test-port-index.mjs", ...args],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
    },
  );
}

function writeMutatedIndex(mutate) {
  const index = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
  mutate(index);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdn-basilisk-unit-test-port-index-"));
  const file = path.join(dir, "basilisk-unit-test-port-index.json");
  fs.writeFileSync(file, `${JSON.stringify(index, null, 2)}\n`);
  return file;
}

test("Basilisk Python unit-test port index validates all upstream test files", () => {
  const result = runChecker();
  if (result.status !== 0) {
    throw new Error(`${result.stdout}\n${result.stderr}`);
  }
  assert.match(result.stdout, /validated \d+ Basilisk Python unit-test port mapping\(s\)/);
});

test("Basilisk Python unit-test port index fails closed when an upstream test file is missing", () => {
  const file = writeMutatedIndex((index) => {
    index.mappings.pop();
  });
  const result = runChecker(["--index", file]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing unit-test port mapping/i);
});

test("Basilisk Python unit-test port index fails closed for unknown mapped target modules", () => {
  const file = writeMutatedIndex((index) => {
    const mapped = index.mappings.find((mapping) => mapping.disposition === "mapped");
    mapped.targetModule = "basilisk/missing/module";
  });
  const result = runChecker(["--index", file]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown targetModule/i);
});

test("Basilisk Python unit-test port index fails closed when evidence metadata is missing", () => {
  const file = writeMutatedIndex((index) => {
    index.mappings[0].evidenceKinds = [];
  });
  const result = runChecker(["--index", file]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /evidenceKinds/i);
});

test("Basilisk FSW unit-test sources all map to planned SDN modules", () => {
  const index = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
  const missingPlan = index.mappings
    .filter((mapping) => mapping.upstreamTestFile.startsWith("src/fswAlgorithms/"))
    .filter((mapping) => mapping.disposition === "requires-plan-addition")
    .map((mapping) => `${mapping.upstreamTestFile} -> ${mapping.proposedTargetModule}`);
  assert.deepEqual(missingPlan, []);
});

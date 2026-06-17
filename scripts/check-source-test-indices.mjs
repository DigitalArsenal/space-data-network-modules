#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBasiliskRoot } from "./lib/resolve-basilisk-root.mjs";
import { resolveOrekitRoot } from "./lib/resolve-orekit-root.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const orekitRoot = resolveOrekitRoot(repoRoot);
const basiliskRoot = resolveBasiliskRoot(repoRoot);

const orekitPath = path.join(repoRoot, "docs", "orekit-source-test-index.json");
const basiliskPath = path.join(repoRoot, "docs", "basilisk-source-test-index.json");

assert.ok(fs.existsSync(orekitPath), "missing Orekit source-test index");
assert.ok(fs.existsSync(basiliskPath), "missing Basilisk source-test index");

const orekit = JSON.parse(fs.readFileSync(orekitPath, "utf8"));
const basilisk = JSON.parse(fs.readFileSync(basiliskPath, "utf8"));

assert.equal(orekit.upstream.name, "Orekit");
assert.match(orekit.upstream.commit ?? "", /^[0-9a-f]{40}$/);
assert.equal(orekit.packageCount, orekit.packages.length);
assert.equal(orekit.sourceFileCount, sum(orekit.packages, "sourceFileCount"));
assert.equal(orekit.testClassCount, sum(orekit.packages, "testClassCount"));
assert.ok(orekit.packageCount >= 16, "Orekit package inventory is unexpectedly small");
assert.ok(orekit.sourceFileCount >= 2000, "Orekit source inventory is unexpectedly small");
assert.ok(orekit.testClassCount >= 1000, "Orekit test inventory is unexpectedly small");
for (const requiredPackage of ["time", "frames", "orbits", "propagation", "forces", "attitudes", "estimation", "gnss", "files", "models", "ssa", "control"]) {
  assert.ok(orekit.packages.some((entry) => entry.package === requiredPackage), `missing Orekit package ${requiredPackage}`);
}

assert.equal(basilisk.upstream.name, "Basilisk");
assert.match(basilisk.upstream.commit ?? "", /^[0-9a-f]{40}$/);
assert.equal(basilisk.familyCount, basilisk.families.length);
assert.equal(basilisk.sourceFileCount, sum(basilisk.families, "sourceFileCount"));
assert.equal(basilisk.unitTestFileCount, sum(basilisk.families, "unitTestFileCount"));
assert.ok(basilisk.plannedModuleFamilyCount >= 10, "Basilisk planned family inventory is unexpectedly small");
assert.ok(basilisk.plannedModuleCount >= 170, "Basilisk planned module inventory is unexpectedly small");
assert.ok(basilisk.sourceFileCount >= 650, "Basilisk source inventory is unexpectedly small");
assert.ok(basilisk.unitTestFileCount >= 240, "Basilisk unit-test inventory is unexpectedly small");
for (const requiredFamily of ["architecture", "simulation", "fswAlgorithms", "moduleTemplates"]) {
  assert.ok(basilisk.families.some((entry) => entry.family === requiredFamily), `missing Basilisk family ${requiredFamily}`);
}

compareSourceIfPresent({
  index: orekit,
  root: orekitRoot,
  sourceRoot: path.join(orekitRoot, "src", "main", "java", "org", "orekit"),
  testRoot: path.join(orekitRoot, "src", "test", "java", "org", "orekit"),
  sourcePredicate: (file) => file.endsWith(".java"),
  testPredicate: (file) => file.endsWith("Test.java"),
  sourceCountKey: "sourceFileCount",
  testCountKey: "testClassCount",
  children: orekit.packages,
  childNameKey: "package",
});

compareBasiliskSourceIfPresent();

function compareSourceIfPresent(options) {
  if (!fs.existsSync(options.sourceRoot) || !fs.existsSync(options.testRoot)) {
    return;
  }
  const sourceCount = walk(options.sourceRoot, options.sourcePredicate).length;
  const testCount = walk(options.testRoot, options.testPredicate).length;
  assert.equal(options.index[options.sourceCountKey], sourceCount, `${options.index.upstream.name} source count drifted`);
  assert.equal(options.index[options.testCountKey], testCount, `${options.index.upstream.name} test count drifted`);
  for (const child of options.children) {
    const sourceDir = path.join(options.sourceRoot, child[options.childNameKey]);
    const testDir = path.join(options.testRoot, child[options.childNameKey]);
    assert.equal(child.sourceFileCount, walk(sourceDir, options.sourcePredicate).length, `${options.index.upstream.name} ${child[options.childNameKey]} source count drifted`);
    const testKey = child.testClassCount === undefined ? "unitTestFileCount" : "testClassCount";
    assert.equal(child[testKey], walk(testDir, options.testPredicate).length, `${options.index.upstream.name} ${child[options.childNameKey]} test count drifted`);
  }
}

function compareBasiliskSourceIfPresent() {
  if (!fs.existsSync(path.join(basiliskRoot, "src"))) {
    return;
  }
  const sourceCount = basilisk.families.reduce((total, family) => {
    return total + walk(path.join(basiliskRoot, family.sourceRoot), isBasiliskSource).length;
  }, 0);
  const testCount = basilisk.families.reduce((total, family) => {
    return total + walk(path.join(basiliskRoot, family.sourceRoot), isBasiliskUnitTest).length;
  }, 0);
  assert.equal(basilisk.sourceFileCount, sourceCount, "Basilisk source count drifted");
  assert.equal(basilisk.unitTestFileCount, testCount, "Basilisk unit-test count drifted");
}

function walk(dir, predicate) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return walk(full, predicate);
    }
    return entry.isFile() && predicate(full) ? [full] : [];
  });
}

function isBasiliskSource(file) {
  return [".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp"].includes(path.extname(file));
}

function isBasiliskUnitTest(file) {
  return file.endsWith(".py") && file.includes(`${path.sep}_UnitTest${path.sep}`);
}

function sum(rows, key) {
  return rows.reduce((total, row) => total + row[key], 0);
}

#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBasiliskRoot } from "./lib/resolve-basilisk-root.mjs";
import { resolveOrekitRoot } from "./lib/resolve-orekit-root.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const orekitRoot = resolveOrekitRoot(repoRoot);
const basiliskRoot = resolveBasiliskRoot(repoRoot);

const orekitOutPath = path.join(repoRoot, "docs", "orekit-source-test-index.json");
const basiliskOutPath = path.join(repoRoot, "docs", "basilisk-source-test-index.json");

const orekitSourceRoot = path.join(orekitRoot, "src", "main", "java", "org", "orekit");
const orekitTestRoot = path.join(orekitRoot, "src", "test", "java", "org", "orekit");

const orekitPackages = fs.readdirSync(orekitSourceRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const sourceDir = path.join(orekitSourceRoot, entry.name);
    const testDir = path.join(orekitTestRoot, entry.name);
    const sourceFiles = walk(sourceDir, (file) => file.endsWith(".java"))
      .map((file) => path.relative(orekitRoot, file))
      .sort();
    const testFiles = walk(testDir, (file) => file.endsWith("Test.java"))
      .map((file) => path.relative(orekitRoot, file))
      .sort();
    return {
      package: entry.name,
      sourceFileCount: sourceFiles.length,
      testClassCount: testFiles.length,
      sourceFiles,
      testFiles,
    };
  })
  .sort((a, b) => a.package.localeCompare(b.package));

const orekitIndex = {
  generatedAt: new Date().toISOString(),
  upstream: {
    name: "Orekit",
    repository: "https://gitlab.orekit.org/orekit/orekit.git",
    root: displayRoot(repoRoot, orekitRoot),
    commit: gitCommit(orekitRoot),
  },
  sourceRoot: path.relative(orekitRoot, orekitSourceRoot),
  testRoot: path.relative(orekitRoot, orekitTestRoot),
  packageCount: orekitPackages.length,
  sourceFileCount: sum(orekitPackages, "sourceFileCount"),
  testClassCount: sum(orekitPackages, "testClassCount"),
  packages: orekitPackages,
};

const basiliskFamilies = [
  {
    family: "architecture",
    sourceRoot: "src/architecture",
  },
  {
    family: "simulation",
    sourceRoot: "src/simulation",
  },
  {
    family: "fswAlgorithms",
    sourceRoot: "src/fswAlgorithms",
  },
  {
    family: "moduleTemplates",
    sourceRoot: "src/moduleTemplates",
  },
];

const basiliskIndexFamilies = basiliskFamilies.map((family) => {
  const sourceDir = path.join(basiliskRoot, family.sourceRoot);
  const sourceFiles = walk(sourceDir, isBasiliskSource)
    .map((file) => path.relative(basiliskRoot, file))
    .sort();
  const testFiles = walk(sourceDir, (file) => file.endsWith(".py") && file.includes(`${path.sep}_UnitTest${path.sep}`))
    .map((file) => path.relative(basiliskRoot, file))
    .sort();
  return {
    family: family.family,
    sourceRoot: family.sourceRoot,
    sourceFileCount: sourceFiles.length,
    unitTestFileCount: testFiles.length,
    sourceFiles,
    testFiles,
  };
});

const basiliskPlan = JSON.parse(fs.readFileSync(path.join(repoRoot, "docs", "basilisk-module-plan.json"), "utf8"));
const basiliskIndex = {
  generatedAt: new Date().toISOString(),
  upstream: {
    name: "Basilisk",
    root: displayRoot(repoRoot, basiliskRoot),
    commit: gitCommit(basiliskRoot),
  },
  familyCount: basiliskIndexFamilies.length,
  sourceFileCount: sum(basiliskIndexFamilies, "sourceFileCount"),
  unitTestFileCount: sum(basiliskIndexFamilies, "unitTestFileCount"),
  plannedModuleFamilyCount: basiliskPlan.families.length,
  plannedModuleCount: basiliskPlan.families.reduce((total, family) => total + family.modules.length, 0),
  families: basiliskIndexFamilies,
};

fs.writeFileSync(orekitOutPath, `${JSON.stringify(orekitIndex, null, 2)}\n`);
fs.writeFileSync(basiliskOutPath, `${JSON.stringify(basiliskIndex, null, 2)}\n`);
console.log(`wrote ${path.relative(repoRoot, orekitOutPath)} (${orekitIndex.sourceFileCount} source, ${orekitIndex.testClassCount} tests)`);
console.log(`wrote ${path.relative(repoRoot, basiliskOutPath)} (${basiliskIndex.sourceFileCount} source, ${basiliskIndex.unitTestFileCount} tests)`);

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

function gitCommit(root) {
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function sum(rows, key) {
  return rows.reduce((total, row) => total + row[key], 0);
}

function displayRoot(base, root) {
  if (root.startsWith("/tmp/")) {
    return root;
  }
  return path.relative(base, root);
}

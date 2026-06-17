#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBasiliskRoot } from "./lib/resolve-basilisk-root.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultIndexPath = path.join(repoRoot, "docs", "basilisk-unit-test-port-index.json");
const allowedDispositions = new Set(["mapped", "requires-plan-addition", "deferred", "excluded"]);

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const options = {
    indexPath: defaultIndexPath,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--index") {
      const value = argv[index + 1];
      if (!value) {
        fail("--index requires a file path");
      }
      options.indexPath = path.resolve(repoRoot, value);
      index += 1;
      continue;
    }
    fail(`Unknown argument: ${arg}`);
  }
  return options;
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`Could not read ${label} at ${filePath}: ${error.message}`);
  }
}

function assertRelativePath(value, label, mappingId) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${mappingId}: ${label} must be a non-empty relative path`);
  }
  if (path.isAbsolute(value)) {
    fail(`${mappingId}: ${label} must be relative, got ${value}`);
  }
  const normalized = path.normalize(value);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    fail(`${mappingId}: ${label} must stay inside the expected root, got ${value}`);
  }
  return normalized;
}

function assertNonEmptyString(value, label, mappingId) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${mappingId}: ${label} must be a non-empty string`);
  }
}

function assertNonEmptyArray(value, label, mappingId) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${mappingId}: ${label} must be a non-empty array`);
  }
}

function sourceIndexPath(sourceIndex, mappingId) {
  return path.join(repoRoot, assertRelativePath(sourceIndex, "sourceIndex", mappingId));
}

function modulePlanPath(modulePlan, mappingId) {
  return path.join(repoRoot, assertRelativePath(modulePlan, "modulePlan", mappingId));
}

function collectRequiredUnitTests(sourceIndex) {
  return new Set(sourceIndex.families
    .flatMap((family) => family.testFiles ?? [])
    .filter((file) => path.basename(file).startsWith("test_") && file.endsWith(".py"))
    .sort());
}

function collectKnownUnitTestFiles(sourceIndex) {
  return new Set(sourceIndex.families.flatMap((family) => family.testFiles ?? []));
}

function collectKnownTargetModules(modulePlan) {
  const known = new Set(modulePlan.families.flatMap((family) => family.modules.map((module) => module.modulePath)));
  for (const topLevel of ["foundation", "propagator", "analysis", "basilisk"]) {
    const root = path.join(repoRoot, topLevel);
    if (!fs.existsSync(root)) {
      continue;
    }
    for (const directory of walkDirectories(root)) {
      const rel = path.relative(repoRoot, directory);
      if (fs.existsSync(path.join(directory, "package.json")) || fs.existsSync(path.join(directory, "plugin-manifest.json"))) {
        known.add(rel);
      }
    }
  }
  return known;
}

function walkDirectories(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (!entry.isDirectory() || entry.name === "node_modules" || entry.name === "dist") {
      return [];
    }
    return [full, ...walkDirectories(full)];
  });
}

function validateMapping(mapping, context, ids, seenFiles) {
  if (!mapping || typeof mapping !== "object") {
    fail("Basilisk unit-test port mapping entry must be an object");
  }
  assertNonEmptyString(mapping.id, "id", "<missing-id>");
  if (ids.has(mapping.id)) {
    fail(`duplicate Basilisk unit-test port mapping id ${mapping.id}`);
  }
  ids.add(mapping.id);

  const upstreamTestFile = assertRelativePath(mapping.upstreamTestFile, "upstreamTestFile", mapping.id);
  if (!context.requiredUnitTests.has(upstreamTestFile)) {
    fail(`${mapping.id}: unknown upstreamTestFile ${upstreamTestFile}`);
  }
  if (seenFiles.has(upstreamTestFile)) {
    fail(`duplicate Basilisk unit-test port mapping for ${upstreamTestFile}`);
  }
  seenFiles.add(upstreamTestFile);

  assertNonEmptyArray(mapping.upstreamTestFunctions, "upstreamTestFunctions", mapping.id);
  assertNonEmptyArray(mapping.evidenceKinds, "evidenceKinds", mapping.id);
  for (const kind of mapping.evidenceKinds) {
    assertNonEmptyString(kind, "evidenceKinds[]", mapping.id);
  }

  const upstreamSourcePath = path.join(context.basiliskRoot, upstreamTestFile);
  const upstreamSource = fs.readFileSync(upstreamSourcePath, "utf8");
  for (const testFunction of mapping.upstreamTestFunctions) {
    assertNonEmptyString(testFunction, "upstreamTestFunctions[]", mapping.id);
    if (!upstreamSource.includes(`def ${testFunction}`)) {
      fail(`${mapping.id}: upstream test function ${testFunction} not found in ${upstreamTestFile}`);
    }
  }
  for (const needle of mapping.sourceContains ?? []) {
    assertNonEmptyString(needle, "sourceContains[]", mapping.id);
    if (!upstreamSource.includes(needle)) {
      fail(`${mapping.id}: upstream source string ${needle} not found in ${upstreamTestFile}`);
    }
  }
  for (const supportFile of mapping.supportFiles ?? []) {
    const normalized = assertRelativePath(supportFile, "supportFiles[]", mapping.id);
    if (!context.knownUnitTestFiles.has(normalized)) {
      fail(`${mapping.id}: support file ${normalized} is not present in Basilisk source-test index`);
    }
  }

  assertNonEmptyString(mapping.disposition, "disposition", mapping.id);
  if (!allowedDispositions.has(mapping.disposition)) {
    fail(`${mapping.id}: unknown disposition ${mapping.disposition}`);
  }

  if (mapping.disposition === "mapped") {
    assertNonEmptyString(mapping.targetFamily, "targetFamily", mapping.id);
    assertNonEmptyString(mapping.targetModule, "targetModule", mapping.id);
    if (!context.knownTargetModules.has(mapping.targetModule)) {
      fail(`${mapping.id}: unknown targetModule ${mapping.targetModule}`);
    }
    return;
  }

  if (mapping.disposition === "requires-plan-addition") {
    assertNonEmptyString(mapping.proposedTargetModule, "proposedTargetModule", mapping.id);
    assertNonEmptyString(mapping.reason, "reason", mapping.id);
    return;
  }

  if (mapping.disposition === "deferred") {
    assertNonEmptyString(mapping.proposedTargetModule, "proposedTargetModule", mapping.id);
    assertNonEmptyString(mapping.blocker, "blocker", mapping.id);
    assertNonEmptyString(mapping.reason, "reason", mapping.id);
    return;
  }

  assertNonEmptyString(mapping.exclusionCategory, "exclusionCategory", mapping.id);
  assertNonEmptyString(mapping.reason, "reason", mapping.id);
}

function main() {
  const { indexPath } = parseArgs(process.argv.slice(2));
  const document = readJson(indexPath, "Basilisk unit-test port index");
  if (document.schemaVersion !== 1) {
    fail(`Basilisk unit-test port index schemaVersion must be 1, got ${document.schemaVersion}`);
  }
  const sourceIndex = readJson(sourceIndexPath(document.sourceIndex, "basilisk-unit-test-port-index"), "Basilisk source-test index");
  const modulePlan = readJson(modulePlanPath(document.modulePlan, "basilisk-unit-test-port-index"), "Basilisk module plan");
  const context = {
    basiliskRoot: resolveBasiliskRoot(repoRoot),
    requiredUnitTests: collectRequiredUnitTests(sourceIndex),
    knownUnitTestFiles: collectKnownUnitTestFiles(sourceIndex),
    knownTargetModules: collectKnownTargetModules(modulePlan),
  };

  assertNonEmptyArray(document.mappings, "mappings", "basilisk-unit-test-port-index");
  const ids = new Set();
  const seenFiles = new Set();
  const dispositionCounts = {};
  for (const mapping of document.mappings) {
    validateMapping(mapping, context, ids, seenFiles);
    dispositionCounts[mapping.disposition] = (dispositionCounts[mapping.disposition] ?? 0) + 1;
  }

  for (const requiredFile of context.requiredUnitTests) {
    if (!seenFiles.has(requiredFile)) {
      fail(`missing unit-test port mapping for ${requiredFile}`);
    }
  }
  if (seenFiles.size !== context.requiredUnitTests.size) {
    fail(`expected ${context.requiredUnitTests.size} Basilisk unit-test mappings, got ${seenFiles.size}`);
  }

  console.log(
    `validated ${seenFiles.size} Basilisk Python unit-test port mapping(s): `
    + Object.entries(dispositionCounts).map(([key, value]) => `${key}=${value}`).join(", "),
  );
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

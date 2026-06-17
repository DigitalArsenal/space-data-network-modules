#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBasiliskRoot } from "./lib/resolve-basilisk-root.mjs";
import { resolveOrekitRoot } from "./lib/resolve-orekit-root.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultIndexPath = path.join(repoRoot, "docs/test-vector-extraction-index.json");

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

function sourceIndexPath(sourceIndex, mappingId) {
  return path.join(repoRoot, assertRelativePath(sourceIndex, "sourceIndex", mappingId));
}

function collectOrekitTestFiles(sourceIndex) {
  return new Set((sourceIndex.packages ?? []).flatMap((entry) => entry.testFiles ?? []));
}

function collectBasiliskFiles(sourceIndex, key) {
  return new Set((sourceIndex.families ?? []).flatMap((entry) => entry[key] ?? []));
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

function assertOptionalSourceContains(mapping, upstreamRoot) {
  if (!Array.isArray(mapping.sourceContains) || mapping.sourceContains.length === 0) {
    return;
  }
  const upstreamFile = path.join(upstreamRoot, mapping.upstreamTestFile);
  if (!fs.existsSync(upstreamFile)) {
    return;
  }
  const source = fs.readFileSync(upstreamFile, "utf8");
  for (const needle of mapping.sourceContains) {
    assertNonEmptyString(needle, "sourceContains[]", mapping.id);
    if (!source.includes(needle)) {
      fail(`${mapping.id}: upstream source string ${needle} not found in ${mapping.upstreamTestFile}`);
    }
  }
}

function assertSdnTests(mapping) {
  const modulePath = path.join(repoRoot, assertRelativePath(mapping.sdnModule, "sdnModule", mapping.id));
  if (!fs.existsSync(modulePath) || !fs.statSync(modulePath).isDirectory()) {
    fail(`${mapping.id}: missing SDN module directory at ${modulePath}`);
  }
  assertNonEmptyArray(mapping.sdnTests, "sdnTests", mapping.id);
  for (const sdnTest of mapping.sdnTests) {
    const relativeFile = assertRelativePath(sdnTest.file, "sdnTests[].file", mapping.id);
    assertNonEmptyString(sdnTest.name, "sdnTests[].name", mapping.id);
    const testFile = path.join(repoRoot, relativeFile);
    if (!fs.existsSync(testFile)) {
      fail(`${mapping.id}: missing SDN test file at ${testFile}`);
    }
    const source = fs.readFileSync(testFile, "utf8");
    if (!source.includes(sdnTest.name)) {
      fail(`${mapping.id}: SDN test name ${sdnTest.name} not found in ${relativeFile}`);
    }
  }
}

function assertEvidenceFields(mapping) {
  assertNonEmptyArray(mapping.quantities, "quantities", mapping.id);
  for (const quantity of mapping.quantities) {
    assertNonEmptyString(quantity, "quantities[]", mapping.id);
  }
  assertNonEmptyString(mapping.units, "units", mapping.id);
  assertNonEmptyString(mapping.tolerance, "tolerance", mapping.id);
}

function validateOrekitMappings(document) {
  const section = document.orekit;
  if (!section) {
    fail("missing orekit section");
  }
  const sourceIndex = readJson(sourceIndexPath(section.sourceIndex, "orekit"), "Orekit source-test index");
  const knownTestFiles = collectOrekitTestFiles(sourceIndex);
  const orekitRoot = resolveOrekitRoot(repoRoot);
  assertNonEmptyArray(section.mappings, "orekit.mappings", "orekit");
  const ids = new Set();
  for (const mapping of section.mappings) {
    validateCommonMapping(mapping, ids);
    if (!knownTestFiles.has(mapping.upstreamTestFile)) {
      fail(`${mapping.id}: missing Orekit upstream test file ${mapping.upstreamTestFile}`);
    }
    assertOptionalSourceContains(mapping, orekitRoot);
    assertSdnTests(mapping);
    assertEvidenceFields(mapping);
  }
  return section.mappings.length;
}

function validateBasiliskMappings(document) {
  const section = document.basilisk;
  if (!section) {
    fail("missing basilisk section");
  }
  const sourceIndex = readJson(sourceIndexPath(section.sourceIndex, "basilisk"), "Basilisk source-test index");
  const sourceFiles = collectBasiliskFiles(sourceIndex, "sourceFiles");
  const unitTestFiles = collectBasiliskFiles(sourceIndex, "testFiles");
  const basiliskRoot = resolveBasiliskRoot(repoRoot);
  assertNonEmptyArray(section.mappings, "basilisk.mappings", "basilisk");
  const ids = new Set();
  for (const mapping of section.mappings) {
    validateCommonMapping(mapping, ids);
    const kind = mapping.upstreamFileKind ?? "unitTestFile";
    const knownFiles = kind === "sourceFile" ? sourceFiles : unitTestFiles;
    if (!knownFiles.has(mapping.upstreamTestFile)) {
      fail(`${mapping.id}: missing Basilisk upstream test file ${mapping.upstreamTestFile}`);
    }
    assertOptionalSourceContains(mapping, basiliskRoot);
    assertSdnTests(mapping);
    assertEvidenceFields(mapping);
  }
  return section.mappings.length;
}

function validateCommonMapping(mapping, ids) {
  if (!mapping || typeof mapping !== "object") {
    fail("test-vector mapping entry must be an object");
  }
  assertNonEmptyString(mapping.id, "id", "<missing-id>");
  if (ids.has(mapping.id)) {
    fail(`duplicate test-vector mapping id ${mapping.id}`);
  }
  ids.add(mapping.id);
  assertRelativePath(mapping.upstreamTestFile, "upstreamTestFile", mapping.id);
  assertNonEmptyString(mapping.upstreamTestMethod, "upstreamTestMethod", mapping.id);
}

function main() {
  const { indexPath } = parseArgs(process.argv.slice(2));
  const document = readJson(indexPath, "test-vector extraction index");
  if (document.schemaVersion !== 1) {
    fail(`test-vector extraction index schemaVersion must be 1, got ${document.schemaVersion}`);
  }
  const orekitCount = validateOrekitMappings(document);
  const basiliskCount = validateBasiliskMappings(document);
  console.log(`validated ${orekitCount} Orekit and ${basiliskCount} Basilisk test-vector mappings`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

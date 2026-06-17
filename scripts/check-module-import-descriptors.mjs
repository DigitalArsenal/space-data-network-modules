#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultDescriptorPath = path.join(repoRoot, "docs/module-import-descriptors.json");

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const options = {
    descriptorPath: defaultDescriptorPath,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--descriptor") {
      const value = argv[index + 1];
      if (!value) {
        fail("--descriptor requires a file path");
      }
      options.descriptorPath = path.resolve(repoRoot, value);
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

function assertRelativePath(value, label, descriptorId) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${descriptorId}: ${label} must be a non-empty relative path`);
  }
  if (path.isAbsolute(value)) {
    fail(`${descriptorId}: ${label} must be relative, got ${value}`);
  }
  const normalized = path.normalize(value);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    fail(`${descriptorId}: ${label} must stay inside the module repo, got ${value}`);
  }
  return normalized;
}

function manifestPathFor(modulePath, descriptorId) {
  const relativeModulePath = assertRelativePath(modulePath, "modulePath", descriptorId);
  return path.join(repoRoot, relativeModulePath, "plugin-manifest.json");
}

function loadManifest(role, moduleRef, descriptorId) {
  const manifestPath = manifestPathFor(moduleRef.modulePath, descriptorId);
  if (!fs.existsSync(manifestPath)) {
    fail(`${descriptorId}: missing ${role} manifest at ${manifestPath}`);
  }
  const manifest = readJson(manifestPath, `${role} manifest`);
  if (manifest.pluginId !== moduleRef.pluginId) {
    fail(
      `${descriptorId}: ${role} pluginId ${manifest.pluginId ?? "<missing>"} does not match ${moduleRef.pluginId}`,
    );
  }
  return manifest;
}

function findMethod(manifest, moduleRef, role, descriptorId) {
  const method = (manifest.methods ?? []).find(
    (candidate) => candidate.methodId === moduleRef.methodId,
  );
  if (!method) {
    fail(`${descriptorId}: ${role} method ${moduleRef.methodId} is not declared`);
  }
  return method;
}

function portListKey(direction, descriptorId, role) {
  if (direction === "input") {
    return "inputPorts";
  }
  if (direction === "output") {
    return "outputPorts";
  }
  fail(`${descriptorId}: ${role} direction must be input or output`);
}

function findPort(method, moduleRef, role, descriptorId) {
  const listKey = portListKey(moduleRef.direction, descriptorId, role);
  const port = (method[listKey] ?? []).find((candidate) => candidate.portId === moduleRef.portId);
  if (!port) {
    fail(
      `${descriptorId}: ${role} ${moduleRef.direction} port ${moduleRef.portId} is not declared on ${moduleRef.methodId}`,
    );
  }
  return port;
}

function allowedTypesFor(port) {
  return (port.acceptedTypeSets ?? []).flatMap((typeSet) => typeSet.allowedTypes ?? []);
}

function hasExpectedField(candidate, field, expectedValue) {
  if (field === "wireFormat" && expectedValue === "flatbuffer") {
    return candidate.wireFormat === undefined || candidate.wireFormat === "flatbuffer";
  }
  return candidate[field] === expectedValue;
}

function assertPortAcceptsType(port, typeRef, role, descriptorId) {
  const allowedTypes = allowedTypesFor(port);
  if (allowedTypes.length === 0) {
    fail(`${descriptorId}: ${role} ${port.portId} has no allowed FlatBuffer types`);
  }

  const fields = [
    "schemaName",
    "fileIdentifier",
    "rootTypeName",
    "wireFormat",
    "requiredAlignment",
  ];
  for (const field of fields) {
    if (typeRef[field] === undefined) {
      continue;
    }
    if (!allowedTypes.some((candidate) => hasExpectedField(candidate, field, typeRef[field]))) {
      fail(`${descriptorId}: ${role} port ${port.portId} does not include ${field} ${typeRef[field]}`);
    }
  }

  const compatibleType = allowedTypes.find((candidate) =>
    fields.every((field) => typeRef[field] === undefined || hasExpectedField(candidate, field, typeRef[field])),
  );
  if (!compatibleType) {
    fail(`${descriptorId}: ${role} port ${port.portId} has no single type matching the descriptor typeRef`);
  }
}

function parseVersion(version) {
  if (typeof version !== "string") {
    fail(`Invalid version value ${version}`);
  }
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) {
    fail(`Unsupported semantic version: ${version}`);
  }
  return match.slice(1, 4).map((part) => Number(part));
}

function compareVersions(left, right) {
  const parsedLeft = parseVersion(left);
  const parsedRight = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (parsedLeft[index] !== parsedRight[index]) {
      return parsedLeft[index] - parsedRight[index];
    }
  }
  return 0;
}

function satisfiesComparator(version, comparator) {
  const match = comparator.match(/^(>=|<=|>|<|=)?(\d+\.\d+\.\d+(?:[-+][^\s]+)?)$/);
  if (!match) {
    fail(`Unsupported version comparator: ${comparator}`);
  }
  const operator = match[1] ?? "=";
  const target = match[2];
  const comparison = compareVersions(version, target);
  switch (operator) {
    case ">=":
      return comparison >= 0;
    case "<=":
      return comparison <= 0;
    case ">":
      return comparison > 0;
    case "<":
      return comparison < 0;
    case "=":
      return comparison === 0;
    default:
      fail(`Unsupported version operator: ${operator}`);
  }
}

function satisfiesVersionRange(version, range) {
  if (range === undefined) {
    return true;
  }
  if (typeof range !== "string" || range.trim().length === 0) {
    fail("providerVersionRange must be a non-empty string when provided");
  }
  return range.trim().split(/\s+/).every((comparator) => satisfiesComparator(version, comparator));
}

function assertFixtureExists(fixturePath, descriptorId) {
  const relativeFixturePath = assertRelativePath(fixturePath, "fixture", descriptorId);
  const absoluteFixturePath = path.join(repoRoot, relativeFixturePath);
  if (!fs.existsSync(absoluteFixturePath)) {
    fail(`${descriptorId}: fixture does not exist at ${absoluteFixturePath}`);
  }
}

function validateDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== "object") {
    fail("Descriptor entry must be an object");
  }
  const descriptorId = descriptor.id ?? "<missing-id>";
  if (typeof descriptor.id !== "string" || descriptor.id.length === 0) {
    fail("Descriptor id must be a non-empty string");
  }
  if (descriptor.transport !== "host-piv-tab" && descriptor.transport !== "module-piv-tab") {
    fail(`${descriptorId}: transport must be host-piv-tab or module-piv-tab`);
  }
  if (!descriptor.provider || !descriptor.consumer || !descriptor.typeRef) {
    fail(`${descriptorId}: provider, consumer, and typeRef are required`);
  }

  const providerManifest = loadManifest("provider", descriptor.provider, descriptorId);
  const consumerManifest = loadManifest("consumer", descriptor.consumer, descriptorId);
  const providerMethod = findMethod(providerManifest, descriptor.provider, "provider", descriptorId);
  const consumerMethod = findMethod(consumerManifest, descriptor.consumer, "consumer", descriptorId);
  const providerPort = findPort(providerMethod, descriptor.provider, "provider", descriptorId);
  const consumerPort = findPort(consumerMethod, descriptor.consumer, "consumer", descriptorId);

  if (descriptor.provider.direction !== "output") {
    fail(`${descriptorId}: provider direction must be output`);
  }
  if (descriptor.consumer.direction !== "input") {
    fail(`${descriptorId}: consumer direction must be input`);
  }

  assertPortAcceptsType(providerPort, descriptor.typeRef, "provider output", descriptorId);
  assertPortAcceptsType(consumerPort, descriptor.typeRef, "consumer input", descriptorId);

  const providerVersionRange = descriptor.dependency?.providerVersionRange;
  if (!satisfiesVersionRange(providerManifest.version, providerVersionRange)) {
    fail(
      `${descriptorId}: provider version ${providerManifest.version} does not satisfy ${providerVersionRange}`,
    );
  }

  if (descriptor.status === "verified") {
    assertFixtureExists(descriptor.fixture, descriptorId);
  }
}

function main() {
  const { descriptorPath } = parseArgs(process.argv.slice(2));
  const document = readJson(descriptorPath, "module import descriptor document");
  if (document.schemaVersion !== 1) {
    fail(`module import descriptor schemaVersion must be 1, got ${document.schemaVersion}`);
  }
  if (!Array.isArray(document.imports) || document.imports.length === 0) {
    fail("module import descriptor document must contain at least one import");
  }

  const ids = new Set();
  for (const descriptor of document.imports) {
    if (ids.has(descriptor.id)) {
      fail(`Duplicate module import descriptor id: ${descriptor.id}`);
    }
    ids.add(descriptor.id);
    validateDescriptor(descriptor);
  }

  console.log(`validated ${document.imports.length} module import descriptor(s)`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

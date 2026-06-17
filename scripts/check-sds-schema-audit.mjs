#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultAuditPath = path.join(repoRoot, "docs/sds-schema-audit.json");
const requiredDomainIds = [
  "time",
  "frames",
  "orbit-state",
  "attitude-state",
  "earth-environment",
  "observations",
  "gnss-products",
  "image-products",
  "actuator-commands",
  "power",
  "thermal",
  "runtime-telemetry",
];
const partialStatuses = new Set(["partial", "missing", "blocked"]);
const allowedStatuses = new Set(["covered", ...partialStatuses]);

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const options = {
    auditPath: defaultAuditPath,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--audit") {
      const value = argv[index + 1];
      if (!value) {
        fail("--audit requires a file path");
      }
      options.auditPath = path.resolve(repoRoot, value);
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

function assertRelativePath(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a non-empty relative path`);
  }
  if (path.isAbsolute(value)) {
    fail(`${label} must be relative, got ${value}`);
  }
  const normalized = path.normalize(value);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    fail(`${label} must stay inside the expected root, got ${value}`);
  }
  return normalized;
}

function assertNonEmptyString(value, label, domainId) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${domainId}: ${label} must be a non-empty string`);
  }
}

function assertStringArray(value, label, domainId, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    fail(`${domainId}: ${label} must be a ${allowEmpty ? "string array" : "non-empty string array"}`);
  }
  for (const entry of value) {
    assertNonEmptyString(entry, `${label}[]`, domainId);
  }
}

function schemaRootFor(audit) {
  if (typeof audit.standardsSchemaRoot !== "string" || audit.standardsSchemaRoot.length === 0) {
    fail("standardsSchemaRoot must be a non-empty relative path");
  }
  if (path.isAbsolute(audit.standardsSchemaRoot)) {
    fail(`standardsSchemaRoot must be relative, got ${audit.standardsSchemaRoot}`);
  }
  const relativeSchemaRoot = path.normalize(audit.standardsSchemaRoot);
  const schemaRoot = path.resolve(repoRoot, relativeSchemaRoot);
  if (!fs.existsSync(schemaRoot)) {
    fail(`standards schema root does not exist at ${schemaRoot}`);
  }
  return schemaRoot;
}

function validateSchemaReference(schemaRoot, schemaRef, domainId) {
  if (!schemaRef || typeof schemaRef !== "object") {
    fail(`${domainId}: existingSchemas entries must be objects`);
  }
  assertNonEmptyString(schemaRef.schema, "existingSchemas[].schema", domainId);
  assertNonEmptyString(schemaRef.purpose, "existingSchemas[].purpose", domainId);
  const schemaPath = path.join(schemaRoot, schemaRef.schema, "main.fbs");
  if (!fs.existsSync(schemaPath)) {
    fail(`${domainId}: schema ${schemaRef.schema} does not exist at ${schemaPath}`);
  }
  if (schemaRef.fileIdentifier !== undefined) {
    assertNonEmptyString(schemaRef.fileIdentifier, "existingSchemas[].fileIdentifier", domainId);
    const source = fs.readFileSync(schemaPath, "utf8");
    if (!source.includes(`file_identifier "${schemaRef.fileIdentifier}"`)) {
      fail(`${domainId}: schema ${schemaRef.schema} does not declare file_identifier ${schemaRef.fileIdentifier}`);
    }
  }
}

function validateDomain(domain, schemaRoot) {
  if (!domain || typeof domain !== "object") {
    fail("domain entries must be objects");
  }
  assertNonEmptyString(domain.id, "id", "<missing-domain>");
  assertNonEmptyString(domain.label, "label", domain.id);
  if (!allowedStatuses.has(domain.status)) {
    fail(`${domain.id}: status must be one of ${Array.from(allowedStatuses).join(", ")}`);
  }
  assertStringArray(domain.requiredRecords, "requiredRecords", domain.id);
  assertStringArray(domain.downstreamConsumers, "downstreamConsumers", domain.id);
  assertStringArray(domain.gaps, "gaps", domain.id, { allowEmpty: true });
  assertStringArray(domain.nextSdsActions, "nextSdsActions", domain.id, { allowEmpty: true });

  if (partialStatuses.has(domain.status) && domain.gaps.length === 0) {
    fail(`${domain.status} domain ${domain.id} must list gaps`);
  }
  if (partialStatuses.has(domain.status) && domain.nextSdsActions.length === 0) {
    fail(`${domain.status} domain ${domain.id} must list nextSdsActions`);
  }
  if (!Array.isArray(domain.existingSchemas)) {
    fail(`${domain.id}: existingSchemas must be an array`);
  }
  if (domain.status !== "missing" && domain.existingSchemas.length === 0) {
    fail(`${domain.id}: non-missing domain must list at least one existing schema`);
  }
  for (const schemaRef of domain.existingSchemas) {
    validateSchemaReference(schemaRoot, schemaRef, domain.id);
  }
}

function main() {
  const { auditPath } = parseArgs(process.argv.slice(2));
  const audit = readJson(auditPath, "SDS schema audit");
  if (audit.schemaVersion !== 1) {
    fail(`SDS schema audit schemaVersion must be 1, got ${audit.schemaVersion}`);
  }
  assertNonEmptyString(audit.generatedFor, "generatedFor", "audit");
  assertNonEmptyString(audit.sdsFirstPolicy, "sdsFirstPolicy", "audit");
  if (!Array.isArray(audit.domains)) {
    fail("audit domains must be an array");
  }

  const schemaRoot = schemaRootFor(audit);
  const domainsById = new Map();
  for (const domain of audit.domains) {
    if (domainsById.has(domain.id)) {
      fail(`duplicate SDS schema audit domain ${domain.id}`);
    }
    domainsById.set(domain.id, domain);
  }
  for (const requiredDomainId of requiredDomainIds) {
    if (!domainsById.has(requiredDomainId)) {
      fail(`missing required domain ${requiredDomainId}`);
    }
  }
  for (const domain of audit.domains) {
    validateDomain(domain, schemaRoot);
  }

  console.log(`validated ${requiredDomainIds.length} SDS schema audit domain(s)`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

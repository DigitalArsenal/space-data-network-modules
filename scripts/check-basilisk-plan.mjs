#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const basiliskRoot = path.resolve(repoRoot, process.env.BASILISK_ROOT ?? "../basilisk");
const planPath = path.join(repoRoot, "docs", "basilisk-module-plan.json");
const mapPath = path.join(repoRoot, "docs", "basilisk-message-standards.json");

const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
const messageMap = JSON.parse(fs.readFileSync(mapPath, "utf8"));

assert.equal(plan.artifactContract.primaryArtifact, "dist/isomorphic/module.wasm");
assert.equal(plan.artifactContract.browserAndWasmEdgeSameArtifact, true);
assert.equal(plan.artifactContract.manifestSchema, "PLG");
assert.equal(plan.artifactContract.invokeEnvelope, "PIV");
assert.equal(plan.artifactContract.payloadFrame, "TAB");
assert.ok(plan.families.length >= 10, "expected runtime plus Basilisk capability families");

for (const family of plan.families) {
  assert.ok(family.id, "family id is required");
  assert.ok(Array.isArray(family.modules), `family ${family.id} missing modules`);
  for (const module of family.modules) {
    assert.ok(module.name, `family ${family.id} has unnamed module`);
    assert.ok(module.modulePath?.startsWith("basilisk/"), `${module.name} has invalid module path`);
    assert.ok(module.standards?.primarySchemas?.length > 0, `${module.name} missing standards`);
    if (module.standards.xtceRequired) {
      assert.ok(module.standards.primarySchemas.includes("XTC"), `${module.name} requires XTCE but omits XTC`);
    }
    assert.equal(module.standards.invokeEnvelope, "PIV", `${module.name} must use PIV`);
    assert.equal(module.standards.payloadFrame, "TAB", `${module.name} must use TAB`);
    assert.equal(module.standards.manifest, "PLG", `${module.name} must use PLG`);
    assert.equal(module.standards.publication, "PNM", `${module.name} must use PNM`);
    assert.ok(module.authoritativeTests?.length > 0, `${module.name} missing authoritative tests`);
    for (const test of module.authoritativeTests) {
      assert.ok(test.source, `${module.name} test missing source`);
      assert.ok(test.units, `${module.name} test missing units`);
      assert.ok(test.frame, `${module.name} test missing frame`);
      assert.ok(test.timeScale, `${module.name} test missing time scale`);
      assert.ok(test.tolerance, `${module.name} test missing tolerance`);
    }
    assert.ok(module.runtimeTargets.includes("browser"), `${module.name} missing browser target`);
    assert.ok(module.runtimeTargets.includes("wasmedge"), `${module.name} missing WasmEdge target`);
    assert.equal(module.failClosedOnMissingStandards, true, `${module.name} must fail closed`);
  }
}

const payloadFiles = [
  ...walk(path.join(basiliskRoot, "src/architecture/msgPayloadDefC")),
  ...walk(path.join(basiliskRoot, "src/architecture/msgPayloadDefCpp")),
];
assert.equal(messageMap.payloadCount, payloadFiles.length, "payload map count must match Basilisk payload headers");
const mappedPayloads = new Set(messageMap.payloads.map((entry) => entry.upstreamPath));
for (const payloadFile of payloadFiles) {
  assert.ok(mappedPayloads.has(path.relative(basiliskRoot, payloadFile)), `missing payload mapping for ${payloadFile}`);
}
for (const row of messageMap.payloads) {
  assert.ok(row.basiliskPayload, "payload row missing name");
  assert.ok(row.basiliskOwner, `${row.basiliskPayload} missing owner`);
  assert.ok(row.sdsSchemas.length > 0, `${row.basiliskPayload} missing SDS schemas`);
  assert.equal(row.wireFormat.includes("TAB"), true, `${row.basiliskPayload} missing TAB wire format`);
  assert.ok(row.unitsFrameEpochTimeScale, `${row.basiliskPayload} missing units/frame/time`);
  assert.ok(row.validationFixture, `${row.basiliskPayload} missing validation fixture`);
  if (row.xtceRequired) {
    assert.ok(row.sdsSchemas.includes("XTC"), `${row.basiliskPayload} requires XTCE but omits XTC`);
  }
}

function walk(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return walk(full);
    }
    return entry.isFile() && entry.name.endsWith(".h") ? [full] : [];
  });
}

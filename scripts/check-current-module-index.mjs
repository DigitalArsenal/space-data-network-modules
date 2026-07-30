#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCurrentModuleIndex } from "./lib/current-module-index.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const indexPath = path.join(repoRoot, "docs", "current-module-parity-index.json");

assert.ok(fs.existsSync(indexPath), "missing current module parity index");

const checked = JSON.parse(fs.readFileSync(indexPath, "utf8"));
const current = createCurrentModuleIndex(repoRoot);
// analysis/sensor-coverage and analysis/sensor-model were the only remaining
// parity-scope modules without both browser and WasmEdge runtime targets; both
// moved to space-data-network-closed-modules, so this list is now empty.
const expectedParityScopeTargetGaps = [];

assert.equal(checked.moduleCount, current.moduleCount, "module count drifted");
assert.equal(checked.parityScopeModuleCount, current.parityScopeModuleCount, "parity module count drifted");
assert.equal(checked.isomorphicWasmCount, current.isomorphicWasmCount, "isomorphic artifact count drifted");
assert.deepEqual(checked.missingIsomorphicWasm, current.missingIsomorphicWasm, "missing isomorphic artifact list drifted");
assert.deepEqual(checked.parityScopeMissingCxx, current.parityScopeMissingCxx, "parity C/C++ gap list drifted");
assert.deepEqual(checked.parityScopeTargetGaps, current.parityScopeTargetGaps, "parity runtime target gap list drifted");

assert.ok(checked.moduleCount >= 31, "current module inventory is unexpectedly small");
assert.ok(checked.parityScopeModuleCount >= 14, "parity-scope module inventory is unexpectedly small");
assert.ok(checked.isomorphicWasmCount >= 29, "isomorphic module inventory is unexpectedly small");
assert.deepEqual(checked.missingIsomorphicWasm.sort(), []);
assert.deepEqual(checked.parityScopeMissingCxx.sort(), []);
assert.deepEqual(
  checked.parityScopeTargetGaps.sort(),
  expectedParityScopeTargetGaps,
  "unexpected parity runtime target gaps",
);

for (const requiredModule of [
  "analysis/conjunction-assessment",
  "analysis/lambert-izzo",
  "analysis/maneuver",
  "analysis/od",
  "basilisk/runtime",
  "propagator/atmosphere",
  "propagator/cislunar",
  "propagator/hpop",
  "propagator/sgp4",
]) {
  assert.ok(
    checked.modules.some((entry) => entry.modulePath === requiredModule),
    `missing current module ${requiredModule}`,
  );
}

for (const module of checked.modules) {
  assert.ok(module.modulePath, "module row missing path");
  assert.ok(module.pluginId, `${module.modulePath} missing pluginId`);
  assert.ok(Array.isArray(module.runtimeTargets), `${module.modulePath} missing runtimeTargets`);
  assert.ok(Array.isArray(module.methodIds), `${module.modulePath} missing methodIds`);
}

#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCurrentModuleIndex, trackedFiles } from "./lib/current-module-index.mjs";

// Every git call names its repository with -C; one a calling hook or tool selected through the environment must not redirect it.
for (const name of Object.keys(process.env)) {
  if (name.startsWith("GIT_")) delete process.env[name];
}

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
assert.deepEqual(checked.buildsOnDemand, current.buildsOnDemand, "build-on-demand module list drifted");
assert.deepEqual(checked.parityScopeMissingCxx, current.parityScopeMissingCxx, "parity C/C++ gap list drifted");
assert.deepEqual(checked.parityScopeTargetGaps, current.parityScopeTargetGaps, "parity runtime target gap list drifted");

assert.ok(checked.moduleCount >= 31, "current module inventory is unexpectedly small");
assert.ok(checked.parityScopeModuleCount >= 14, "parity-scope module inventory is unexpectedly small");
assert.ok(checked.isomorphicWasmCount >= 29, "isomorphic module inventory is unexpectedly small");
// A flow package that is source (package.json main) and has no wasm of its own: it is composed from modules at ingress and bakes no artifact.
const sourceFlows = ["flows/observation-ap"];
for (const modulePath of sourceFlows) {
  const main = JSON.parse(fs.readFileSync(path.join(repoRoot, modulePath, "package.json"), "utf8")).main;
  assert.ok(main && fs.existsSync(path.join(repoRoot, modulePath, main)), `${modulePath} is listed as a source flow but has no main file`);
}
assert.deepEqual(checked.missingIsomorphicWasm.sort(), sourceFlows);
// A module with no committed artifact builds one: it, or the module it sits under, has a build script.
for (const modulePath of checked.buildsOnDemand) {
  let directory = path.join(repoRoot, modulePath);
  while (directory.startsWith(repoRoot) && directory !== repoRoot && !fs.existsSync(path.join(directory, "build.mjs"))) directory = path.dirname(directory);
  assert.ok(directory !== repoRoot, `${modulePath} has no committed artifact and no build.mjs to make one`);
}
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
  "propagator/ffm",
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

// The index counts tracked files only. On a temporary copy of the tracked tree (never in this checkout) plant what a build leaves
// behind: plugin manifests and C++ sources under git-ignored paths and under an untracked one. The index must not move. The same
// manifest and C++ file, once tracked, must be counted: the plant is a real module, and only git's tracked list excludes it.
const plantedManifest = '{"pluginId":"leftover","name":"Leftover","version":"0.0.0","pluginFamily":"analysis","runtimeTargets":["browser","wasmedge"],"methods":[{"methodId":"leftover"}]}\n';
const plantedSource = "int leftover() { return 0; }\n";
const ignoredManifest = "packages/python-astro/src/spacedatanetwork_astro/artifacts/leftover/plugin-manifest.json"; // packages/python-astro/.gitignore
const ignoredBuildManifest = "analysis/od/.build-operator/plugin-manifest.json"; // analysis/od/.gitignore
const ignoredBuildSource = "analysis/od/.build-operator/src/leftover.cpp";
const ignoredLeftovers = [[ignoredManifest, plantedManifest], [ignoredBuildManifest, plantedManifest], [ignoredBuildSource, plantedSource]];
const untrackedLeftovers = [["analysis/leftover-untracked/plugin-manifest.json", plantedManifest], ["analysis/od/src/cpp/leftover-untracked.cpp", plantedSource]];
const withoutStamp = ({ generatedAt, ...rest }) => rest;
const odOf = (index) => index.modules.find((entry) => entry.modulePath === "analysis/od");

function plantLeftovers(expected) {
  const files = trackedFiles(repoRoot);
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), "module-index-leftovers-"));
  const git = (...args) => execFileSync("git", ["-C", copy, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const isIgnored = (file) => {
    const { status } = spawnSync("git", ["-C", copy, "check-ignore", "-q", file]);
    assert.ok(status === 0 || status === 1, `git check-ignore failed (${status}) on ${file}`);
    return status === 0;
  };
  try {
    for (const file of files) {
      fs.mkdirSync(path.dirname(path.join(copy, file)), { recursive: true });
      fs.copyFileSync(path.join(repoRoot, file), path.join(copy, file), fs.constants.COPYFILE_FICLONE);
    }
    git("init", "-q");
    execFileSync("git", ["-C", copy, "update-index", "--add", "--info-only", "-z", "--stdin"], { input: `${files.join("\0")}\0`, maxBuffer: 1 << 28 });
    const before = createCurrentModuleIndex(copy);
    assert.deepEqual(withoutStamp(before), withoutStamp(expected), "a copy of the tracked tree indexes differently from the checkout");

    for (const [file, text] of [...ignoredLeftovers, ...untrackedLeftovers]) {
      fs.mkdirSync(path.dirname(path.join(copy, file)), { recursive: true });
      fs.writeFileSync(path.join(copy, file), text);
    }
    for (const [file] of ignoredLeftovers) assert.ok(isIgnored(file), `${file} is no longer git-ignored: plant a path an ignore rule covers`);
    for (const [file] of untrackedLeftovers) assert.ok(!isIgnored(file), `${file} is git-ignored: plant an untracked path no rule covers`);
    const after = createCurrentModuleIndex(copy);
    assert.deepEqual(withoutStamp(after), withoutStamp(before), "ignored or untracked leftovers changed the module index");

    git("update-index", "--add", "--info-only", ignoredManifest, ignoredBuildSource);
    const counted = createCurrentModuleIndex(copy);
    assert.equal(counted.moduleCount, before.moduleCount + 1, "a tracked plugin manifest was not counted as a module");
    assert.ok(counted.modules.some((entry) => entry.modulePath === path.posix.dirname(ignoredManifest)), "the tracked planted module is missing");
    assert.equal(odOf(counted).cxxSourceFileCount, odOf(before).cxxSourceFileCount + 1, "a tracked C++ file was not counted for analysis/od");
    return { files: files.length, planted: ignoredLeftovers.length + untrackedLeftovers.length, ignored: ignoredLeftovers.length, before, after, counted };
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
}

const proof = plantLeftovers(current);
console.log(
  `PASS current module index: ${checked.moduleCount} modules (${checked.isomorphicWasmCount} isomorphic, ${checked.parityScopeModuleCount} in parity scope) equal a fresh scan of ${trackedFiles(repoRoot).length} tracked files; ` +
    `on a copy of ${proof.files} of them, ${proof.planted} planted leftovers (${proof.ignored} git-ignored, ${proof.planted - proof.ignored} untracked) leave ${proof.after.moduleCount} modules and analysis/od at ${odOf(proof.after).cxxSourceFileCount} C++ files (before ${proof.before.moduleCount} and ${odOf(proof.before).cxxSourceFileCount}); ` +
    `tracked, the same manifest and C++ file make ${proof.counted.moduleCount} and ${odOf(proof.counted).cxxSourceFileCount}`,
);

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function defaultPackageList(scriptPath) {
  const source = fs.readFileSync(path.join(repoRoot, scriptPath), "utf8");
  const match = source.match(/PACKAGES=\(\n([\s\S]*?)\n\)/);
  assert.ok(match, `${scriptPath} missing PACKAGES default list`);
  return match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

// analysis/sensor-model, analysis/sensor-coverage and shaders/sensor-shaders
// moved to space-data-network-closed-modules. They must not reappear in the
// default package lists here, alongside the older retired paths.
const RELOCATED_OR_RETIRED_PACKAGES = [
  "analysis/coverage",
  "analysis/fastest-path",
  "analysis/sensor-coverage",
  "analysis/sensor-model",
  "analysis/swath",
  "shaders/sensor-shaders",
  "shaders/viewshed-shader",
];

test("default module build and SDK compatibility scripts hold only in-repo modules", () => {
  for (const scriptPath of [
    "scripts/build-migrated-packages.sh",
    "scripts/test-sdk-compat.sh",
    "scripts/test-all-module-packages.sh",
  ]) {
    const packages = defaultPackageList(scriptPath);
    assert.ok(
      packages.length > 0,
      `${scriptPath} default packages must not be empty`,
    );
    assert.ok(
      packages.includes("analysis/od"),
      `${scriptPath} default packages must include analysis/od`,
    );
    for (const retired of RELOCATED_OR_RETIRED_PACKAGES) {
      assert.equal(
        packages.includes(retired),
        false,
        `${scriptPath} default packages must not include relocated/retired ${retired}`,
      );
    }
    for (const modulePath of packages) {
      assert.ok(
        fs.existsSync(path.join(repoRoot, modulePath)),
        `${scriptPath} default package ${modulePath} does not exist in this repo`,
      );
    }
  }
});

test("SDK compatibility script resolves the stack-local ancillary SDK checkout", () => {
  const source = fs.readFileSync(
    path.join(repoRoot, "scripts/test-sdk-compat.sh"),
    "utf8",
  );
  assert.match(source, /ancillary-packages\/space-data-module-sdk/);
});

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

test("default module build and SDK compatibility scripts include sensor WASM modules", () => {
  for (const scriptPath of [
    "scripts/build-migrated-packages.sh",
    "scripts/test-sdk-compat.sh",
    "scripts/test-all-module-packages.sh",
  ]) {
    const packages = defaultPackageList(scriptPath);
    assert.ok(
      packages.includes("analysis/sensor-model"),
      `${scriptPath} default packages must include analysis/sensor-model`,
    );
    assert.ok(
      packages.includes("analysis/sensor-coverage"),
      `${scriptPath} default packages must include analysis/sensor-coverage`,
    );
    assert.equal(
      packages.includes("analysis/coverage"),
      false,
      `${scriptPath} default packages must not include retired analysis/coverage`,
    );
    assert.equal(
      packages.includes("analysis/swath"),
      false,
      `${scriptPath} default packages must not include retired analysis/swath`,
    );
  }
});

test("SDK compatibility script resolves the stack-local ancillary SDK checkout", () => {
  const source = fs.readFileSync(
    path.join(repoRoot, "scripts/test-sdk-compat.sh"),
    "utf8",
  );
  assert.match(source, /ancillary-packages\/space-data-module-sdk/);
});

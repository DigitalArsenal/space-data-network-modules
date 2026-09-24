// Drives the native SP Vector/Covariance Message parser checks.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

test("SP Vector/Covariance Message V2.0 parses and refuses malformed input", () => {
  const work = mkdtempSync(path.join(tmpdir(), "orbit-products-vcm-"));
  try {
    const binary = path.join(work, "vcm-native");
    execFileSync("c++", ["-std=c++17", "-O2", "-Wall", "-I", path.join(here, "..", "src"),
      path.join(here, "vcm_native.cpp"), "-o", binary], { stdio: "pipe" });
    const run = spawnSync(binary, [path.join(here, "..", "fixtures", "vcm_v2_sample.txt")], { encoding: "utf8" });
    process.stdout.write(run.stdout ?? "");
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /PASS vcm parser cases=\d+ failures=0/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

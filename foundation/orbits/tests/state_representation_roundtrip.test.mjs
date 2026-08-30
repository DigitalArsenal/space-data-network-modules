// Runs the native state-representation round-trip acceptance measurement and
// fails the suite on any well-posed cell exceeding 1e-12.
//
// The measurement itself is C++ (state_representation_roundtrip.cpp) because it
// must exercise the SAME translation unit the WASM module compiles — a
// JavaScript reimplementation would be a second answer, and testing it would
// prove nothing about the shipped code. This wrapper exists only so the
// measurement runs under `npm test` and therefore under the gauntlet.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(here, "state_representation_roundtrip.cpp");
const includePath = path.join(here, "..", "src");

/// 10^5 states total, spread over the six regimes the acceptance names.
const SAMPLES_PER_REGIME = 16667;

function hasCompiler() {
  const probe = spawnSync("c++", ["--version"], { stdio: "ignore" });
  return probe.status === 0;
}

test("all state representations round-trip to Cartesian within 1e-12", { concurrency: false }, (t) => {
  if (!hasCompiler()) {
    // A missing host compiler is a provisioning gap, not a physics failure.
    // Reporting it as a skip keeps the gauntlet's PROVISION-BLOCKED semantics
    // intact rather than turning an unrunnable check into a red one.
    t.skip("no host c++ compiler available");
    return;
  }

  const workDir = mkdtempSync(path.join(tmpdir(), "sdn-orbits-roundtrip-"));
  const binaryPath = path.join(workDir, "roundtrip");
  try {
    execFileSync(
      "c++",
      ["-std=c++17", "-O2", "-I", includePath, "-o", binaryPath, sourcePath],
      { stdio: "pipe" },
    );

    const run = spawnSync(binaryPath, [String(SAMPLES_PER_REGIME)], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });

    // Always surface the table: a failure must name the set and the regime.
    if (run.stdout) {
      console.log(run.stdout);
    }
    assert.equal(run.error, undefined, `round-trip harness failed to run: ${run.error?.message}`);
    assert.match(
      run.stdout,
      /PASS: every well-posed cell within 1e-12/,
      "a well-posed (set, regime) cell exceeded the 1e-12 round-trip tolerance",
    );
    assert.equal(run.status, 0, "round-trip harness exited non-zero");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

// Compiles and runs the Code-500 / STK acceptance harness, and fails the suite
// on any check that misses its bound.
//
// The measurements live in code500_stk_native.cpp because these are HEADERS,
// not a WASM artifact: there is no module boundary to drive them through, and
// running them natively is what lets the same source be compiled by the
// isomorphic toolchain without a second copy of the assertions.
//
// The independent authority for the STK reader is Orekit 13.1, whose parse of
// the same published file is committed alongside it in fixtures/ — see
// fixtures/PROVENANCE.md. That dump is a fixture rather than a live JVM call so
// this suite has no Java dependency; regenerating it is documented there.

import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(here, "code500_stk_native.cpp");
const includePath = path.join(here, "..", "src");
const fixturesPath = path.join(here, "..", "fixtures");

function hasToolchain() {
  return spawnSync("c++", ["--version"], { stdio: "ignore" }).status === 0;
}

test("Code-500 and STK containers round-trip and match Orekit", { concurrency: false }, (t) => {
  if (!hasToolchain()) {
    t.skip("no host c++ compiler");
    return;
  }
  if (!existsSync(path.join(fixturesPath, "stk_02674_pv.e"))) {
    t.skip("the published STK fixtures are not in this checkout");
    return;
  }

  // The binary goes to a temp dir, never the repo: a build artifact under a
  // claimed path is contamination the workspace guard has to reason about.
  const workDir = mkdtempSync(path.join(tmpdir(), "sdn-orbit-c500-"));
  const binaryPath = path.join(workDir, "code500_stk");
  try {
    execFileSync("c++", ["-std=c++17", "-O2", "-I", includePath, "-o", binaryPath, sourcePath], {
      stdio: "pipe",
    });
    const run = spawnSync(binaryPath, [fixturesPath], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    if (run.stdout) {
      console.log(run.stdout);
    }
    assert.equal(run.error, undefined, `harness failed to run: ${run.error?.message}`);
    assert.match(
      run.stdout,
      /\n\d+ checks, 0 failures\n/,
      "at least one container check missed its bound",
    );
    assert.equal(run.status, 0, "container harness exited non-zero");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

// Compiles and runs the native ephemeris-propagator acceptance, and fails the
// suite on any check that misses its bound.
//
// The measurements live in ephemeris_propagator_native.cpp because they are
// about HEADERS the module is assembled from — the container readers, the
// interpolation kernels, the epoch map — and running them natively is what lets
// the same source be compiled by the isomorphic toolchain without a second copy
// of the assertions. The WASM ARTIFACT is measured separately, over the real
// exports, in module_abi.test.mjs.
//
// The fixtures are synthetic and committed; fixtures/PROVENANCE.md records how
// they were made and why a published corpus cannot serve here. The harness
// regenerates them in memory on every run and asserts the committed bytes are
// exactly what the generator emits, so a stale fixture cannot quietly become the
// thing being measured.

import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(here, "ephemeris_propagator_native.cpp");
const fixturesPath = path.join(here, "..", "fixtures");
// The format engines live in files/orbit-products; the CCSDS keyword-value
// document model lives in the sibling package and containers.hpp reaches it by
// a relative include, so one include path covers both.
const includePath = path.join(here, "..", "..", "..", "files", "orbit-products", "src");

function hasToolchain() {
  return spawnSync("c++", ["--version"], { stdio: "ignore" }).status === 0;
}

test("the ephemeris-source propagator's containers, epoch map and interpolants", { concurrency: false }, (t) => {
  if (!hasToolchain()) {
    t.skip("no host c++ compiler");
    return;
  }
  if (!existsSync(includePath)) {
    t.skip("files/orbit-products is not in this checkout");
    return;
  }
  if (!existsSync(path.join(fixturesPath, "ephemeris.oem"))) {
    t.skip("the four-container fixture set is not in this checkout");
    return;
  }

  // The binary goes to a temp dir, never the repo: a build artifact under a
  // claimed path is contamination the workspace guard has to reason about.
  const workDir = mkdtempSync(path.join(tmpdir(), "sdn-spk-source-"));
  const binaryPath = path.join(workDir, "ephemeris_propagator");
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
    // A PROVISION line means the harness could not be prepared — a missing
    // fixture or a writer that refused the arc. That is not a physics failure
    // and must not be reported as one.
    assert.doesNotMatch(run.stdout, /^PROVISION /m, "the harness could not be prepared");
    assert.match(
      run.stdout,
      /\n\d+ checks, 0 failures\n/,
      "at least one acceptance check missed its bound",
    );
    assert.equal(run.status, 0, "the acceptance harness exited non-zero");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

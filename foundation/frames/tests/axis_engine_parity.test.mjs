// Runs the native axis-engine parity measurements and fails the suite on any
// check that misses its tolerance.
//
// Compiles the vendored ERFA (higherpop/third_party/erfa — BSD-3, derived with
// permission from IAU SOFA) alongside the engine, because the acceptance's
// "one chain" criterion is precisely that this engine and higherpop/frames.hpp
// reach the SAME series evaluation. Building against a second copy of the
// series would defeat the thing being measured.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(here, "axis_engine_parity.cpp");
const includePath = path.join(here, "..", "src");
const erfaRoot = path.join(here, "..", "..", "..", "higherpop", "third_party", "erfa");

// ERFA ships its own test drivers in the same directory; they define their own
// main() and must not be linked into ours.
const ERFA_EXCLUDED = new Set(["t_erfa_c.c", "t_erfa_c_extra.c", "erfaversion.c"]);

function hasCompiler() {
  return spawnSync("c++", ["--version"], { stdio: "ignore" }).status === 0 &&
    spawnSync("cc", ["--version"], { stdio: "ignore" }).status === 0;
}

test("axis engine matches ERFA, IAU/WGCCRE and Hapgood references", { concurrency: false }, (t) => {
  if (!hasCompiler()) {
    t.skip("no host c/c++ compiler available");
    return;
  }
  if (!existsSync(erfaRoot)) {
    // The vendored ERFA lives behind the higherpop path; if the checkout does
    // not carry it this is a provisioning gap, not a physics failure.
    t.skip(`vendored ERFA not present at ${erfaRoot}`);
    return;
  }

  const erfaSources = readdirSync(erfaRoot)
    .filter((name) => name.endsWith(".c") && !ERFA_EXCLUDED.has(name))
    .map((name) => path.join(erfaRoot, name));
  assert.ok(erfaSources.length > 100, "vendored ERFA looks incomplete");

  const workDir = mkdtempSync(path.join(tmpdir(), "sdn-frames-axis-"));
  const binaryPath = path.join(workDir, "axis");
  try {
    // Compile ERFA as C (it is C, and building it as C++ changes linkage).
    const objects = [];
    for (const source of erfaSources) {
      const objectPath = path.join(workDir, `${path.basename(source, ".c")}.o`);
      execFileSync("cc", ["-O2", "-I", erfaRoot, "-c", source, "-o", objectPath], {
        stdio: "pipe",
      });
      objects.push(objectPath);
    }

    execFileSync(
      "c++",
      ["-std=c++17", "-O2", "-I", includePath, "-I", erfaRoot, "-o", binaryPath, sourcePath,
        ...objects],
      { stdio: "pipe" },
    );

    const run = spawnSync(binaryPath, [], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    if (run.stdout) {
      console.log(run.stdout);
    }
    assert.equal(run.error, undefined, `axis parity harness failed to run: ${run.error?.message}`);
    assert.match(run.stdout, /\n0 failures\n|, 0 failures/, "at least one axis parity check failed");
    assert.equal(run.status, 0, "axis parity harness exited non-zero");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

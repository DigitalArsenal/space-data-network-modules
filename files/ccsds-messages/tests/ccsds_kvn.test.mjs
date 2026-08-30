// ccsds_kvn.test.mjs — compiles and runs the native CCSDS KVN harness, and
// fails the suite on any RESULT line that missed its bound.
//
// The measurements live in ccsds_native.cpp because the headers they measure
// are the ones that compile into the module's single WASM translation unit:
// running them through a JS re-implementation would measure the
// re-implementation. This wrapper does three things and no more — build, run,
// and refuse to let a FAIL or a silently-empty report pass as a green suite.
//
// The binary is built into a temp directory and deleted. Nothing compiled here
// ever lands in the repo.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(here, "ccsds_native.cpp");
const includePath = path.join(here, "..", "src");
const fixturePath = path.join(here, "..", "fixtures");

// clang++ is what the task's build line names; c++ is the same compiler on
// every host this repo builds on and is the fallback when clang++ is not on
// PATH under that name.
function findCompiler() {
  for (const candidate of ["clang++", "c++"]) {
    if (spawnSync(candidate, ["--version"], { stdio: "ignore" }).status === 0) {
      return candidate;
    }
  }
  return null;
}

// The fixtures ARE the test: without them there is nothing to measure, and a
// silent skip would look identical to a pass.
function fixtureFiles() {
  if (!existsSync(fixturePath)) {
    return [];
  }
  return readdirSync(fixturePath).filter((name) => name.endsWith(".txt"));
}

test("CCSDS KVN round-trips the published Blue Book examples", { concurrency: false }, (t) => {
  const compiler = findCompiler();
  if (!compiler) {
    t.skip("no host c++ compiler; the native CCSDS harness cannot be built");
    return;
  }
  assert.equal(fixtureFiles().length, 5, "expected the five published fixture messages");

  const workDir = mkdtempSync(path.join(tmpdir(), "sdn-ccsds-kvn-"));
  const binaryPath = path.join(workDir, "ccsds_native");
  let run;
  try {
    execFileSync(
      compiler,
      ["-std=c++17", "-O2", "-I", includePath, sourcePath, "-o", binaryPath],
      { stdio: "pipe" },
    );
    run = spawnSync(binaryPath, [fixturePath], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }

  if (run.stdout) {
    console.log(run.stdout);
  }
  if (run.stderr) {
    console.error(run.stderr);
  }
  assert.equal(run.error, undefined, `CCSDS harness failed to run: ${run.error?.message}`);

  const results = run.stdout.split("\n").filter((line) => line.startsWith("RESULT "));
  const failed = results.filter((line) => line.trimEnd().endsWith("FAIL"));
  // A harness that printed nothing would otherwise satisfy "no FAIL lines".
  assert.ok(results.length >= 100, `only ${results.length} RESULT lines were reported`);
  assert.equal(failed.length, 0, `checks missed their bound:\n${failed.join("\n")}`);
  assert.match(run.stdout, /\n\d+ checks, 0 failures\n/, "the harness did not report zero failures");
  assert.equal(run.status, 0, "the CCSDS harness exited non-zero");
});

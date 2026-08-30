// Runs the native event-locator conformance measurements and fails the suite on
// any check that misses its tolerance.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(here, "event_locator_conformance.cpp");
const eventsInclude = path.join(here, "..", "src");
const orbitsInclude = path.join(here, "..", "..", "..", "foundation", "orbits", "src");

test("the event locator meets its conformance bars", { concurrency: false }, (t) => {
  if (spawnSync("c++", ["--version"], { stdio: "ignore" }).status !== 0) {
    t.skip("no host c++ compiler");
    return;
  }
  if (!existsSync(orbitsInclude)) {
    t.skip("the element-set library is not in this checkout");
    return;
  }
  const workDir = mkdtempSync(path.join(tmpdir(), "sdn-events-"));
  const binaryPath = path.join(workDir, "events");
  try {
    execFileSync(
      "c++",
      ["-std=c++17", "-O2", "-I", eventsInclude, "-I", orbitsInclude, "-o", binaryPath,
        sourcePath],
      { stdio: "pipe" },
    );
    const run = spawnSync(binaryPath, [], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    if (run.stdout) console.log(run.stdout);
    if (run.status !== 0 && run.stderr) console.error(run.stderr);
    assert.match(run.stdout, /, 0 failures\n|\n0 failures\n/, "a conformance check missed its bar");
    assert.equal(run.status, 0, "the conformance harness exited non-zero");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

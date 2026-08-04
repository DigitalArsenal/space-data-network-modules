/*
 * Runs the native bulk-route unit test (tests/bulk_route_test.cc) through the
 * system C++ compiler.
 *
 * WHY NATIVE. The routing rule is the whole of this change
 * (sdn-data-retrieval-rfb-bulk-route), and the wasm path cannot exercise it
 * today: `space-data-module flow compile` refuses the data-retrieval bundle
 * (engineLinkage "flatsql" retired + descriptor-ABI port typing —
 * mod-flow-bundles-descriptor-abi-gen2), and this module's own wasm build is
 * refused by the SDK's isomorphic-pthreads artifact guard. A rule that ships
 * untested because its toolchain is down is exactly the drift this repo
 * fights, so the rule is compiled and run natively from the SAME header the
 * wasm build prepends.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function compiler() {
  for (const candidate of [process.env.CXX, "c++", "clang++", "g++"].filter(Boolean)) {
    const probe = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (probe.status === 0) return candidate;
  }
  return null;
}

test("per-schema bulk routing (native)", () => {
  const cxx = compiler();
  assert.ok(cxx, "no C++ compiler available to verify the routing rule");

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "sdn-bulk-route-"));
  const binary = path.join(outDir, "bulk_route_test");
  try {
    execFileSync(cxx, ["-std=c++17", "-Wall", "-Wextra", "-Werror", path.join(here, "bulk_route_test.cc"), "-o", binary], {
      stdio: "pipe",
    });
    const output = execFileSync(binary, { encoding: "utf8" });
    assert.match(output, /all assertions passed/);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

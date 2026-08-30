// Runs the native axis-engine parity measurements and fails the suite on any
// check that misses its tolerance.
//
// The build and the run live in native_axis_reference.mjs, because
// coordinate_systems.test.mjs compares the shipped WASM artifact against the
// same run's reference block and compiling the vendored ERFA twice would double
// the suite for nothing.

import test from "node:test";
import assert from "node:assert/strict";

import { runNativeAxisHarness } from "./native_axis_reference.mjs";

test("axis engine matches ERFA, IAU/WGCCRE and Hapgood references", { concurrency: false }, (t) => {
  const run = runNativeAxisHarness();
  if (!run) {
    t.skip("no host c/c++ compiler, or the vendored ERFA is not in this checkout");
    return;
  }
  if (run.stdout) {
    console.log(run.stdout);
  }
  assert.equal(run.error, undefined, `axis parity harness failed to run: ${run.error?.message}`);
  assert.match(run.stdout, /\n0 failures\n|, 0 failures/, "at least one axis parity check failed");
  assert.equal(run.status, 0, "axis parity harness exited non-zero");
});

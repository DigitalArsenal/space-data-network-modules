// Runs the native parameter-catalog parity measurements and fails the suite on
// any check that misses its tolerance.
//
// The build and the run live in native_parameter_reference.mjs so the vendored
// ERFA is compiled once per process rather than once per suite.

import test from "node:test";
import assert from "node:assert/strict";

import { runNativeParameterHarness } from "./native_parameter_reference.mjs";

test(
  "the parameter catalog reproduces its external authorities",
  { concurrency: false },
  (t) => {
    const run = runNativeParameterHarness();
    if (!run) {
      t.skip("no host c/c++ compiler, or the vendored ERFA is not in this checkout");
      return;
    }
    if (run.stdout) console.log(run.stdout);
    if (run.status !== 0 && run.stderr) console.error(run.stderr);
    assert.match(run.stdout, /, 0 failures\n|\n0 failures\n/, "a parity check missed its bar");
    assert.equal(run.status, 0, "the parity harness exited non-zero");
  },
);

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const LEGACY_INVOKE_PATTERNS =
  /\b(?:PINQ|PINS|PluginInvokeRequest_generated|PluginInvokeResponse_generated|orbpro::invoke|VerifyPluginInvoke|CreatePluginInvoke|GetPluginInvoke)\b/g;

function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], {
    encoding: "buffer",
  })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

function isGeneratedArtifact(path) {
  return /(^|\/)(dist|build[^/]*)\//.test(path) || path.endsWith(".wasm");
}

function isScannerSource(path) {
  return path === "tests/piv_invoke_sources.test.mjs";
}

test("tracked module sources do not reference legacy PINQ/PINS invoke identifiers", () => {
  const matches = [];

  for (const path of trackedFiles()) {
    if (isGeneratedArtifact(path) || isScannerSource(path)) {
      continue;
    }
    const text = readFileSync(path, "utf8");
    for (const match of text.matchAll(LEGACY_INVOKE_PATTERNS)) {
      const line =
        text.slice(0, match.index).split("\n").length;
      matches.push(`${path}:${line}: ${match[0]}`);
    }
  }

  assert.deepEqual(matches, []);
});

// The source scan above skips dist/, so a committed artifact built before the
// PIV migration went unnoticed: basilisk/runtime's June 2026 module.wasm still
// verified requests as the legacy invoke table, rejected every PIV request
// with this message and exited 1. Only the legacy invoke glue carries it.
const LEGACY_INVOKE_GLUE_MARKER = Buffer.from(
  "Invoke request FlatBuffer verification failed.",
);

test("committed wasm artifacts do not embed the legacy pre-PIV invoke glue", () => {
  const legacy = trackedFiles()
    .filter((path) => path.endsWith(".wasm"))
    .filter((path) => readFileSync(path).includes(LEGACY_INVOKE_GLUE_MARKER));

  assert.deepEqual(legacy, []);
});

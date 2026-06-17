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

test("tracked module sources do not reference legacy PINQ/PINS invoke identifiers", () => {
  const matches = [];

  for (const path of trackedFiles()) {
    if (isGeneratedArtifact(path)) {
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

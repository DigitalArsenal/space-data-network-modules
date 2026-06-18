import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("access build pins PNM publication metadata for reproducible records", async () => {
  const buildSource = await readFile(
    path.join(repoRoot, "analysis/access/build.js"),
    "utf8",
  );
  const protectCall = buildSource.match(
    /protectModuleArtifact\(\{[\s\S]*?artifactId:\s*"access-runtime"[\s\S]*?\}\)/u,
  );

  assert.ok(protectCall, "expected access build to protect access-runtime");
  assert.match(protectCall[0], /\bmnemonic:/u);
  assert.match(protectCall[0], /\bpublishTimestamp:/u);
});

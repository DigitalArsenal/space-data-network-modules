import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runConformance } from "space-data-module-sdk/conformance";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidencePath = path.join(root, "conformance", "estimation-evidence.json");
const artifactPath = path.join(root, "dist", "isomorphic", "module.wasm");

test("published estimation conformance evidence passes every required tier", async () => {
  const evidence = JSON.parse(await fs.readFile(evidencePath, "utf8"));
  const artifact = await fs.readFile(artifactPath);
  assert.equal(
    crypto.createHash("sha256").update(artifact).digest("hex"),
    evidence.artifact.sha256,
    "conformance evidence names a different WASM artifact",
  );
  const report = await runConformance({
    family: "estimation",
    artifactPath,
    evidencePath,
  });
  assert.equal(report.verdict, "PASS", JSON.stringify(report.checks, null, 2));
});

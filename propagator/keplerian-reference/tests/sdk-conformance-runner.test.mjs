/**
 * The SDK conformance runner adjudicates THIS module — W1.4's consumer proof.
 *
 * The module's own tests (conformance.test.mjs, lifecycle.test.mjs) remain the
 * exemplar the family kit was generalized from; this file proves the
 * generalization: `space-data-module conformance propagator` reaches the same
 * verdict on the same artifact and corpus, its self-test exits 0 BY failing,
 * and a corrupted corpus is FAILED with the offending anchor named.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const artifactPath = path.join(packageRoot, "dist", "isomorphic", "module.wasm");
const vectorsPath = path.join(packageRoot, "vectors", "vectors.json");

const packageRequire = createRequire(path.join(packageRoot, "package.json"));
const conformanceEntry = packageRequire.resolve("space-data-module-sdk/conformance");
const cliPath = path.join(path.dirname(conformanceEntry), "..", "..", "bin", "space-data-module.js");

function runCli(args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    timeout: 240_000,
  });
}

test("the runner PASSes this artifact against its own corpus", () => {
  const result = runCli([
    "conformance",
    "propagator",
    "--artifact",
    artifactPath,
    "--vectors",
    vectorsPath,
    "--json",
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.family, "propagator");
  assert.ok(
    report.verdict === "PASS" || report.verdict === "PASS-WITH-GAPS",
    `verdict was ${report.verdict}`,
  );
  // The only admissible gap is the parity lane another command owns.
  const gaps = report.checks.filter((check) => check.status === "gap");
  assert.deepEqual(
    gaps.map((check) => check.id),
    ["tier0/parity-gate"],
    "unexpected gaps — the corpus or a check went missing",
  );
  const failed = report.checks.filter((check) => check.status === "fail");
  assert.deepEqual(failed, [], JSON.stringify(failed, null, 2));
});

test("the runner discovers the module's own corpus without --vectors", () => {
  const result = runCli([
    "conformance",
    "propagator",
    "--artifact",
    artifactPath,
    "--json",
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.corpus.path, vectorsPath);
  assert.equal(report.corpus.cases, 15);
});

test("self-test exits 0 BY failing — every planted defect caught", () => {
  const result = runCli(["conformance", "propagator", "--self-test", "--json"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const outcome = JSON.parse(result.stdout);
  assert.equal(outcome.ok, true);
  const planted = outcome.results.filter((entry) => entry.scenario.startsWith("planted:"));
  assert.ok(planted.length >= 8, `only ${planted.length} planted defects`);
  for (const entry of planted) {
    assert.equal(entry.verdict, "FAIL", `${entry.scenario} was not caught`);
  }
});

test("NEGATIVE CONTROL — a corrupted corpus FAILs with the anchor named", () => {
  const corpus = JSON.parse(fs.readFileSync(vectorsPath, "utf8"));
  corpus.cases[0].expect["position.0"] += 1000;
  const corruptedPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "conformance-negative-")),
    "vectors.json",
  );
  fs.writeFileSync(corruptedPath, JSON.stringify(corpus));
  try {
    const result = runCli([
      "conformance",
      "propagator",
      "--artifact",
      artifactPath,
      "--vectors",
      corruptedPath,
      "--json",
    ]);
    assert.equal(result.status, 1, "a corrupted corpus must FAIL the run");
    const report = JSON.parse(result.stdout);
    assert.equal(report.verdict, "FAIL");
    const anchors = report.checks.find((check) => check.id === "tierB/anchors");
    assert.equal(anchors.status, "fail");
    assert.match(
      anchors.detail,
      /leo-near-circular@\+0min/,
      "the refusal must name the offending case, never say only 'not found'",
    );
  } finally {
    fs.rmSync(path.dirname(corruptedPath), { recursive: true, force: true });
  }
});

test("an unknown family is refused BY NAME with the known set", () => {
  const result = runCli(["conformance", "sensor", "--artifact", artifactPath]);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /no conformance kit for family "sensor"/,
  );
  assert.match(result.stderr, /propagator/);
});

// Keep the moved harness honest: the shim and the SDK export the same surface.
test("tests/lib/isomorphicHarness.mjs is the SDK harness", async () => {
  const shim = await import(
    pathToFileURL(path.join(packageRoot, "..", "..", "tests", "lib", "isomorphicHarness.mjs")).href
  );
  const sdk = await import("space-data-module-sdk/testing/isomorphic");
  for (const name of Object.keys(sdk)) {
    assert.equal(shim[name], sdk[name], `shim diverges from SDK on ${name}`);
  }
});

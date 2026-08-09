// ARTIFACT REPRODUCIBILITY — the fast lane, plus the negative controls that make
// it worth running.
//
// Graph task: modules-dist-not-reproducible-at-sdk-pin.
//
// A check that has never been seen to fail is not evidence of anything, so this
// file does not merely assert PASS: it tampers with a committed artifact, asserts
// the check catches it, and puts the bytes back. Same for an unledgered artifact.
//
// The heavy REBUILD lane (~15 s per module) is NOT here — it is
// `node scripts/check-artifact-reproducibility.mjs --rebuild <n>`, for CI.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  describeToolchain,
  resolveToolchain,
  toolchainId,
} from "../scripts/build-provenance.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CHECKER = path.join(REPO_ROOT, "scripts", "check-artifact-reproducibility.mjs");
const LEDGER = path.join(REPO_ROOT, "scripts", "artifact-provenance.json");

function runChecker() {
  try {
    const stdout = execFileSync(process.execPath, [CHECKER], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, output: stdout };
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

test("the ledger accounts for every committed dist artifact", () => {
  const result = runChecker();
  assert.equal(
    result.ok,
    true,
    `artifact reproducibility check failed:\n${result.output}`,
  );
  assert.match(result.output, /PASS — artifact reproducibility/);
});

test("NEGATIVE CONTROL: a committed artifact whose bytes change without a ledger update FAILS", () => {
  const ledger = JSON.parse(fs.readFileSync(LEDGER, "utf8"));
  const target = Object.keys(ledger.artifacts)[0];
  assert.ok(target, "the ledger must record at least one artifact");
  const abs = path.join(REPO_ROOT, target);
  const original = fs.readFileSync(abs);
  try {
    // Append, never edit in place: a trailing byte makes the file an invalid wasm
    // as well as a different hash, so a checker that silently tolerated a parse
    // failure would still be caught here.
    fs.writeFileSync(abs, Buffer.concat([original, Buffer.from([0x00])]));
    const result = runChecker();
    assert.equal(result.ok, false, "tampering with a committed artifact must fail the check");
    assert.match(result.output, /ARTIFACT DRIFT/);
    assert.ok(result.output.includes(target), `the failure must name ${target}`);
  } finally {
    fs.writeFileSync(abs, original);
  }
  assert.deepEqual(fs.readFileSync(abs), original, "the negative control must restore the artifact");
});

test("NEGATIVE CONTROL: an artifact missing from the ledger FAILS", () => {
  const original = fs.readFileSync(LEDGER, "utf8");
  const ledger = JSON.parse(original);
  const dropped = Object.keys(ledger.artifacts)[0];
  try {
    delete ledger.artifacts[dropped];
    fs.writeFileSync(LEDGER, `${JSON.stringify(ledger, null, 2)}\n`);
    const result = runChecker();
    assert.equal(result.ok, false, "an unledgered artifact must fail the check");
    assert.match(result.output, /UNLEDGERED ARTIFACT/);
  } finally {
    fs.writeFileSync(LEDGER, original);
  }
});

test("the toolchain identity covers every input that can change the emitted bytes", () => {
  const toolchain = resolveToolchain();
  assert.equal(toolchain.sdk.resolved, true, "the module SDK must resolve from this repo");
  assert.ok(toolchain.sdk.version, "the SDK version must be recorded");
  // The SDK is linked by `file:` path, so its COMMIT is the only real identity —
  // two different checkouts can both call themselves 0.8.11.
  assert.ok(toolchain.sdk.commit, "the SDK commit must be recorded");
  for (const dependency of ["spacedatastandards.org", "flatc-wasm", "flatbuffers", "sdn-emception"]) {
    assert.ok(
      toolchain.sdkDependencies[dependency],
      `${dependency} reaches the guest and must be recorded: ${describeToolchain(toolchain)}`,
    );
  }
  // The id must be a function of the inputs and nothing else — no clock, no path,
  // no run counter — or the ledger would churn on every regeneration.
  assert.equal(toolchainId(toolchain), toolchain.id);
  assert.equal(resolveToolchain().id, toolchain.id);
});

test("the ledger's recorded toolchain is one this checkout can still name", () => {
  const ledger = JSON.parse(fs.readFileSync(LEDGER, "utf8"));
  assert.ok(ledger.toolchains[ledger.generatedBy], "generatedBy must be present in toolchains");
  const recorded = ledger.toolchains[ledger.generatedBy];
  assert.equal(toolchainId(recorded), ledger.generatedBy, "a recorded toolchain must hash to its own id");
});

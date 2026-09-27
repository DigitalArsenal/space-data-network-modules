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
import { inspectWasmThreading } from "../scripts/lib/thread-model.mjs";

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

// THREAD-MODEL DECLARATION — the ratchet that took the "cannot be rebuilt at the
// current pin" census from 41 artifacts to 0.
//
// Graph task: modules-undeclared-threadmodel-artifacts. The three controls below
// are the three ways the declaration can rot, and each was a live state of this
// repo at some point: absent (11 modules), present but contradicted by the bytes
// (what the SDK's own guard caught when the inference moved), and present but not
// a value the compiler understands.

const DECLARATION_PROBE = "hostcap/clock/build.mjs";

function withBuildScript(mutate, assertions) {
  const abs = path.join(REPO_ROOT, DECLARATION_PROBE);
  const original = fs.readFileSync(abs, "utf8");
  try {
    fs.writeFileSync(abs, mutate(original));
    assertions();
  } finally {
    fs.writeFileSync(abs, original);
  }
  assert.equal(fs.readFileSync(abs, "utf8"), original, "the negative control must restore the build script");
}

test("every module with a build.mjs declares a thread model", () => {
  const result = runChecker();
  assert.equal(result.ok, true, result.output);
  const match = /(\d+)\/(\d+) modules declare a thread model/.exec(result.output);
  assert.ok(match, `the check must report the module census:\n${result.output}`);
  assert.equal(match[1], match[2], "every module with a build.mjs must declare");
});

test("NEGATIVE CONTROL: a module that stops declaring its thread model FAILS", () => {
  withBuildScript(
    (source) => {
      const stripped = source.replace('  threadModel: "single-thread",\n', "");
      assert.notEqual(stripped, source, `${DECLARATION_PROBE} must contain the declaration to remove`);
      return stripped;
    },
    () => {
      const result = runChecker();
      assert.equal(result.ok, false, "an undeclared module must fail the check");
      assert.match(result.output, /MODULES WITH NO THREAD-MODEL DECLARATION/);
      assert.ok(result.output.includes("hostcap/clock"), "the failure must name the module");
    },
  );
});

test("NEGATIVE CONTROL: a declaration the committed bytes contradict FAILS", () => {
  // The artifact has unshared memory and no wasi.thread-spawn import, so claiming
  // the pthreads contract is a lie the bytes can refute without a rebuild.
  withBuildScript(
    (source) => source.replace('threadModel: "single-thread"', 'threadModel: "emscripten-pthreads"'),
    () => {
      const result = runChecker();
      assert.equal(result.ok, false, "a declaration contradicted by the bytes must fail");
      assert.match(result.output, /DECLARATION CONTRADICTS SHIPPED BYTES/);
      assert.match(result.output, /no wasi-threads contract/);
    },
  );
});

test("NEGATIVE CONTROL: a thread model the compiler does not understand FAILS", () => {
  withBuildScript(
    (source) => source.replace('threadModel: "single-thread"', 'threadModel: "mostly-single"'),
    () => {
      const result = runChecker();
      assert.equal(result.ok, false, "an unrecognised thread model must fail");
      assert.match(result.output, /UNRECOGNISED THREAD MODEL/);
    },
  );
});

test("the artifact inspector reads the module, not the appended signature", () => {
  // signModuleArtifact APPENDS a detached payload after the last wasm section.
  // A walker that keeps going reads garbage section ids and eventually runs off
  // the end — measured on catalog-synthesis.wasm, where the module proper is the
  // first 162,920 of 163,884 bytes.
  const signed = path.join(REPO_ROOT, "analysis/catalog-synthesis/dist/catalog-synthesis.wasm");
  const unsigned = path.join(REPO_ROOT, "analysis/catalog-synthesis/dist/isomorphic/module.wasm");
  const signedFacts = inspectWasmThreading(signed);
  const unsignedFacts = inspectWasmThreading(unsigned);
  assert.ok(signedFacts.trailingBytes > 0, "the signed artifact must carry a detached payload");
  assert.equal(unsignedFacts.trailingBytes, 0, "the unsigned artifact must be pure wasm");
  assert.equal(signedFacts.sharedMemory, unsignedFacts.sharedMemory);
  assert.equal(signedFacts.threadSpawnImport, unsignedFacts.threadSpawnImport);
  assert.deepEqual(signedFacts.importModules, unsignedFacts.importModules);
});

test("the toolchain identity covers every input that can change the emitted bytes", () => {
  const toolchain = resolveToolchain();
  assert.equal(toolchain.sdk.resolved, true, "the module SDK must resolve from this repo");
  assert.ok(toolchain.sdk.version, "the SDK version must be recorded");
  // A version alone is not an identity — two different checkouts can both call
  // themselves 0.8.11. A registry install is named by the integrity the root
  // lockfile pins; a `file:`-linked checkout by its commit. Exactly one applies.
  if (toolchain.sdk.commit) {
    assert.equal(toolchain.sdk.integrity, undefined, "a checkout has no registry integrity");
  } else {
    assert.match(
      String(toolchain.sdk.integrity),
      /^sha512-[A-Za-z0-9+/]+=*$/,
      "a registry-installed SDK must be named by its lockfile integrity",
    );
  }
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

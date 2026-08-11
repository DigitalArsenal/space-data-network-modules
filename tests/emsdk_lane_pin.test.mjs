// THE RAW EM++ LANE — the pin, the refusal, and the record.
//
// Graph task: modules-raw-emcc-lane-unpinned-toolchain.
//
// Fourteen modules in this repo compile with a repo-local Emscripten instead of
// the SDK compiler, and until this landed each of them bootstrapped it by cloning
// emsdk from GitHub and running `emsdk install 6.0.1` DURING THE BUILD. Three
// things were wrong at once and only the first was obvious:
//
//   * the build needed the network, so it could not run from a clean checkout;
//   * nothing recorded which toolchain arrived, so the ledger's provenance chain
//     had 27 artifacts hanging off it that it could not describe;
//   * the version pin never actually fired — `install` was guarded by "does an
//     emcc already exist here", so any leftover emsdk satisfied it. Measured on
//     the build machine: four different Emscriptens across fifteen checkouts, at
//     least three of them inside this one lane's shipped bytes.
//
// These tests assert the properties that make those three impossible to
// reintroduce, and — like the reproducibility suite next door — they assert the
// REFUSALS by provoking them, because a guard nobody has watched fail is a guess.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  loadEmsdkPin,
  describeEmsdkRoot,
  resolveLaneToolchain,
} from "../scripts/lib/emsdk-toolchain.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PIN = loadEmsdkPin();

function buildScriptPath(moduleDir, names = ["build.mjs", "build.sh"]) {
  for (const name of names) {
    const candidate = path.join(REPO_ROOT, moduleDir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`${moduleDir} has no readable build.mjs or build.sh`);
}

function buildScript(moduleDir) {
  return fs.readFileSync(buildScriptPath(moduleDir), "utf8");
}

test("the raw-em++ lane reader covers shell entry points", () => {
  // SGP4 is deliberately OUTSIDE the Emscripten lane, but it is the regression
  // fixture for the old blind spot: a shell build used to be invisible because
  // this test hard-coded build.mjs. If a future raw lane module uses build.sh,
  // it now receives the same fetch/resolver/record checks.
  const shellEntry = buildScriptPath("propagator/sgp4", ["build.sh"]);
  assert.equal(path.basename(shellEntry), "build.sh");
  assert.match(buildScript("propagator/sgp4"), /wasi-sequential/);
});

test("no module in the raw em++ lane fetches its own toolchain or sources", () => {
  const offenders = [];
  for (const moduleDir of PIN.laneModules) {
    const source = buildScript(moduleDir);
    // Comments may DISCUSS the old bootstrap; only executable fetches count, so
    // strip line and block comments before looking.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const pattern of [/git\s+clone/, /emsdk\s+install/, /emsdk\s+activate/, /\bcurl\b/, /\bwget\b/]) {
      if (pattern.test(code)) offenders.push(`${moduleDir}: ${pattern}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "a build that downloads its own compiler or sources cannot be reproduced from committed source, " +
      "and puts whatever upstream served that day inside a SIGNED artifact:\n  " + offenders.join("\n  "),
  );
});

test("every lane module routes through the shared pinned resolver", () => {
  const missing = PIN.laneModules.filter((moduleDir) => {
    const source = buildScript(moduleDir);
    return !source.includes("scripts/lib/emsdk-toolchain.mjs");
  });
  assert.deepEqual(missing, [], "these modules still resolve a toolchain on their own terms");
});

test("every lane module records the toolchain beside its artifacts", () => {
  const missing = PIN.laneModules.filter((moduleDir) => !buildScript(moduleDir).includes("recordLaneToolchain("));
  assert.deepEqual(
    missing,
    [],
    "an artifact whose build did not stamp its toolchain re-creates the defect this task closed",
  );
});

test("the pin names a toolchain precisely enough to reconstruct it", () => {
  assert.match(PIN.pin.emsdkCommit, /^[0-9a-f]{40}$/, "an emsdk COMMIT, not a branch — the version alone left the emsdk tooling floating");
  assert.match(PIN.pin.emscriptenVersion, /^\d+\.\d+\.\d+$/);
  assert.match(PIN.pin.emscriptenRelease, /^releases-[0-9a-f]{40}-64bit$/);
  assert.match(PIN.pin.llvmRevision, /^[0-9a-f]{40}$/);
});

test("NEGATIVE CONTROL: an emsdk that is not the pin is REFUSED, not silently used", () => {
  // The old bootstrap's exact failure: an emsdk of the wrong version sitting in
  // deps/ satisfied the existence guard and compiled the artifact.
  const wrong = Object.entries(PIN.knownToolchains).find(
    ([id, spec]) => id !== PIN.pin.id && spec.emscriptenVersion !== PIN.pin.emscriptenVersion,
  );
  assert.ok(wrong, "the pin file must know at least one non-pin toolchain to test against");

  const fake = fs.mkdtempSync(path.join(REPO_ROOT, ".emsdk-negative-control-"));
  try {
    fs.mkdirSync(path.join(fake, "upstream", "emscripten"), { recursive: true });
    fs.writeFileSync(path.join(fake, "emsdk_env.sh"), "# negative control\n");
    fs.writeFileSync(path.join(fake, "upstream", "emscripten", "em++"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    fs.writeFileSync(
      path.join(fake, "upstream", "emscripten", "emscripten-version.txt"),
      `"${wrong[1].emscriptenVersion}"\n`,
    );
    fs.writeFileSync(path.join(fake, "upstream", ".emsdk_version"), `${wrong[1].emscriptenRelease}\n`);

    const identity = describeEmsdkRoot(fake);
    assert.equal(identity.emscriptenVersion, wrong[1].emscriptenVersion);

    assert.throws(
      () => resolveLaneToolchain({ extraCandidates: [fake], onlyCandidates: true }),
      (error) => {
        // Either refusal is correct — what must NEVER happen is that this
        // toolchain is accepted. The message has to name the mismatch so the
        // reader is not sent to re-measure it.
        assert.match(error.message, /WRONG EMSCRIPTEN|NO PINNED EMSCRIPTEN/);
        return true;
      },
    );
  } finally {
    fs.rmSync(fake, { recursive: true, force: true });
  }
});

test("NEGATIVE CONTROL: an unknown era id is refused rather than treated as 'skip the check'", () => {
  const previous = process.env.SDN_EMSDK_ERA;
  process.env.SDN_EMSDK_ERA = "em-does-not-exist";
  try {
    assert.throws(() => resolveLaneToolchain({}), /is not a toolchain this repo knows/);
  } finally {
    if (previous === undefined) delete process.env.SDN_EMSDK_ERA;
    else process.env.SDN_EMSDK_ERA = previous;
  }
});

test("the ledger says which Emscripten made every lane artifact, or says it does not know", () => {
  const ledger = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "scripts", "artifact-provenance.json"), "utf8"));
  const lane = Object.entries(ledger.artifacts).filter(([rel]) =>
    PIN.laneModules.some((moduleDir) => rel.startsWith(`${moduleDir}/`)),
  );
  assert.ok(lane.length > 0, "the lane must be represented in the ledger");
  for (const [rel, entry] of lane) {
    const answered = Boolean(entry.emsdkToolchain) || entry.toolchainUnknown === true;
    assert.equal(answered, true, `${rel} neither records a lane toolchain nor admits it is unknown`);
    if (entry.toolchainUnknown) {
      // "Unknown" is only honest if it also carries whatever WAS recoverable.
      // Four of these modules genuinely have no evidence left — their emsdk was
      // cloned at build time and deleted — and the ledger says exactly that.
      assert.ok("emsdkEvidence" in entry, `${rel} is unknown with no era evidence recorded`);
    }
  }
  assert.equal(
    ledger.emsdkLane?.unknownToolchainBaseline,
    lane.filter(([, e]) => e.toolchainUnknown).length,
    "the unknown-toolchain ratchet must match the census it ratchets",
  );
});

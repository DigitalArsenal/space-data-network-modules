#!/usr/bin/env node
//
// BUILD PROVENANCE — what actually produced a dist/ artifact.
//
// WHY THIS FILE EXISTS
//
// Module artifacts are SIGNED, and the signature is over the bytes. A signature
// is only worth something if the bytes can be regenerated from the pinned source
// with the pinned toolchain — otherwise "verify the premise" cannot be run
// against a shipped module at all, and a committed dist/ artifact is not evidence
// of what its source says.
//
// It was not, and the failure was silent. Two independent lanes rebuilt
// UNMODIFIED sources at the then-current SDK pin and got different bytes
// (hostcap/storage-ingest bc808cd2 -> 77377d6d; hostcap/http-request 574ad196 ->
// 60ed32c2). Graph task: modules-dist-not-reproducible-at-sdk-pin.
//
// WHAT THE BISECT FOUND (measured, not assumed)
//
//   * The build is DETERMINISTIC. Rebuilding hostcap/storage-ingest at HEAD from
//     a different absolute path (a fresh worktree) is byte-identical to what is
//     committed. There is no embedded timestamp, no baked absolute path, no
//     iteration-order nondeterminism to strip.
//   * The drift is ENTIRELY BUILD-INPUT VERSION DRIFT. Checking the SDK back out
//     at its era pin (bb67453f / 0.8.5) with `npm ci`, and pointing the standards
//     root at that SDK's own locked spacedatastandards.org (1.136.0), reproduces
//     the original artifact EXACTLY: bc808cd2…, byte for byte, from unmodified
//     source. Nothing else had to be matched.
//   * So reproducibility here is not a code fix. It is a RECORD-KEEPING fix:
//     the repo has to say which toolchain produced which bytes, and a check has
//     to notice when that stops being true.
//
// THE INPUTS THAT DECIDE THE BYTES
//
//   sdk           the SDK source itself (invoke glue, embedded manifest encoder,
//                 compiler flags). 16 commits touched src/compiler|bundle|manifest
//                 between 0.8.5 and 0.8.11.
//   sds           spacedatastandards.org. NOTE: TWO different copies feed one
//                 build and they are allowed to disagree —
//                   - header generation reads the SDK's OWN locked dependency
//                     (require.resolve inside src/compiler/flatcSupport.js), which
//                     compiles the SDS TAB/PIV generated C++ into every guest;
//                   - manifest validation reads the EXTERNAL standards root
//                     (SPACE_DATA_STANDARDS_ROOT / options.standardsRoot), which
//                     is a sibling directory on whoever's disk is building.
//                 Both are recorded, separately, because a mismatch is a real
//                 failure mode: SDK 0.8.5 against a 1.184.0 external root fails
//                 the compile outright ("stale-scv-contract": TARGET_RESULTS).
//   flatcWasm     generates those headers and the embedded flatbuffers runtime.
//   flatbuffers   the JS runtime the manifest encoder uses.
//   emception     the vendored clang/emscripten. Pinned EXACT (1.0.0) and has not
//                 moved — it is not the culprit here, but it is a build input and
//                 an unpinned bump would be invisible without this record.
//
// Import `resolveToolchain()` from a build or a check; run this file directly to
// print the current identity.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

// The dependencies whose version can change the emitted bytes. Anything not in
// this list is a build input we are asserting CANNOT reach the artifact; adding
// one that can, without listing it here, is the bug this file guards against.
const GUEST_REACHING_SDK_DEPENDENCIES = Object.freeze([
  "spacedatastandards.org",
  "flatc-wasm",
  "flatbuffers",
  "sdn-emception",
]);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function git(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

// The SDK is linked in by `file:` path, so there is no lockfile line naming it.
// Its identity is its checkout: version + HEAD sha + whether that checkout is
// dirty. A dirty SDK checkout means the artifact cannot be reproduced by anyone
// else at all, so it is recorded rather than hidden.
export function resolveSdkRoot() {
  const require = createRequire(path.join(REPO_ROOT, "package.json"));
  try {
    return path.dirname(require.resolve("space-data-module-sdk/package.json"));
  } catch {
    const linked = path.join(REPO_ROOT, "node_modules", "space-data-module-sdk");
    return fs.existsSync(linked) ? fs.realpathSync(linked) : null;
  }
}

function describeSdk(sdkRoot) {
  if (!sdkRoot) return { resolved: false };
  const pkg = readJson(path.join(sdkRoot, "package.json")) ?? {};
  const commit = git(["rev-parse", "HEAD"], sdkRoot);
  const status = git(["status", "--porcelain"], sdkRoot);
  return {
    resolved: true,
    version: pkg.version ?? null,
    commit,
    // A dirty SDK checkout is recorded, never silently normalised away: an
    // artifact built against uncommitted SDK source is not reproducible by
    // anyone, and the ledger must be able to say so.
    dirty: status === null ? null : status.length > 0,
  };
}

function describeSdkDependencies(sdkRoot) {
  const out = {};
  for (const name of GUEST_REACHING_SDK_DEPENDENCIES) {
    const pkg = sdkRoot ? readJson(path.join(sdkRoot, "node_modules", name, "package.json")) : null;
    out[name] = pkg?.version ?? null;
  }
  return out;
}

// The external standards root: what manifest VALIDATION reads. Modules pass it
// as ../../../spacedatastandards.org relative to their own build.mjs, or via
// SPACE_DATA_STANDARDS_ROOT. Its version is recorded but its PATH is not — the
// path is a property of whose laptop this is, and baking it in would make the
// ledger machine-specific for no gain.
export function describeStandardsRoot(standardsRoot) {
  const root = standardsRoot
    ?? process.env.SPACE_DATA_STANDARDS_ROOT
    ?? path.join(REPO_ROOT, "..", "spacedatastandards.org");
  const pkg = readJson(path.join(root, "package.json"));
  if (!pkg) return { resolved: false, version: null };
  return { resolved: true, version: pkg.version ?? null, commit: git(["rev-parse", "HEAD"], root) };
}

// THE SECOND LANE. Everything above describes the SDK compiler, and for 103 of
// the 130 committed artifacts that is the whole story. It is not the story for
// the other 27: fourteen modules never reach the SDK compiler at all — they drive
// a repo-local Emscripten `em++` directly, so not one of the inputs listed above
// touched their bytes.
//
// Recording the SDK toolchain against those artifacts would be worse than
// recording nothing, because it would read as an answer. So the raw lane carries
// its own pin (scripts/emsdk-pin.json), its own resolver
// (scripts/lib/emsdk-toolchain.mjs), and its own PER-ARTIFACT record written at
// build time into dist/build-toolchain.json — which is what the ledger reads.
//
// This function reports the lane pin so `--json` shows both lanes at once. It is
// deliberately NOT folded into `toolchainId`: that id names the inputs that
// decide SDK-lane bytes, and mixing in a pin that cannot affect them would churn
// every existing entry to say nothing new.
// Graph task: modules-raw-emcc-lane-unpinned-toolchain.
export function describeEmsdkLane() {
  try {
    const pin = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "scripts", "emsdk-pin.json"), "utf8"));
    return {
      pin: pin.pin.id,
      emscriptenVersion: pin.pin.emscriptenVersion,
      emsdkCommit: pin.pin.emsdkCommit,
      emscriptenRelease: pin.pin.emscriptenRelease,
      modules: pin.laneModules?.length ?? 0,
    };
  } catch {
    return null;
  }
}

export function resolveToolchain(options = {}) {
  const sdkRoot = resolveSdkRoot();
  const toolchain = {
    sdk: describeSdk(sdkRoot),
    sdkDependencies: describeSdkDependencies(sdkRoot),
    externalStandardsRoot: describeStandardsRoot(options.standardsRoot),
  };
  return { ...toolchain, id: toolchainId(toolchain) };
}

// A stable identity for "the set of inputs that decides the bytes". Key order is
// fixed by construction (object literals above), so the JSON is canonical.
export function toolchainId(toolchain) {
  const material = {
    sdk: { version: toolchain.sdk?.version ?? null, commit: toolchain.sdk?.commit ?? null },
    sdkDependencies: toolchain.sdkDependencies ?? {},
    externalStandardsRoot: { version: toolchain.externalStandardsRoot?.version ?? null },
  };
  return `tc-${createHash("sha256").update(JSON.stringify(material)).digest("hex").slice(0, 16)}`;
}

// Human-readable one-liner for failure messages.
export function describeToolchain(toolchain) {
  const deps = toolchain.sdkDependencies ?? {};
  return [
    `sdk ${toolchain.sdk?.version ?? "?"}@${(toolchain.sdk?.commit ?? "?").slice(0, 8)}${toolchain.sdk?.dirty ? " (DIRTY)" : ""}`,
    `sds(sdk) ${deps["spacedatastandards.org"] ?? "?"}`,
    `sds(external) ${toolchain.externalStandardsRoot?.version ?? "?"}`,
    `flatc-wasm ${deps["flatc-wasm"] ?? "?"}`,
    `flatbuffers ${deps.flatbuffers ?? "?"}`,
    `emception ${deps["sdn-emception"] ?? "?"}`,
  ].join(", ");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const toolchain = resolveToolchain();
  const emsdkLane = describeEmsdkLane();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ ...toolchain, emsdkLane }, null, 2));
  } else {
    console.log(toolchain.id);
    console.log(describeToolchain(toolchain));
    if (emsdkLane) {
      console.log(
        `raw-em++ lane ${emsdkLane.pin}: emscripten ${emsdkLane.emscriptenVersion}, ` +
          `emsdk ${emsdkLane.emsdkCommit.slice(0, 12)}, ${emsdkLane.modules} modules`,
      );
    }
  }
}

#!/usr/bin/env node
//
// PROVISION THE PINNED TOOLCHAIN — the one place in this repo that may use the
// network, and only when a human or a CI step invokes it by name.
//
// The point of scripts/lib/emsdk-toolchain.mjs is that `node build.mjs` never
// fetches anything. That is only honest if there is a documented, explicit way to
// GET the toolchain, so this is it. The difference from the code it replaces is
// not that bytes travel over the wire — it is that the fetch is:
//
//   * a separate, named action, not a side effect of building;
//   * pinned by emsdk COMMIT, not just by an emscripten version string;
//   * verified after the fact against scripts/emsdk-pin.json, so a provision that
//     silently produced a different toolchain fails here rather than surfacing
//     three months later as an artifact nobody can reproduce.
//
// Usage:
//   node scripts/provision-emsdk.mjs                  # the pinned emsdk into deps/emsdk
//   node scripts/provision-emsdk.mjs --into <dir>     # somewhere else
//   node scripts/provision-emsdk.mjs --era em-5.0.7   # a historical toolchain, by id
//   node scripts/provision-emsdk.mjs --cryptopp       # the pinned Crypto++ source
//   node scripts/provision-emsdk.mjs --check          # resolve + verify only, no network
//
// Graph task: modules-raw-emcc-lane-unpinned-toolchain.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  REPO_ROOT,
  describeEmsdkRoot,
  loadEmsdkPin,
  resolveLaneToolchain,
} from "./lib/emsdk-toolchain.mjs";

const EMSDK_UPSTREAM = "https://github.com/emscripten-core/emsdk.git";

function run(command, args, cwd) {
  console.log(`  $ ${command} ${args.join(" ")}`);
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

function flag(argv, name) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const next = argv[i + 1];
  return next && !next.startsWith("--") ? next : "true";
}

function provisionEmsdk(argv) {
  const pin = loadEmsdkPin();
  const eraId = flag(argv, "era");
  if (eraId && eraId !== "true" && !pin.knownToolchains?.[eraId]) {
    throw new Error(`unknown toolchain id "${eraId}"; see scripts/emsdk-pin.json knownToolchains`);
  }
  const spec = eraId && eraId !== "true" ? pin.knownToolchains[eraId] : pin.pin;
  const id = eraId && eraId !== "true" ? eraId : pin.pin.id;
  if (!spec.emsdkCommit) {
    throw new Error(
      `${id} cannot be provisioned: its emsdk commit is unrecorded (see the note in scripts/emsdk-pin.json). ` +
        `Only toolchains with a pinned commit can be reconstructed.`,
    );
  }

  const into = path.resolve(flag(argv, "into") ?? path.join(REPO_ROOT, "deps", "emsdk"));
  console.log(`Provisioning ${id} (emscripten ${spec.emscriptenVersion}) into ${path.relative(REPO_ROOT, into)}`);

  if (!fs.existsSync(path.join(into, "emsdk_env.sh"))) {
    fs.mkdirSync(path.dirname(into), { recursive: true });
    run("git", ["clone", EMSDK_UPSTREAM, into]);
  }
  // Pin by COMMIT, not by branch tip. `git clone` + `emsdk install <version>` was
  // the old contract and it left the emsdk tooling itself floating.
  run("git", ["fetch", "--depth", "1", "origin", spec.emsdkCommit], into);
  run("git", ["checkout", "--detach", spec.emsdkCommit], into);
  run("./emsdk", ["install", spec.emscriptenVersion], into);
  run("./emsdk", ["activate", spec.emscriptenVersion], into);

  const identity = describeEmsdkRoot(into);
  const problems = [];
  if (identity.emscriptenVersion !== spec.emscriptenVersion) {
    problems.push(`emscripten ${identity.emscriptenVersion} != pinned ${spec.emscriptenVersion}`);
  }
  if (spec.emscriptenRelease && identity.emscriptenRelease && identity.emscriptenRelease !== spec.emscriptenRelease) {
    problems.push(`release ${identity.emscriptenRelease} != pinned ${spec.emscriptenRelease}`);
  }
  if (spec.llvmRevision && identity.llvmRevision && identity.llvmRevision !== spec.llvmRevision) {
    problems.push(`llvm ${identity.llvmRevision} != pinned ${spec.llvmRevision}`);
  }
  if (problems.length) {
    throw new Error(
      `provisioned toolchain does NOT match the pin — do not build with it:\n  - ${problems.join("\n  - ")}\n` +
        `  Upstream may have re-tagged, or the pin is wrong. Either way this is a finding, not a warning.`,
    );
  }
  console.log(`OK — ${id}: emscripten ${identity.emscriptenVersion} (${identity.emscriptenRelease}), llvm ${identity.llvmRevision}`);
  console.log(`Point builds at it with: export SDN_LOCAL_EMSDK_DIR=${into}`);
}

function provisionCryptopp(argv) {
  const pin = loadEmsdkPin();
  const spec = pin.vendoredSources?.cryptopp;
  if (!spec) throw new Error("no cryptopp pin in scripts/emsdk-pin.json");
  const into = path.resolve(flag(argv, "into") ?? path.join(REPO_ROOT, "deps", "cryptopp"));
  console.log(`Provisioning Crypto++ ${spec.version} (${spec.tag}) into ${path.relative(REPO_ROOT, into)}`);
  if (fs.existsSync(path.join(into, "aes.h"))) {
    console.log("  already present");
  } else {
    fs.mkdirSync(path.dirname(into), { recursive: true });
    run("git", ["clone", "--depth=1", "--branch", spec.tag, spec.upstream, into]);
  }
  console.log(`Point builds at it with: export CRYPTOPP_SOURCE_DIR=${into}`);
}

function check() {
  const pin = loadEmsdkPin();
  console.log(`pin ${pin.pin.id}: emscripten ${pin.pin.emscriptenVersion}, emsdk ${pin.pin.emsdkCommit.slice(0, 12)}, ${pin.pin.emscriptenRelease}`);
  try {
    const resolved = resolveLaneToolchain({});
    console.log(`RESOLVED ${resolved.pinId} at ${resolved.identity.rootRelative}`);
    console.log(`  emscripten ${resolved.identity.emscriptenVersion}, llvm ${resolved.identity.llvmRevision}, release ${resolved.identity.emscriptenRelease}`);
  } catch (error) {
    console.error(String(error.message));
    process.exitCode = 1;
  }
}

const argv = process.argv.slice(2);
if (argv.includes("--check")) check();
else if (argv.includes("--cryptopp")) provisionCryptopp(argv);
else provisionEmsdk(argv);

//
// THE RAW EM++ LANE TOOLCHAIN — resolved from a pinned local source, or refused.
//
// WHY THIS FILE EXISTS
//
// Fourteen modules in this repo never reach the SDK compiler. They drive a
// repo-local Emscripten `em++` directly, and every one of them bootstrapped it
// like this:
//
//     if (!fs.existsSync(envScript))  run(`git clone https://github.com/…/emsdk.git ${EMSDK_DIR}`);
//     if (!fs.existsSync(emccPath))   run("./emsdk install 6.0.1");
//
// Three separate defects live in those four lines, and the third is the one
// nobody saw.
//
//   1. NETWORK AT BUILD TIME. Only the emsdk BOOTSTRAP repo is committed (137
//      files under analysis/od/deps/emsdk, none of them upstream/emscripten). In
//      a clean checkout the build reaches the network before it reaches a
//      compiler, so it is not reproducible from committed source and a
//      compromised upstream at build time lands inside signed artifacts.
//
//   2. NOTHING RECORDED. `6.0.1` names an emscripten VERSION. It does not name
//      the emsdk commit, the emscripten release build, or the LLVM revision, and
//      none of the three were written anywhere — so scripts/artifact-provenance.json
//      described an SDK toolchain that had no part in producing these bytes.
//
//   3. THE PIN NEVER FIRED. `install` is guarded by `!fs.existsSync(emccPath)`.
//      Any emsdk already sitting in `deps/` — of any age, any version — silently
//      satisfies the guard and the pinned version is never installed. Measured on
//      the build machine 2026-08-09: fifteen emsdk checkouts, FOUR different
//      Emscriptens (5.0.5, 5.0.6, 5.0.7, 6.0.1), and at least three of them
//      inside the shipped bytes of this one lane. A version pin that only applies
//      to a cold clone is decorative.
//
// WHAT THIS MODULE DOES INSTEAD
//
//   * resolveLaneToolchain() searches a fixed, ordered candidate list of
//     IN-REPOSITORY emsdk roots, reads the identity of the first one that exists,
//     and VERIFIES it against scripts/emsdk-pin.json. Never clones. Never
//     installs. Never touches the network under any circumstance.
//   * A missing toolchain is an error that names the pin and the one command that
//     provisions it. A WRONG toolchain is an error that names both versions —
//     which is the case the old code silently accepted.
//   * The resolved identity is returned to the caller and written next to the
//     artifact as dist/build-toolchain.json, so the bytes and the toolchain that
//     made them travel together in the repo instead of only in someone's shell
//     history.
//
// ERA BUILDS. Reproducing a historical artifact needs the historical toolchain,
// which by construction is not the pin. SDN_EMSDK_ERA=<id> (an id from
// knownToolchains, e.g. `em-5.0.7`) permits exactly that one alternative and is
// recorded in the sidecar as `era: true`. It is deliberately not a boolean
// "skip the check": you have to say WHICH toolchain you are claiming.
//
// Graph task: modules-raw-emcc-lane-unpinned-toolchain.
// Predecessor: modules-dist-not-reproducible-at-sdk-pin (reproducibility = recorded inputs).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PIN_FILE = path.join(REPO_ROOT, "scripts", "emsdk-pin.json");

export function loadEmsdkPin() {
  return JSON.parse(fs.readFileSync(PIN_FILE, "utf8"));
}

// The emsdk roots this repo is allowed to compile against. Ordered: an explicit
// override first, then the module's own deps/, then a repo-level shared one,
// then every other module's deps/ — because the lane's real problem was never
// "which directory", it was "nobody checked what was in it". A candidate from
// anywhere on this list is fine PROVIDED it matches the pin, and which one was
// used is recorded. Listing them explicitly (rather than globbing) keeps
// resolution deterministic across machines with different leftovers on disk.
const SHARED_EMSDK_CANDIDATES = Object.freeze([
  "deps/emsdk",
  "analysis/od/deps/emsdk",
  "licensing/core/deps/emsdk",
  "data-source/iss-source/deps/emsdk",
  "data-source/cpf-source/deps/emsdk",
  "data-source/intelsat-source/deps/emsdk",
  "data-source/glonass-source/deps/emsdk",
  "data-source/spacex-starlink-source/deps/emsdk",
  "analysis/maneuver/deps/emsdk",
  "delivery/plugin-delivery/deps/emsdk",
  "licensing/client-decrypt/deps/emsdk",
  "propagator/atmosphere/deps/emsdk",
  "propagator/hpop/deps/emsdk",
  "licensing/protection-key-server/deps/emsdk",
  "licensing/protection-license-client/deps/emsdk",
  "analysis/conjunction-assessment/deps/emsdk",
]);

function populated(emsdkDir) {
  return (
    fs.existsSync(path.join(emsdkDir, "emsdk_env.sh")) &&
    fs.existsSync(path.join(emsdkDir, "upstream", "emscripten", "em++"))
  );
}

function readFirstLine(file) {
  try {
    return fs.readFileSync(file, "utf8").trim().replace(/^"|"$/g, "");
  } catch {
    return null;
  }
}

function gitHead(dir) {
  // Only meaningful when the emsdk is its OWN checkout. analysis/od/deps/emsdk
  // is tracked inside THIS repo, so a naive `git rev-parse` there answers with
  // the modules repo's HEAD — a wrong answer that looks like a right one.
  if (!fs.existsSync(path.join(dir, ".git"))) return null;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

// em++ prints `emcc (…) <version> (<llvm-revision>)`. The LLVM revision is the
// finest-grained identity available without hashing the whole tree, and it is
// what actually decides the emitted code.
function emxxIdentity(emsdkDir) {
  const emxx = path.join(emsdkDir, "upstream", "emscripten", "em++");
  try {
    const out = execFileSync(emxx, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, EM_CACHE: process.env.EM_CACHE ?? path.join(emsdkDir, ".emcache-probe") },
    });
    const match = /^emcc \(.*?\)\s+(\S+)\s+\(([0-9a-f]{8,40})\)/m.exec(out);
    return match ? { version: match[1], llvmRevision: match[2] } : { version: null, llvmRevision: null };
  } catch {
    return { version: null, llvmRevision: null };
  }
}

export function describeEmsdkRoot(emsdkDir) {
  const fromFile = readFirstLine(path.join(emsdkDir, "upstream", "emscripten", "emscripten-version.txt"));
  const probed = emxxIdentity(emsdkDir);
  return {
    root: emsdkDir,
    rootRelative: path.relative(REPO_ROOT, emsdkDir),
    emscriptenVersion: probed.version ?? fromFile,
    emscriptenRelease: readFirstLine(path.join(emsdkDir, "upstream", ".emsdk_version")),
    llvmRevision: probed.llvmRevision,
    emsdkCommit: gitHead(emsdkDir),
  };
}

function matches(identity, expected) {
  if (!identity.emscriptenVersion || identity.emscriptenVersion !== expected.emscriptenVersion) return false;
  // The release string is the exact prebuilt toolchain emsdk downloaded. When
  // both sides have one it is authoritative; a checkout that lost the file falls
  // back to the version, which is weaker but not a reason to refuse a build.
  if (expected.emscriptenRelease && identity.emscriptenRelease && identity.emscriptenRelease !== expected.emscriptenRelease) {
    return false;
  }
  if (expected.llvmRevision && identity.llvmRevision && identity.llvmRevision !== expected.llvmRevision) return false;
  return true;
}

// NOTE ON A GUARD THIS REPLACES. flows/supplemental-omm/nodes/flatsql/build.mjs
// required SDN_LOCAL_EMSDK_DIR to resolve INSIDE the modules repo, to stop a
// build silently picking up a system Emscripten. Identity verification is a
// strictly stronger version of that promise — it does not matter where the
// toolchain lives once its emscripten version, release build and LLVM revision
// are all checked against the pin — and containment actively breaks the one lane
// that measures reproducibility, which builds committed source in a THROWAWAY
// worktree outside the repo. So the location check gives way to the identity
// check; it is not simply dropped.
function candidateRoots({ moduleDir, extraCandidates = [], onlyCandidates = false }) {
  const roots = [];
  const push = (p) => {
    const resolved = path.resolve(p);
    if (!roots.includes(resolved)) roots.push(resolved);
  };
  for (const extra of extraCandidates) push(path.isAbsolute(extra) ? extra : path.join(REPO_ROOT, extra));
  // `onlyCandidates` searches nothing but what the caller named — the shape a
  // test needs to provoke a refusal deterministically, without a stray emsdk on
  // the machine turning the negative control into a pass.
  if (onlyCandidates) return roots;
  const ordered = [];
  if (process.env.SDN_LOCAL_EMSDK_DIR) ordered.push(process.env.SDN_LOCAL_EMSDK_DIR);
  if (moduleDir) ordered.push(path.join(REPO_ROOT, moduleDir, "deps", "emsdk"));
  ordered.push(...extraCandidates.map((e) => (path.isAbsolute(e) ? e : path.join(REPO_ROOT, e))));
  ordered.push(...SHARED_EMSDK_CANDIDATES.map((shared) => path.join(REPO_ROOT, shared)));
  roots.length = 0;
  for (const candidate of ordered) push(candidate);
  return roots;
}

function provisionHint(expected, pinId) {
  return (
    `Provision it (this is the ONLY step permitted to use the network):\n` +
    `    node scripts/provision-emsdk.mjs\n` +
    `  or point SDN_LOCAL_EMSDK_DIR at an existing emsdk that is ${pinId} ` +
    `(emscripten ${expected.emscriptenVersion}, ${expected.emscriptenRelease}).`
  );
}

/**
 * Resolve the pinned Emscripten for a raw-em++ lane module.
 *
 * NEVER clones, NEVER installs, NEVER reaches the network. Either a local
 * checkout satisfies the pin or the build stops with a message that says which
 * pin was wanted, what was found instead, and how to provision it.
 *
 * @param {object} options
 * @param {string} [options.moduleDir]  repo-relative module dir, e.g. "data-source/iss-source"
 * @param {string[]} [options.extraCandidates]  additional emsdk roots to try before the shared list
 * @returns {{root: string, identity: object, pinId: string, era: boolean}}
 */
export function resolveLaneToolchain(options = {}) {
  const pin = loadEmsdkPin();
  const eraId = process.env.SDN_EMSDK_ERA || null;
  if (eraId && !pin.knownToolchains?.[eraId]) {
    throw new Error(
      `SDN_EMSDK_ERA=${eraId} is not a toolchain this repo knows. ` +
        `Valid ids: ${Object.keys(pin.knownToolchains ?? {}).join(", ")}.`,
    );
  }
  const wantedId = eraId ?? pin.pin.id;
  const expected = eraId ? pin.knownToolchains[eraId] : pin.pin;

  const roots = candidateRoots(options);
  const found = [];
  for (const root of roots) {
    if (!populated(root)) continue;
    const identity = describeEmsdkRoot(root);
    if (matches(identity, expected)) {
      return { root, identity, pinId: wantedId, era: Boolean(eraId) };
    }
    found.push(identity);
  }

  if (found.length === 0) {
    throw new Error(
      `NO PINNED EMSCRIPTEN. This build needs ${wantedId} (emscripten ${expected.emscriptenVersion}) ` +
        `and will NOT fetch it: a build that downloads its own compiler cannot be reproduced from committed ` +
        `source, and puts whatever upstream serves that day inside a signed artifact.\n` +
        `  Searched (none populated): ${roots.map((r) => path.relative(REPO_ROOT, r)).join(", ")}\n  ` +
        provisionHint(expected, wantedId),
    );
  }

  const inventory = found
    .map((f) => `    ${f.rootRelative}: emscripten ${f.emscriptenVersion ?? "?"} (${f.emscriptenRelease ?? "no release marker"})`)
    .join("\n");
  throw new Error(
    `WRONG EMSCRIPTEN. This build needs ${wantedId} (emscripten ${expected.emscriptenVersion}, ` +
      `${expected.emscriptenRelease}); every local emsdk is a different toolchain:\n${inventory}\n` +
      `  This is the exact case the old bootstrap accepted in silence — `+
      `\`emsdk install\` was guarded by "is there any emcc here", so the declared version never installed and ` +
      `the artifact was built by whatever happened to be on disk.\n  ` +
      provisionHint(expected, wantedId) +
      `\n  To deliberately rebuild historical bytes, name the era toolchain: SDN_EMSDK_ERA=<id> (see scripts/emsdk-pin.json knownToolchains).`,
  );
}

/**
 * Record what actually compiled the artifacts, beside the artifacts.
 * `scripts/check-artifact-reproducibility.mjs` reads these back into the ledger.
 */
export function recordLaneToolchain(distDir, resolved, extra = {}) {
  fs.mkdirSync(distDir, { recursive: true });
  const record = {
    lane: "raw-em++",
    pinId: resolved.pinId,
    era: resolved.era,
    emscriptenVersion: resolved.identity.emscriptenVersion,
    emscriptenRelease: resolved.identity.emscriptenRelease,
    llvmRevision: resolved.identity.llvmRevision,
    emsdkCommit: resolved.identity.emsdkCommit,
    emsdkRoot: resolved.identity.rootRelative,
    ...extra,
  };
  fs.writeFileSync(path.join(distDir, "build-toolchain.json"), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/**
 * Everything a raw-em++ build.mjs needs, in one call: verify the pin, export the
 * emsdk environment into this process, and return the identity for recording.
 * Replaces the old per-module `ensureLocalEmscripten()` clone-and-install.
 */
export function activateLaneToolchain(options = {}) {
  const resolved = resolveLaneToolchain(options);
  const emCache = options.emCache ?? path.join(resolved.root, ".emcache");
  fs.mkdirSync(emCache, { recursive: true });
  process.env.EM_CACHE = process.env.EM_CACHE || emCache;

  const quoted = `'${resolved.root.replace(/'/g, `'"'"'`)}'`;
  const sourced = execFileSync(
    "bash",
    ["-lc", `source ${quoted}/emsdk_env.sh >/dev/null 2>&1 && env -0`],
    { encoding: "buffer", env: { ...process.env, EM_CACHE: process.env.EM_CACHE } },
  );
  for (const entry of sourced.toString("utf8").split("\0")) {
    if (!entry) continue;
    const sep = entry.indexOf("=");
    if (sep <= 0) continue;
    process.env[entry.slice(0, sep)] = entry.slice(sep + 1);
  }
  console.log(
    `  Emscripten ${resolved.pinId}${resolved.era ? " (ERA BUILD)" : ""}: ` +
      `${resolved.identity.emscriptenVersion} @ ${resolved.identity.rootRelative} ` +
      `(${resolved.identity.emscriptenRelease ?? "no release marker"})`,
  );
  return resolved;
}

/**
 * The same rule for vendored third-party SOURCE that these builds compile in:
 * present locally or refused. `delivery/plugin-delivery` and
 * `licensing/client-decrypt` used to `git clone --branch CRYPTOPP_8_9_0` at build
 * time, which is the identical supply-chain hole one layer down.
 */
export function resolveVendoredSource(name, { candidates = [], sentinel }) {
  const pin = loadEmsdkPin();
  const spec = pin.vendoredSources?.[name];
  if (!spec) throw new Error(`no vendored-source pin for "${name}" in scripts/emsdk-pin.json`);
  const envDir = spec.provisionEnv ? process.env[spec.provisionEnv] : null;
  const roots = [envDir, ...candidates].filter(Boolean).map((p) => path.resolve(p));
  for (const root of roots) {
    if (fs.existsSync(path.join(root, sentinel))) return { root, version: spec.version };
  }
  throw new Error(
    `NO LOCAL ${name.toUpperCase()} ${spec.version}. This build will NOT fetch it ` +
      `(same reason as the compiler: a build that downloads its own sources is not reproducible ` +
      `from committed source and lands unreviewed upstream bytes in a signed artifact).\n` +
      `  Searched: ${roots.map((r) => path.relative(REPO_ROOT, r)).join(", ") || "(nothing)"}\n` +
      `  Provision it (the ONLY step permitted to use the network):\n` +
      `    node scripts/provision-emsdk.mjs --${name}\n` +
      `  or set ${spec.provisionEnv} to an existing ${spec.tag ?? spec.version} source tree.`,
  );
}

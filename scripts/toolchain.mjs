#!/usr/bin/env node
// The native toolchains the modules builds need beyond node_modules and emsdk (scripts/lib/emsdk-shared.sh), pinned
// and resolved in one place (docs/BUILDING.md): wasi-sdk 30.0, the Eigen headers and the flatbuffers C++ headers. A
// pin is a version, a source and a content digest; a directory is used only when its digest is the pin's, so two
// machines that resolve the same pin compile the same headers and bytes.
//
//   node scripts/toolchain.mjs path <wasi-sdk|eigen|flatbuffers>   the pinned directory (made under the cache if absent)
//   node scripts/toolchain.mjs env                                   export lines for every pin (eval in a shell)
//   node scripts/toolchain.mjs ensure                                every pin made and checked
//   node scripts/toolchain.mjs verify [--rebuild fit-core]           every pin checked; with --rebuild, the
//                                                                    supplemental-omm OD fit core rebuilt from these
//                                                                    pins and compared byte for byte with the committed one
//
// The cache is $SDN_TOOL_CACHE (default ~/.cache/sdn-tools, the one emsdk uses). Sources:
// - wasi-sdk: SDN_WASI_SDK_ARCHIVE (a local copy of the release archive), else the WebAssembly/wasi-sdk GitHub release;
//   the archive must hash to the pin.
// - eigen: SDN_EIGEN_ARCHIVE, else an existing include tree with the pinned digest (Homebrew eigen 5.0.1:
//   /opt/homebrew/include/eigen3), else the GitLab release archive.
// - flatbuffers: the git tree of include/ named by the pin, archived from SDN_FLATBUFFERS_GIT, else the stack's
//   flatbuffers checkout (repos/main-packages/flatbuffers, found from GAUNTLET_STACK_ROOT, SDN_STACK_ROOT or the parent
//   directories of this repository).
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = process.env.SDN_TOOL_CACHE || path.join(os.homedir(), ".cache/sdn-tools");
const UA = "spacedatanetwork-stack-ci (+https://github.com/DigitalArsenal)";

export const PINS = Object.freeze({
  "wasi-sdk": {
    version: "30.0",
    dir: "wasi-sdk-30.0-arm64-macos",
    archive: "wasi-sdk-30.0-arm64-macos.tar.gz",
    url: "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-30/wasi-sdk-30.0-arm64-macos.tar.gz",
    archiveSha256: "2c2ed99296857e60fd14c3f40fe226231f296409502491094704089c31a16740",
    // the digest of bin/, lib/clang and share/wasi-sysroot (what the builds read)
    digestOf: ["bin/clang", "bin/clang++", "bin/wasm-ld", "lib/clang", "share/wasi-sysroot"],
    platform: "darwin-arm64",
    digest: "5a1af156569c1f67b83970d6b60f4f037ff27a2044f36702d78a45a0bc2207fa",
  },
  eigen: {
    version: "5.0.1",
    dir: "eigen-5.0.1",
    url: "https://gitlab.com/libeigen/eigen/-/archive/5.0.1/eigen-5.0.1.tar.gz",
    candidates: ["/opt/homebrew/include/eigen3"],
    digestOf: ["Eigen"],
    digest: "6afae0f37cb61ff45ff0b18c67f1fd48c35d323fa647d5325cd46d670b1b49be",
  },
  flatbuffers: {
    version: "25.12.19",
    tree: "0bb27c3d66f4f33d2f4bd6f6a3fb86eec37755cf",
    dir: "flatbuffers-include-0bb27c3d66f4",
    digestOf: ["flatbuffers"],
    digest: "10bbc685db00696200b24b14183330180a56523f5041c19779b432e6268fb919",
  },
});
// The digests (treeDigest) of the trees the committed artifacts were built with (modules a29c4aec).
const DIGESTS = Object.freeze(Object.fromEntries(Object.entries(PINS).map(([k, v]) => [k, v.digest])));

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
/** sha256 over "relative path, NUL, file sha256" lines of every file and symlink under each of `parts`, sorted. */
export function treeDigest(root, parts) {
  const lines = [];
  const walk = (rel) => {
    const abs = path.join(root, rel);
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) lines.push(`${rel}\0link:${fs.readlinkSync(abs)}`);
    else if (st.isDirectory()) for (const name of fs.readdirSync(abs).sort()) walk(path.posix.join(rel, name));
    else lines.push(`${rel}\0${sha256(fs.readFileSync(abs))}`);
  };
  for (const p of parts) { if (!fs.existsSync(path.join(root, p))) return null; walk(p); }
  return sha256(lines.sort().join("\n"));
}

const check = (name, dir) => fs.existsSync(dir) && treeDigest(dir, PINS[name].digestOf) === DIGESTS[name];

function download(url, file) {
  execFileSync("curl", ["-sS", "-L", "--fail", "--max-time", "600", "-A", UA, "-o", file, url], { stdio: "inherit" });
}

function stackRoot() {
  for (const env of [process.env.GAUNTLET_STACK_ROOT, process.env.SDN_STACK_ROOT]) if (env && fs.existsSync(env)) return env;
  for (let d = REPO; d !== path.dirname(d); d = path.dirname(d)) if (fs.existsSync(path.join(d, "repos/main-packages/flatbuffers"))) return d;
  const sibling = path.join(os.homedir(), "software/spacedatanetwork-stack");
  return fs.existsSync(sibling) ? sibling : null;
}

function make(name) {
  const pin = PINS[name];
  const dir = path.join(CACHE, pin.dir);
  const tmp = `${dir}.${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  try {
    if (name === "wasi-sdk") {
      if (`${process.platform}-${process.arch}` !== pin.platform) throw new Error(`wasi-sdk pin is ${pin.platform}; this host is ${process.platform}-${process.arch}`);
      let archive = process.env.SDN_WASI_SDK_ARCHIVE;
      if (!archive) { archive = path.join(tmp, pin.archive); download(pin.url, archive); }
      const got = sha256(fs.readFileSync(archive));
      if (got !== pin.archiveSha256) throw new Error(`wasi-sdk archive ${archive} hashes to ${got}, the pin is ${pin.archiveSha256}`);
      execFileSync("tar", ["-xzf", archive, "-C", tmp, "--strip-components=1"]);
      fs.rmSync(path.join(tmp, pin.archive), { force: true });
    } else if (name === "eigen") {
      const local = pin.candidates.find((c) => check("eigen", c));
      if (local && !process.env.SDN_EIGEN_ARCHIVE) fs.cpSync(path.join(local, "Eigen"), path.join(tmp, "Eigen"), { recursive: true });
      else {
        let archive = process.env.SDN_EIGEN_ARCHIVE;
        if (!archive) { archive = path.join(os.tmpdir(), `eigen-${pin.version}-${process.pid}.tar.gz`); download(pin.url, archive); }
        const x = fs.mkdtempSync(path.join(os.tmpdir(), "eigen-"));
        execFileSync("tar", ["-xzf", archive, "-C", x, "--strip-components=1"]);
        fs.cpSync(path.join(x, "Eigen"), path.join(tmp, "Eigen"), { recursive: true });
        fs.rmSync(x, { recursive: true, force: true });
        if (!process.env.SDN_EIGEN_ARCHIVE) fs.rmSync(archive, { force: true });
      }
    } else if (name === "flatbuffers") {
      const git = process.env.SDN_FLATBUFFERS_GIT || (stackRoot() && path.join(stackRoot(), "repos/main-packages/flatbuffers"));
      if (!git || !fs.existsSync(git)) throw new Error("no flatbuffers git directory (SDN_FLATBUFFERS_GIT or the stack's repos/main-packages/flatbuffers)");
      const tar = execFileSync("git", ["-C", git, "archive", pin.tree], { maxBuffer: 1 << 28 });
      execFileSync("tar", ["-x", "-C", tmp], { input: tar });
    }
    if (treeDigest(tmp, pin.digestOf) !== DIGESTS[name]) throw new Error(`${name}: the made tree's digest ${treeDigest(tmp, pin.digestOf)} is not the pin's ${DIGESTS[name]}`);
    if (fs.existsSync(dir)) fs.rmSync(tmp, { recursive: true, force: true }); else fs.renameSync(tmp, dir);
  } catch (error) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw error;
  }
  return dir;
}

/** The pinned directory of `name`: the cache's copy when its digest is the pin's, else made. */
export function resolve(name) {
  if (!PINS[name]) throw new Error(`no toolchain pin ${name} (${Object.keys(PINS).join(", ")})`);
  const dir = path.join(CACHE, PINS[name].dir);
  if (check(name, dir)) return dir;
  if (fs.existsSync(dir)) throw new Error(`${dir} exists but its digest is not the pin's: remove it and run ensure`);
  return make(name);
}

/** The environment every build reads (scripts in docs/BUILDING.md): the pinned paths and the SDK compile cache off. */
export function buildEnv() {
  const wasi = resolve("wasi-sdk");
  return {
    WASI_SDK_PATH: wasi,
    SDN_OD_EIGEN_DIR: resolve("eigen"),
    SDN_FLATBUFFERS_INCLUDE: resolve("flatbuffers"),
    SDN_FLATBUFFERS_INCLUDE_DIR: resolve("flatbuffers"),
    FLATBUFFERS_INCLUDE_DIR: resolve("flatbuffers"),
    // the SDK's compile cache replays a cached object without staging the support headers a build that keeps its temp
    // directory reads (flows/supplemental-omm/nodes/od): a reproducible build compiles
    SPACE_DATA_MODULE_SDK_COMPILE_CACHE: "0",
  };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "path") { console.log(resolve(rest[0])); return; }
  if (command === "env") { for (const [k, v] of Object.entries(buildEnv())) console.log(`export ${k}=${JSON.stringify(v)}`); return; }
  if (command === "digest") { console.log(treeDigest(path.resolve(rest[1]), PINS[rest[0]].digestOf)); return; }
  if (command === "ensure" || command === "verify") {
    let ok = true;
    for (const name of Object.keys(PINS)) {
      try { const dir = resolve(name); console.log(`${name} ${PINS[name].version}: ${dir} (digest ${DIGESTS[name].slice(0, 16)})`); }
      catch (error) { ok = false; console.log(`${name} ${PINS[name].version}: ${error.message}`); }
    }
    if (ok && rest.includes("--rebuild") && rest[rest.indexOf("--rebuild") + 1] === "fit-core") {
      const out = fs.mkdtempSync(path.join(os.tmpdir(), "fit-core-"));
      try {
        const env = { ...process.env, ...buildEnv() };
        const script = path.join(REPO, "flows/supplemental-omm/nodes/od/vendor/build-fit-core.sh");
        const r = spawnSync("bash", [script, out], { env, encoding: "utf8" });
        if (r.status !== 0) { ok = false; console.log(`fit core build failed: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" | ")}`); }
        else {
          const built = sha256(fs.readFileSync(path.join(out, "od-fit-core.o")));
          const committed = sha256(fs.readFileSync(path.join(REPO, "flows/supplemental-omm/nodes/od/vendor/od-fit-core.o")));
          console.log(`fit core rebuilt from the pins: ${built}; committed: ${committed}; ${built === committed ? "byte-identical" : "DIFFERENT"}`);
          ok &&= built === committed;
        }
      } finally { fs.rmSync(out, { recursive: true, force: true }); }
    }
    console.log(`TOOLCHAIN ${ok ? "PASS" : "FAIL"}`);
    process.exit(ok ? 0 : 1);
  }
  console.error("usage: toolchain.mjs path <name> | env | ensure | verify [--rebuild fit-core] | digest <name> <dir>");
  process.exit(2);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();

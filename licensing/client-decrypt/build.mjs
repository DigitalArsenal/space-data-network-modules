#!/usr/bin/env node
/**
 * Build the SDN client-decrypt WASM module using a repo-local emsdk toolchain.
 *
 * Prerequisites:
 *   - Internet access to fetch Crypto++ 8.9.0 (or set CRYPTOPP_SOURCE_DIR)
 *   - npm install (for space-data-module-sdk + flatc-wasm)
 *
 * Usage:
 *   node build.mjs
 *
 * Output:
 *   dist/client-decrypt.wasm
 *   dist/isomorphic/module.wasm
 *
 * Environment:
 *   CRYPTOPP_SOURCE_DIR      — local Crypto++ source tree (skips git clone)
 *   SDN_LOCAL_EMSDK_DIR      — repo-local emsdk root override
 *   FLATBUFFERS_INCLUDE_DIR  — path to flatbuffers C++ headers (optional override)
 */

import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  signModuleArtifact,
  verifyModuleArtifact,
} from "space-data-module-sdk/bundle";
import { assertArtifactThreadModel } from "../../scripts/lib/thread-model.mjs";

// THREAD MODEL — declared, never inferred (full rationale in
// scripts/lib/thread-model.mjs; graph task modules-undeclared-threadmodel-artifacts).
//
// This build does NOT go through the SDK compiler — it drives a vendored
// Emscripten `em++` directly — so `resolveThreadModel` never runs and there is no
// `compileModuleFromSource` argument to carry a declaration. The module therefore
// read as "undeclared" in the artifact-reproducibility census with no way to
// answer, which is a reporting defect, not a build defect: the lane here is fixed
// by the command line, `-sSTANDALONE_WASM=1 -sPURE_WASI=1` and no `-pthread`.
//
// Truth of the SHIPPED artifact 4ac3c6016f30…: unshared linear memory, no
// `wasi.thread-spawn` import, no `wasi_thread_start` export.
//
// `assertArtifactThreadModel` re-reads the EMITTED wasm at the end of this build
// and refuses the declaration if the bytes ever contradict it. A declaration
// nothing verifies is a comment.
const THREAD_MODEL = "single-thread";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EMSDK_DIR = path.resolve(
  process.env.SDN_LOCAL_EMSDK_DIR || path.join(__dirname, "deps", "emsdk"),
);
const EM_CACHE_DIR = path.join(__dirname, ".emcache");
const BUILD_DIR = path.join(__dirname, ".build");
const DIST_DIR = path.join(__dirname, "dist");
const ISOMORPHIC_DIST_DIR = path.join(DIST_DIR, "isomorphic");
const SRC_DIR = path.join(__dirname, "src");
const TOOLCHAIN_STAMP_PATH = path.join(BUILD_DIR, ".emsdk-path");
const CORE_SDS_GENERATED_DIR = path.resolve(
  __dirname,
  "../core/src/cpp/generated/sds",
);
const MODULE_SIGNING_KEYPAIR_PATH =
  process.env.SDN_MODULE_SIGNING_KEYPAIR ||
  path.resolve(
    __dirname,
    "../../../../ancillary-packages/space-data-module-sdk/test/support/dev-module-signing-keypair.json",
  );

// ── Helpers ────────────────────────────────────────────────────────────────────

function run(cmd, opts = {}) {
  console.log(`  $ ${cmd}`);
  execSync(cmd, { stdio: "inherit", ...opts });
}

function runSilent(cmd, opts = {}) {
  return execSync(cmd, { encoding: "utf8", ...opts });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function activateLocalEmsdk() {
  const envScript = path.join(EMSDK_DIR, "emsdk_env.sh");
  const sourcedEnv = execFileSync(
    "bash",
    ["-lc", `source ${shellQuote(envScript)} >/dev/null 2>&1 && env -0`],
    {
      encoding: "buffer",
      env: {
        ...process.env,
        EM_CACHE: process.env.EM_CACHE || EM_CACHE_DIR,
      },
    },
  );

  for (const entry of sourcedEnv.toString("utf8").split("\0")) {
    if (!entry) {
      continue;
    }
    const separator = entry.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = entry.slice(0, separator);
    const value = entry.slice(separator + 1);
    process.env[key] = value;
  }
}

function ensureLocalEmscripten() {
  fs.mkdirSync(EM_CACHE_DIR, { recursive: true });
  process.env.EM_CACHE = process.env.EM_CACHE || EM_CACHE_DIR;

  const envScript = path.join(EMSDK_DIR, "emsdk_env.sh");
  const emccPath = path.join(EMSDK_DIR, "upstream", "emscripten", "emcc");

  if (!fs.existsSync(envScript)) {
    console.log(`  Cloning emsdk into ${EMSDK_DIR}...`);
    fs.mkdirSync(path.dirname(EMSDK_DIR), { recursive: true });
    run(`git clone https://github.com/emscripten-core/emsdk.git ${EMSDK_DIR}`);
  }
  if (!fs.existsSync(emccPath)) {
    console.log("  Installing local emsdk...");
    run("./emsdk install 6.0.1", { cwd: EMSDK_DIR });
    run("./emsdk activate 6.0.1", { cwd: EMSDK_DIR });
  }

  activateLocalEmsdk();
}

function syncToolchainStamp() {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  const recorded = fs.existsSync(TOOLCHAIN_STAMP_PATH)
    ? fs.readFileSync(TOOLCHAIN_STAMP_PATH, "utf8").trim()
    : "";
  if (recorded && recorded !== EMSDK_DIR) {
    console.log("  Local emsdk path changed; clearing cached toolchain outputs...");
    fs.rmSync(path.join(BUILD_DIR, "cryptopp-obj"), { recursive: true, force: true });
    fs.rmSync(path.join(BUILD_DIR, "libcryptopp.a"), { force: true });
  }
  fs.writeFileSync(TOOLCHAIN_STAMP_PATH, `${EMSDK_DIR}\n`, "utf8");
}

// ── Crypto++ source provisioning ──────────────────────────────────────────────

function setupCryptoppIncludeAlias(srcDir) {
  const parentDir = path.dirname(srcDir);
  const aliasDir = path.join(parentDir, "cryptopp");
  if (!fs.existsSync(aliasDir)) {
    try { fs.symlinkSync(srcDir, aliasDir); } catch {}
  }
  return { srcDir, parentDir };
}

async function ensureCryptoppSources(dir) {
  const explicit = process.env.CRYPTOPP_SOURCE_DIR;
  if (explicit) {
    if (fs.existsSync(path.join(explicit, "aes.h"))) {
      console.log(`  Using local Crypto++ from ${explicit}`);
      return setupCryptoppIncludeAlias(explicit);
    }
    if (fs.existsSync(path.join(explicit, "cryptopp", "aes.h"))) {
      console.log(`  Using local Crypto++ from ${explicit}/cryptopp`);
      return setupCryptoppIncludeAlias(path.join(explicit, "cryptopp"));
    }
    throw new Error(`CRYPTOPP_SOURCE_DIR does not contain aes.h: ${explicit}`);
  }

  if (fs.existsSync(path.join(dir, "aes.h"))) {
    console.log("  Crypto++ already fetched.");
    return setupCryptoppIncludeAlias(dir);
  }

  console.log("  Cloning Crypto++ 8.9.0...");
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  run(
    `git clone --depth=1 --branch CRYPTOPP_8_9_0 ` +
      `https://github.com/weidai11/cryptopp.git ${dir}`,
  );
  return setupCryptoppIncludeAlias(dir);
}

// ── Compile Crypto++ to .a ────────────────────────────────────────────────────

function compileCryptoppLib(srcDir, parentDir, objDir, archivePath) {
  if (fs.existsSync(archivePath)) {
    console.log("  Crypto++ library already compiled, skipping.");
    return;
  }
  console.log("  Compiling Crypto++ (this takes a while)...");
  fs.mkdirSync(objDir, { recursive: true });

  const skip = new Set([
    "adhoc.cpp", "bench1.cpp", "bench2.cpp", "bench3.cpp",
    "cryptest.cpp", "cryptestcwd.cpp", "datatest.cpp", "dlltest.cpp",
    "fipsalgt.cpp", "fipstest.cpp", "regtest1.cpp", "regtest2.cpp",
    "regtest3.cpp", "test.cpp", "validat0.cpp", "validat1.cpp",
    "validat2.cpp", "validat3.cpp", "validat4.cpp", "validat5.cpp",
    "validat6.cpp", "validat7.cpp", "validat8.cpp", "validat9.cpp",
    "validat10.cpp",
  ]);

  const sources = fs.readdirSync(srcDir)
    .filter((f) => f.endsWith(".cpp") && !skip.has(f));

  const objFiles = [];
  const emcc = path.join(EMSDK_DIR, "upstream", "emscripten", "emcc");
  const emar = path.join(EMSDK_DIR, "upstream", "emscripten", "emar");
  for (const src of sources) {
    const obj = path.join(objDir, src.replace(".cpp", ".o"));
    if (!fs.existsSync(obj)) {
      run(
        `${shellQuote(emcc)} -O2 -std=c++17 -fwasm-exceptions ` +
          `-DCRYPTOPP_DISABLE_ASM=1 -DCRYPTOPP_DISABLE_SSSE3=1 -DCRYPTOPP_DISABLE_AESNI=1 ` +
          `-I${shellQuote(parentDir)} -I${shellQuote(srcDir)} ` +
          `-c ${shellQuote(path.join(srcDir, src))} -o ${shellQuote(obj)}`,
      );
    }
    objFiles.push(obj);
  }

  run(
    `${shellQuote(emar)} rcs ${shellQuote(archivePath)} ` +
    objFiles.map((obj) => shellQuote(obj)).join(" "),
  );
  console.log(`  Crypto++ archive: ${archivePath}`);
}

// ── Resolve FlatBuffers C++ include path ──────────────────────────────────────

function resolveFlatbuffersInclude() {
  const explicit = process.env.FLATBUFFERS_INCLUDE_DIR;
  if (explicit && fs.existsSync(path.join(explicit, "flatbuffers", "base.h"))) {
    console.log(`  Using FlatBuffers headers: ${explicit}`);
    return explicit;
  }
  const stackFlatbuffersInclude = path.resolve(
    __dirname,
    "../../../flatbuffers/include",
  );
  if (
    fs.existsSync(path.join(stackFlatbuffersInclude, "flatbuffers", "base.h"))
  ) {
    console.log(`  Using stack FlatBuffers headers: ${stackFlatbuffersInclude}`);
    return stackFlatbuffersInclude;
  }
  try {
    const brewPrefix = runSilent("brew --prefix flatbuffers 2>/dev/null", {}).trim();
    const brewInc = path.join(brewPrefix, "include");
    if (fs.existsSync(path.join(brewInc, "flatbuffers", "base.h"))) {
      console.log(`  Using brew FlatBuffers headers: ${brewInc}`);
      return brewInc;
    }
  } catch {}
  throw new Error(
    "FlatBuffers C++ headers not found.\n" +
      "Install with: brew install flatbuffers\n" +
      "Or set FLATBUFFERS_INCLUDE_DIR=/path/to/include",
  );
}

async function signBuiltModule(wasmPath) {
  if (!fs.existsSync(MODULE_SIGNING_KEYPAIR_PATH)) {
    throw new Error(`Module signing keypair not found: ${MODULE_SIGNING_KEYPAIR_PATH}`);
  }
  const keypair = JSON.parse(
    fs.readFileSync(MODULE_SIGNING_KEYPAIR_PATH, "utf8"),
  );
  const signed = await signModuleArtifact(fs.readFileSync(wasmPath), {
    privateKeySeedHex: keypair.privateKeySeedHex,
    keyId: keypair.keyId ?? null,
  });
  fs.writeFileSync(wasmPath, signed.wasmBytes);
  await verifyModuleArtifact(signed.wasmBytes, {
    trustedPublicKeys: [keypair.publicKeyHex],
    requireSignature: true,
  });
  console.log(`  Signed module artifact: ${wasmPath}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("SDN Plugin Build — client-decrypt");
  console.log(`Build dir: ${BUILD_DIR}`);
  ensureLocalEmscripten();
  syncToolchainStamp();
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  fs.mkdirSync(DIST_DIR, { recursive: true });
  fs.mkdirSync(ISOMORPHIC_DIST_DIR, { recursive: true });

  const flatbuffersInclude = resolveFlatbuffersInclude();
  for (const requiredHeader of [
    "ENC_generated.h",
    "KMF_generated.h",
    "LGR_generated.h",
    "PIV_generated.h",
    "PLG_generated.h",
    "REC_generated.h",
    "TAB_generated.h",
  ]) {
    if (!fs.existsSync(path.join(CORE_SDS_GENERATED_DIR, requiredHeader))) {
      throw new Error(`Core SDS generated header not found: ${path.join(CORE_SDS_GENERATED_DIR, requiredHeader)}`);
    }
  }

  // Ensure Crypto++ sources
  const { srcDir: cryptoppSrc, parentDir: cryptoppParent } =
    await ensureCryptoppSources(path.join(BUILD_DIR, "cryptopp-src"));

  // Compile Crypto++ with Wasm exception support
  const cryptoppObjDir = path.join(BUILD_DIR, "cryptopp-obj");
  const cryptoppLib = path.join(BUILD_DIR, "libcryptopp.a");
  compileCryptoppLib(cryptoppSrc, cryptoppParent, cryptoppObjDir, cryptoppLib);

  // Manifest stub
  const manifestExportsPath = path.join(DIST_DIR, "manifest-exports.cpp");
  fs.writeFileSync(manifestExportsPath, `
#include <stddef.h>
#include <stdint.h>
static const uint8_t g_manifest[] = {0x00};
extern "C" {
__attribute__((visibility("default")))
const uint8_t* plugin_get_manifest_flatbuffer() { return g_manifest; }
__attribute__((visibility("default")))
uint32_t plugin_get_manifest_flatbuffer_size() { return 0; }
}
`);

  const srcPath = path.join(SRC_DIR, "client_decrypt.cpp");
  const outWasm = path.join(DIST_DIR, "client-decrypt.wasm");
  const emxx = path.join(EMSDK_DIR, "upstream", "emscripten", "em++");

  run(
    `${shellQuote(emxx)} -O2 -std=c++17 -fwasm-exceptions ` +
      `-DSDN_WASI_PLUGIN=1 ` +
      `-DCRYPTOPP_DISABLE_ASM=1 -DCRYPTOPP_DISABLE_SSSE3=1 -DCRYPTOPP_DISABLE_AESNI=1 ` +
      `-I${shellQuote(cryptoppParent)} -I${shellQuote(cryptoppSrc)} -I${shellQuote(CORE_SDS_GENERATED_DIR)} -I${shellQuote(flatbuffersInclude)} ` +
      `${shellQuote(srcPath)} ${shellQuote(manifestExportsPath)} ${shellQuote(cryptoppLib)} ` +
      `-sWASM=1 -sSTANDALONE_WASM=1 -sPURE_WASI=1 ` +
      `-sINITIAL_MEMORY=16777216 -sALLOW_MEMORY_GROWTH=1 ` +
      `-sFILESYSTEM=0 ` +
      `-sERROR_ON_UNDEFINED_SYMBOLS=0 ` +
      `-sEXPORTED_FUNCTIONS="['_plugin_invoke_stream','_plugin_alloc','_plugin_free','_plugin_get_manifest_flatbuffer','_plugin_get_manifest_flatbuffer_size']" ` +
      `--no-entry -o ${shellQuote(outWasm)}`,
  );

  // Refuse a declaration the emitted bytes contradict (see THREAD_MODEL above).
  assertArtifactThreadModel(outWasm, THREAD_MODEL, "licensing/client-decrypt");
  fs.copyFileSync(outWasm, path.join(ISOMORPHIC_DIST_DIR, "module.wasm"));
  await signBuiltModule(outWasm);
  await signBuiltModule(path.join(ISOMORPHIC_DIST_DIR, "module.wasm"));

  console.log(`\n✓ Build complete: ${outWasm}`);
}

main().catch((err) => {
  console.error("\nBuild failed:", err.message);
  process.exit(1);
});

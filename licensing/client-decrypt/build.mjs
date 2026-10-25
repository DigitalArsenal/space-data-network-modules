#!/usr/bin/env node
/**
 * Build the SDN client-decrypt WASM module (typed contracts 1.0) with Emscripten.
 *
 * The SDK compiler's one-source compile cannot take Crypto++, so this build drives em++ itself, as licensing/core's
 * CMake build does, and takes the SDK's typed module runtime from the pinned space-data-module-sdk:
 *  - the invoke glue generated from plugin-manifest.json (generateInvokeSupportSource): the $PIV invoke ABI with the
 *    manifest's port types checked on every input and output frame;
 *  - the $PLG manifest embedded through plugin_get_manifest_flatbuffer.
 * The SDS C++ headers are licensing/core's committed generated/sds (read only).
 *
 * Prerequisites:
 *   - Crypto++ 8.9.0 source present locally (CRYPTOPP_SOURCE_DIR, deps/cryptopp, or
 *     `node scripts/provision-emsdk.mjs --cryptopp`). This build NEVER fetches it.
 *   - FlatBuffers C++ headers matching the SDS headers (FLATBUFFERS_INCLUDE_DIR).
 *
 * Toolchain: the raw em++ lane's pinned emsdk (scripts/emsdk-pin.json), or SDN_WASM_TOOLCHAIN=system for the em++ on
 * PATH (as licensing/core's build.sh); the one used is recorded in dist/build-toolchain.json.
 *
 * Output: dist/isomorphic/module.wasm (unsigned; signing is the release's) and dist/plugin-manifest.json.
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { encodePlgManifest, legacyManifestToPlg } from "space-data-module-sdk/manifest";
import { assertArtifactThreadModel } from "../../scripts/lib/thread-model.mjs";
import {
  activateLaneToolchain,
  defaultEmsdkDir,
  recordLaneToolchain,
  resolveVendoredSource,
  REPO_ROOT as MODULES_REPO_ROOT,
} from "../../scripts/lib/emsdk-toolchain.mjs";

// THREAD MODEL - declared, never inferred (scripts/lib/thread-model.mjs): one grant is unwrapped and one bundle
// decrypted on the calling thread; no -pthread, unshared memory. assertArtifactThreadModel re-reads the emitted wasm.
const THREAD_MODEL = "single-thread";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EMSDK_DIR = path.resolve(process.env.SDN_LOCAL_EMSDK_DIR || defaultEmsdkDir(__dirname));
const EM_CACHE_DIR = path.join(__dirname, ".emcache");
const BUILD_DIR = path.join(__dirname, ".build");
const TYPED_DIR = path.join(BUILD_DIR, "typed");
const DIST_DIR = path.join(__dirname, "dist");
const ISOMORPHIC_DIST_DIR = path.join(DIST_DIR, "isomorphic");
const SRC_DIR = path.join(__dirname, "src");
const MANIFEST_PATH = path.join(__dirname, "plugin-manifest.json");
const TOOLCHAIN_STAMP_PATH = path.join(BUILD_DIR, ".emsdk-path");
const CORE_SDS_GENERATED_DIR = path.resolve(__dirname, "../core/src/cpp/generated/sds");
const SYSTEM_TOOLCHAIN = process.env.SDN_WASM_TOOLCHAIN === "system";

// em++ / emcc / emar: the pinned lane's, or the ones on PATH with SDN_WASM_TOOLCHAIN=system.
const TOOLS = SYSTEM_TOOLCHAIN
  ? { emxx: "em++", emcc: "emcc", emar: "emar" }
  : {
      emxx: path.join(EMSDK_DIR, "upstream", "emscripten", "em++"),
      emcc: path.join(EMSDK_DIR, "upstream", "emscripten", "emcc"),
      emar: path.join(EMSDK_DIR, "upstream", "emscripten", "emar"),
    };

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

function syncToolchainStamp() {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  const identity = SYSTEM_TOOLCHAIN ? `system:${runSilent("em++ --version").split("\n")[0]}` : EMSDK_DIR;
  const recorded = fs.existsSync(TOOLCHAIN_STAMP_PATH) ? fs.readFileSync(TOOLCHAIN_STAMP_PATH, "utf8").trim() : "";
  if (recorded && recorded !== identity) {
    console.log("  Toolchain changed; clearing cached Crypto++ outputs...");
    fs.rmSync(path.join(BUILD_DIR, "cryptopp-obj"), { recursive: true, force: true });
    fs.rmSync(path.join(BUILD_DIR, "libcryptopp.a"), { force: true });
  }
  fs.writeFileSync(TOOLCHAIN_STAMP_PATH, `${identity}\n`, "utf8");
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

  // NO IMPLICIT FETCH. Cloning Crypto++ during a build is the same supply-chain
  // hole as cloning the compiler was, one layer down: unreviewed upstream source
  // compiled straight into a SIGNED artifact, with nothing recording which commit
  // arrived. `resolveVendoredSource` refuses instead, naming the pin and the one
  // explicit command that provisions it.
  // Graph task: modules-raw-emcc-lane-unpinned-toolchain.
  const vendored = resolveVendoredSource("cryptopp", {
    candidates: [dir, path.join(MODULES_REPO_ROOT, "deps", "cryptopp")],
    sentinel: "aes.h",
  });
  console.log(`  Crypto++ ${vendored.version} from ${vendored.root}`);
  return setupCryptoppIncludeAlias(vendored.root);
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
  const { emcc, emar } = TOOLS;
  for (const src of sources) {
    const obj = path.join(objDir, src.replace(".cpp", ".o"));
    if (!fs.existsSync(obj)) {
      run(
        `${shellQuote(emcc)} -O2 -std=c++17 -fwasm-exceptions -sWASM_LEGACY_EXCEPTIONS=0 ` +
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

// ── FlatBuffers C++ headers (the version licensing/core's SDS headers were generated for) ────────────────

function resolveFlatbuffersInclude() {
  const explicit = process.env.FLATBUFFERS_INCLUDE_DIR;
  if (explicit && fs.existsSync(path.join(explicit, "flatbuffers", "base.h"))) {
    console.log(`  Using FlatBuffers headers: ${explicit}`);
    return explicit;
  }
  const stackFlatbuffersInclude = path.resolve(__dirname, "../../../flatbuffers/include");
  if (fs.existsSync(path.join(stackFlatbuffersInclude, "flatbuffers", "base.h"))) {
    console.log(`  Using stack FlatBuffers headers: ${stackFlatbuffersInclude}`);
    return stackFlatbuffersInclude;
  }
  throw new Error("FlatBuffers C++ headers not found. Set FLATBUFFERS_INCLUDE_DIR=/path/to/include");
}

// ── The SDK's typed module runtime, staged for this build (as licensing/core/generate-typed-runtime.mjs) ──────

async function stageTypedRuntime(manifest) {
  const sdkRoot = fs.realpathSync(path.join(__dirname, "node_modules", "space-data-module-sdk"));
  const { generateInvokeSupportHeader, generateInvokeSupportSource } = await import(
    pathToFileURL(path.join(sdkRoot, "src", "compiler", "invokeGlue.js")).href
  );
  const { getInvokeCppSchemaHeaders } = await import(
    pathToFileURL(path.join(sdkRoot, "src", "compiler", "flatcSupport.js")).href
  );
  // The generated headers pin the flatc version they came from; the pin is relaxed as the SDK does for its runtime.
  const relax = (source) => source.replace(/static_assert\(FLATBUFFERS_VERSION_MAJOR[\s\S]*?\);\n/, "");
  const write = (relative, content) => {
    const target = path.join(TYPED_DIR, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  fs.rmSync(TYPED_DIR, { recursive: true, force: true });
  write("space_data_module_invoke.h", generateInvokeSupportHeader());
  write("plugin_invoke_glue.cpp", generateInvokeSupportSource({ manifest, includeCommandMain: true }));
  for (const [relative, content] of Object.entries(await getInvokeCppSchemaHeaders())) write(relative, relax(content));

  // The embedded $PLG manifest (plugin_get_manifest_flatbuffer).
  const bytes = encodePlgManifest(legacyManifestToPlg(manifest));
  if (new TextDecoder().decode(bytes.slice(4, 8)) !== "$PLG") throw new Error("Embedded manifest is not a $PLG buffer");
  write(
    "plugin_manifest_bytes.h",
    `#ifndef CLIENT_DECRYPT_PLUGIN_MANIFEST_BYTES_H\n#define CLIENT_DECRYPT_PLUGIN_MANIFEST_BYTES_H\n#include <cstdint>\n` +
      `static const unsigned char client_decrypt_plugin_manifest_bytes[] = {${Array.from(bytes).join(",")}};\n` +
      `static const uint32_t client_decrypt_plugin_manifest_bytes_len = ${bytes.length}u;\n#endif\n`,
  );
  console.log(`  Staged the SDK typed runtime (${path.basename(sdkRoot)}) and a ${bytes.length}-byte $PLG manifest`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("SDN Plugin Build — client-decrypt");
  const laneToolchain = SYSTEM_TOOLCHAIN
    ? null
    : activateLaneToolchain({ moduleDir: "licensing/client-decrypt", extraCandidates: [EMSDK_DIR], emCache: EM_CACHE_DIR });
  if (SYSTEM_TOOLCHAIN) {
    fs.mkdirSync(EM_CACHE_DIR, { recursive: true });
    process.env.EM_CACHE = process.env.EM_CACHE || EM_CACHE_DIR;
  }
  syncToolchainStamp();
  fs.rmSync(DIST_DIR, { recursive: true, force: true });
  fs.mkdirSync(ISOMORPHIC_DIST_DIR, { recursive: true });

  const flatbuffersInclude = resolveFlatbuffersInclude();
  for (const requiredHeader of ["ENC_generated.h", "FIL_generated.h", "KMF_generated.h", "LGR_generated.h", "REC_generated.h"]) {
    if (!fs.existsSync(path.join(CORE_SDS_GENERATED_DIR, requiredHeader))) {
      throw new Error(`Core SDS generated header not found: ${path.join(CORE_SDS_GENERATED_DIR, requiredHeader)}`);
    }
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  await stageTypedRuntime(manifest);

  const { srcDir: cryptoppSrc, parentDir: cryptoppParent } = await ensureCryptoppSources(path.join(BUILD_DIR, "cryptopp-src"));
  const cryptoppLib = path.join(BUILD_DIR, "libcryptopp.a");
  compileCryptoppLib(cryptoppSrc, cryptoppParent, path.join(BUILD_DIR, "cryptopp-obj"), cryptoppLib);

  const outWasm = path.join(ISOMORPHIC_DIST_DIR, "module.wasm");
  const includes = [cryptoppParent, cryptoppSrc, TYPED_DIR, CORE_SDS_GENERATED_DIR, flatbuffersInclude]
    .map((dir) => `-I${shellQuote(dir)}`)
    .join(" ");
  const units = [
    path.join(SRC_DIR, "client_decrypt.cpp"),
    path.join(TYPED_DIR, "plugin_invoke_glue.cpp"),
  ];
  run(
    `${shellQuote(TOOLS.emxx)} -O2 -std=c++17 -fwasm-exceptions -sWASM_LEGACY_EXCEPTIONS=0 ` +
      `-DCRYPTOPP_DISABLE_ASM=1 -DCRYPTOPP_DISABLE_SSSE3=1 -DCRYPTOPP_DISABLE_AESNI=1 ` +
      `${includes} ${units.map(shellQuote).join(" ")} ${shellQuote(cryptoppLib)} ` +
      `-sSTANDALONE_WASM=1 -sPURE_WASI=1 -sINITIAL_MEMORY=16777216 -sALLOW_MEMORY_GROWTH=1 -sFILESYSTEM=0 ` +
      `-sERROR_ON_UNDEFINED_SYMBOLS=0 -Wl,--allow-undefined ` +
      `-sEXPORTED_FUNCTIONS="['_plugin_alloc','_plugin_free','_plugin_invoke_stream','_plugin_get_manifest_flatbuffer','_plugin_get_manifest_flatbuffer_size','__initialize']" ` +
      `-o ${shellQuote(outWasm)}`,
  );

  assertArtifactThreadModel(outWasm, THREAD_MODEL, "licensing/client-decrypt");
  if (laneToolchain) {
    recordLaneToolchain(DIST_DIR, laneToolchain);
  } else {
    fs.writeFileSync(
      path.join(DIST_DIR, "build-toolchain.json"),
      `${JSON.stringify({ lane: "system-em++", emscripten: runSilent("em++ --version").split("\n")[0] }, null, 2)}\n`,
    );
  }
  fs.copyFileSync(MANIFEST_PATH, path.join(DIST_DIR, "plugin-manifest.json"));
  const wasm = fs.readFileSync(outWasm);
  console.log(`\n✓ Build complete: ${outWasm} (${wasm.length} bytes, sha256 ${createHash("sha256").update(wasm).digest("hex")})`);
}

main().catch((err) => {
  console.error("\nBuild failed:", err.message);
  process.exit(1);
});

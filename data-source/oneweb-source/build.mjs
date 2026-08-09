#!/usr/bin/env node
/**
 * Build the OneWeb (Eutelsat) LTEF data-source WASM module using a repo-local
 * emsdk toolchain. Mirrors data-source/spacex-starlink-source/build.mjs (the
 * A2.2b template); only the source file, output name, and manifest differ. The
 * shared provider scaffold is common/provider_source.hpp (promoted in A2.2c),
 * resolved via the SDN_COMMON_DIR (-I common) include path.
 *
 * Usage: SDN_LOCAL_EMSDK_DIR=<repo>/licensing/core/deps/emsdk node build.mjs
 * Output: dist/oneweb-source.wasm (signed), dist/isomorphic/module.wasm (loadable)
 */

import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signModuleArtifact, verifyModuleArtifact } from "space-data-module-sdk/bundle";
import { encodePlgManifest, legacyManifestToPlg } from "space-data-module-sdk/manifest";
import createOnewebSourcePluginManifest from "./manifest.js";
import { assertArtifactThreadModel } from "../../scripts/lib/thread-model.mjs";
import { activateLaneToolchain, recordLaneToolchain } from "../../scripts/lib/emsdk-toolchain.mjs";

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
// Truth of the SHIPPED artifact 37aac5cd1e56…: unshared linear memory, no
// `wasi.thread-spawn` import, no `wasi_thread_start` export.
//
// `assertArtifactThreadModel` re-reads the EMITTED wasm at the end of this build
// and refuses the declaration if the bytes ever contradict it. A declaration
// nothing verifies is a comment.
const THREAD_MODEL = "single-thread";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EMSDK_DIR = path.resolve(process.env.SDN_LOCAL_EMSDK_DIR || path.join(__dirname, "deps", "emsdk"));
const EM_CACHE_DIR = path.join(__dirname, ".emcache");
const BUILD_DIR = path.join(__dirname, ".build");
const DIST_DIR = path.join(__dirname, "dist");
const ISOMORPHIC_DIST_DIR = path.join(DIST_DIR, "isomorphic");
const SRC_DIR = path.join(__dirname, "src");
const CORE_SDS_GENERATED_DIR = path.resolve(__dirname, "../../licensing/core/src/cpp/generated/sds");
const SDN_COMMON_DIR = path.resolve(__dirname, "../../common");
const SDM_HOST_CPP_DIR = path.resolve(__dirname, "../../node_modules/space-data-module-sdk/src/host/cpp");
const MODULE_SIGNING_KEYPAIR_PATH =
  process.env.SDN_MODULE_SIGNING_KEYPAIR ||
  path.resolve(__dirname, "../../../../ancillary-packages/space-data-module-sdk/test/support/dev-module-signing-keypair.json");

function run(cmd, opts = {}) {
  console.log(`  $ ${cmd}`);
  execSync(cmd, { stdio: "inherit", ...opts });
}
function runSilent(cmd, opts = {}) {
  return execSync(cmd, { encoding: "utf8", ...opts });
}
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function resolveFlatbuffersInclude() {
  const explicit = process.env.FLATBUFFERS_INCLUDE_DIR;
  if (explicit && fs.existsSync(path.join(explicit, "flatbuffers", "base.h"))) return explicit;
  const stackInc = path.resolve(__dirname, "../../../flatbuffers/include");
  if (fs.existsSync(path.join(stackInc, "flatbuffers", "base.h"))) return stackInc;
  try {
    const brewInc = path.join(runSilent("brew --prefix flatbuffers 2>/dev/null", {}).trim(), "include");
    if (fs.existsSync(path.join(brewInc, "flatbuffers", "base.h"))) return brewInc;
  } catch {}
  throw new Error("FlatBuffers C++ headers not found. Set FLATBUFFERS_INCLUDE_DIR=/path/to/include");
}

async function signBuiltModule(wasmPath) {
  if (!fs.existsSync(MODULE_SIGNING_KEYPAIR_PATH)) {
    throw new Error(`Module signing keypair not found: ${MODULE_SIGNING_KEYPAIR_PATH}`);
  }
  const keypair = JSON.parse(fs.readFileSync(MODULE_SIGNING_KEYPAIR_PATH, "utf8"));
  const signed = await signModuleArtifact(fs.readFileSync(wasmPath), {
    privateKeySeedHex: keypair.privateKeySeedHex,
    keyId: keypair.keyId ?? null,
  });
  fs.writeFileSync(wasmPath, signed.wasmBytes);
  await verifyModuleArtifact(signed.wasmBytes, { trustedPublicKeys: [keypair.publicKeyHex], requireSignature: true });
  console.log(`  Signed module artifact: ${wasmPath}`);
}

async function main() {
  console.log("SDN Plugin Build — oneweb-source");
  const laneToolchain = activateLaneToolchain({
    moduleDir: "data-source/oneweb-source",
    extraCandidates: [EMSDK_DIR],
    emCache: EM_CACHE_DIR,
  });
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  fs.mkdirSync(DIST_DIR, { recursive: true });
  fs.mkdirSync(ISOMORPHIC_DIST_DIR, { recursive: true });

  const flatbuffersInclude = resolveFlatbuffersInclude();

  const manifestBytes = encodePlgManifest(legacyManifestToPlg(createOnewebSourcePluginManifest()));
  const manifestIdentifier = new TextDecoder().decode(manifestBytes.slice(4, 8));
  if (manifestIdentifier !== "$PLG") {
    throw new Error(`Embedded manifest is not a $PLG buffer (identifier: ${JSON.stringify(manifestIdentifier)})`);
  }
  const byteList = Array.from(manifestBytes)
    .map((b) => "0x" + b.toString(16).padStart(2, "0"))
    .join(",");
  const manifestExportsPath = path.join(DIST_DIR, "manifest-exports.cpp");
  fs.writeFileSync(
    manifestExportsPath,
    `#include <stddef.h>
#include <stdint.h>
static const uint8_t g_manifest[] = {${byteList}};
extern "C" {
__attribute__((visibility("default"))) const uint8_t* plugin_get_manifest_flatbuffer() { return g_manifest; }
__attribute__((visibility("default"))) uint32_t plugin_get_manifest_flatbuffer_size() { return ${manifestBytes.length}; }
}
`,
  );
  console.log(`  Embedded manifest: ${manifestBytes.length} bytes`);

  const srcPath = path.join(SRC_DIR, "oneweb_source.cpp");
  const outWasm = path.join(DIST_DIR, "oneweb-source.wasm");
  const emxx = path.join(EMSDK_DIR, "upstream", "emscripten", "em++");

  if (!fs.existsSync(path.join(SDN_COMMON_DIR, "provider_source.hpp"))) {
    throw new Error(`provider_source.hpp not found under ${SDN_COMMON_DIR} (A2.2c promotion)`);
  }
  if (!fs.existsSync(path.join(SDN_COMMON_DIR, "sdm_hostcall_wire.hpp"))) {
    throw new Error(`sdm_hostcall_wire.hpp not found under ${SDN_COMMON_DIR}`);
  }
  if (!fs.existsSync(path.join(SDM_HOST_CPP_DIR, "keyslotClient.hpp"))) {
    throw new Error(
      `keyslotClient.hpp not found under ${SDM_HOST_CPP_DIR} (expected the space-data-module-sdk node_modules symlink at the workspace root)`,
    );
  }

  const includes = [`-I${shellQuote(flatbuffersInclude)}`, `-I${shellQuote(SDN_COMMON_DIR)}`, `-I${shellQuote(SDM_HOST_CPP_DIR)}`];
  if (fs.existsSync(CORE_SDS_GENERATED_DIR)) includes.push(`-I${shellQuote(CORE_SDS_GENERATED_DIR)}`);

  run(
    `${shellQuote(emxx)} -O2 -std=c++17 -fwasm-exceptions -sWASM_LEGACY_EXCEPTIONS=0 -DSDN_WASI_PLUGIN=1 ` +
      `${includes.join(" ")} ` +
      `${shellQuote(srcPath)} ${shellQuote(manifestExportsPath)} ` +
      `-sWASM=1 -sSTANDALONE_WASM=1 -sPURE_WASI=1 -sINITIAL_MEMORY=16777216 -sALLOW_MEMORY_GROWTH=1 ` +
      `-sFILESYSTEM=0 -sERROR_ON_UNDEFINED_SYMBOLS=0 ` +
      `-sEXPORTED_FUNCTIONS="['_plugin_invoke_stream','_plugin_alloc','_plugin_free','_plugin_get_manifest_flatbuffer','_plugin_get_manifest_flatbuffer_size']" ` +
      `--no-entry -o ${shellQuote(outWasm)}`,
  );

  // Refuse a declaration the emitted bytes contradict (see THREAD_MODEL above).
  assertArtifactThreadModel(outWasm, THREAD_MODEL, "data-source/oneweb-source");
  recordLaneToolchain(DIST_DIR, laneToolchain);
  fs.copyFileSync(outWasm, path.join(ISOMORPHIC_DIST_DIR, "module.wasm"));
  await signBuiltModule(outWasm);
  console.log(`  Runtime artifact (loadable, unsigned): ${path.join(ISOMORPHIC_DIST_DIR, "module.wasm")}`);
  console.log(`\n✓ Build complete: ${outWasm}`);
}

main().catch((err) => {
  console.error("\nBuild failed:", err.message);
  process.exit(1);
});

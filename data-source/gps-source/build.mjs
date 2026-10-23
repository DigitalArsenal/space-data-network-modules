#!/usr/bin/env node
/**
 * Build the GPS almanac (NAVCEN SEM/YUMA) data-source WASM module with the clang
 * wasm32-wasip1-threads toolchain (wasi-sequential). Mirrors data-source/spacex-starlink-source/build.mjs (the
 * A2.2b template); only the source file, output name, and manifest differ. The
 * shared provider scaffold is common/provider_source.hpp (promoted in A2.2c),
 * resolved via the SDN_COMMON_DIR (-I common) include path.
 *
 * Usage: node build.mjs (the SDK's resolveWasiThreadsToolchain finds wasm32-wasi-clang++ and the threads sysroot;
 *        SDN_WASI_CLANGXX / SDN_WASI_SYSROOT / SDN_WASI_RESOURCE_DIR override)
 * Output: dist/gps-source.wasm (signed), dist/isomorphic/module.wasm (loadable)
 *
 * Environment:
 *   FLATBUFFERS_INCLUDE_DIR  — path to flatbuffers C++ headers (optional override)
 *   SDN_MODULE_SIGNING_KEYPAIR — dev module signing keypair path override
 */

import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signModuleArtifact, verifyModuleArtifact } from "space-data-module-sdk/bundle";
import { encodePlgManifest, legacyManifestToPlg } from "space-data-module-sdk/manifest";
import createGpsSourcePluginManifest from "./manifest.js";
import { assertArtifactThreadModel } from "../../scripts/lib/thread-model.mjs";
import { resolveWasiThreadsToolchain } from "space-data-module-sdk/compiler";

// THREAD MODEL — declared, never inferred (scripts/lib/thread-model.mjs).
//
// This build does NOT go through the SDK compiler — it drives the clang wasm32-wasip1-threads
// toolchain directly (the SDK's resolveWasiThreadsToolchain) — so the declaration lives here as a
// literal. wasi-sequential: the repo's one guest object format; the guest never spawns a thread
// (each invocation turns one frame into the next request or the parsed records on the calling
// thread), so the artifact carries the shared memory of that target and no wasi.thread-spawn import.
// The source throws nothing and is compiled with -fno-exceptions.
//
// `assertArtifactThreadModel` re-reads the EMITTED wasm at the end of this build
// and refuses the declaration if the bytes ever contradict it.
const THREAD_MODEL = "wasi-sequential";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = path.join(__dirname, ".build");
const DIST_DIR = path.join(__dirname, "dist");
const ISOMORPHIC_DIST_DIR = path.join(DIST_DIR, "isomorphic");
const SRC_DIR = path.join(__dirname, "src");
const CORE_SDS_GENERATED_DIR = path.resolve(__dirname, "../../licensing/core/src/cpp/generated/sds");
// common/provider_source.hpp + common/sdm_hostcall_wire.hpp (shared module-side
// scaffold + hostcall wire format) and the SDK's keyslotClient.hpp
// (sdm_keyslot::keyslot_sign — the keyslot.sign host-side crypto oracle client).
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
  console.log("SDN Plugin Build — gps-source");
  const toolchain = resolveWasiThreadsToolchain();
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  fs.mkdirSync(DIST_DIR, { recursive: true });
  fs.mkdirSync(ISOMORPHIC_DIST_DIR, { recursive: true });

  const flatbuffersInclude = resolveFlatbuffersInclude();

  const manifestBytes = encodePlgManifest(legacyManifestToPlg(createGpsSourcePluginManifest()));
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

  const srcPath = path.join(SRC_DIR, "gps_source.cpp");
  const outWasm = path.join(DIST_DIR, "gps-source.wasm");

  if (!fs.existsSync(path.join(SDN_COMMON_DIR, "provider_source.hpp"))) {
    throw new Error(`provider_source.hpp not found under ${SDN_COMMON_DIR} (A2.2c promotion)`);
  }
  if (!fs.existsSync(path.join(SDN_COMMON_DIR, "sdm_hostcall_wire.hpp"))) {
    throw new Error(`sdm_hostcall_wire.hpp not found under ${SDN_COMMON_DIR}`);
  }
  if (!fs.existsSync(path.join(SDN_COMMON_DIR, "gps_time.hpp"))) {
    throw new Error(`gps_time.hpp not found under ${SDN_COMMON_DIR} (A2.2c-2 promotion)`);
  }
  if (!fs.existsSync(path.join(SDM_HOST_CPP_DIR, "keyslotClient.hpp"))) {
    throw new Error(
      `keyslotClient.hpp not found under ${SDM_HOST_CPP_DIR} (expected the space-data-module-sdk node_modules symlink at the workspace root)`,
    );
  }

  const includes = [`-I${shellQuote(flatbuffersInclude)}`, `-I${shellQuote(SDN_COMMON_DIR)}`, `-I${shellQuote(SDM_HOST_CPP_DIR)}`];
  if (fs.existsSync(CORE_SDS_GENERATED_DIR)) includes.push(`-I${shellQuote(CORE_SDS_GENERATED_DIR)}`);

  run(
    `${shellQuote(toolchain.clangxx)} ${toolchain.toolchainArgs.map(shellQuote).join(" ")} ` +
      `-O2 -std=c++17 -fno-exceptions -mbulk-memory -mexec-model=reactor -DSDN_WASI_PLUGIN=1 ` +
      `${includes.join(" ")} ` +
      `${shellQuote(srcPath)} ${shellQuote(manifestExportsPath)} ` +
      `-Wl,--initial-memory=16777216 -Wl,--max-memory=2147483648 -Wl,--allow-undefined ` +
      ["plugin_invoke_stream", "plugin_alloc", "plugin_free", "plugin_get_manifest_flatbuffer", "plugin_get_manifest_flatbuffer_size"]
        .map((name) => `-Wl,--export=${name}`).join(" ") +
      ` -o ${shellQuote(outWasm)}`,
  );

  // Refuse a declaration the emitted bytes contradict (see THREAD_MODEL above).
  assertArtifactThreadModel(outWasm, THREAD_MODEL, "data-source/gps-source");
  fs.copyFileSync(outWasm, path.join(ISOMORPHIC_DIST_DIR, "module.wasm"));
  await signBuiltModule(outWasm);
  console.log(`  Runtime artifact (loadable, unsigned): ${path.join(ISOMORPHIC_DIST_DIR, "module.wasm")}`);
  console.log(`\n✓ Build complete: ${outWasm}`);
}

main().catch((err) => {
  console.error("\nBuild failed:", err.message);
  process.exit(1);
});

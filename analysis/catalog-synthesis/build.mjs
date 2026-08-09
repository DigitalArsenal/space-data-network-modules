#!/usr/bin/env node
/**
 * Build the Supplemental Catalog Synthesis WASM module (App 2, A2.7) with a
 * repo-local emsdk.
 *
 * Unlike the OD fit pipeline this module does NO orbit math — it only reads,
 * merges, and re-publishes OMM records — so it compiles just:
 *   src/catalog_synthesis.cpp        (orchestration + precedence)
 *   src/omm_reader.hpp               (encoding-agnostic OMM reader, header-only)
 *   dist/manifest-exports.cpp        (generated: embedded $PLG manifest)
 *   dist/gate-status-embed.cpp       (generated: embedded config/provider-gate-status.json)
 * against common/provider_source.hpp (storage.ingest_with_source / keyslot.sign /
 * pubsub.publish), the SDK keyslot client, and the SDS OMM FlatBuffer reader
 * (licensing/core generated bindings + the repo-vendored flatbuffers headers).
 *
 * Usage: node build.mjs
 * Output: dist/catalog-synthesis.wasm (signed), dist/isomorphic/module.wasm (loadable)
 *
 * Environment:
 *   SDN_LOCAL_EMSDK_DIR          — repo-local emsdk root override
 *   SDN_FLATBUFFERS_INCLUDE_DIR  — flatbuffers headers dir override (has flatbuffers/flatbuffers.h)
 *   SDN_MODULE_SIGNING_KEYPAIR   — dev module signing keypair path override
 */
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signModuleArtifact, verifyModuleArtifact } from "space-data-module-sdk/bundle";
import { encodePlgManifest, legacyManifestToPlg } from "space-data-module-sdk/manifest";
import createCatalogSynthesisPluginManifest from "./manifest.js";
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
// Truth of the SHIPPED artifact 20271803dfef…: unshared linear memory, no
// `wasi.thread-spawn` import, no `wasi_thread_start` export.
//
// `assertArtifactThreadModel` re-reads the EMITTED wasm at the end of this build
// and refuses the declaration if the bytes ever contradict it. A declaration
// nothing verifies is a comment.
const THREAD_MODEL = "single-thread";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");              // space-data-network-modules
const MAIN_PACKAGES_ROOT = path.resolve(REPO_ROOT, "..");        // repos/main-packages
const EMSDK_DIR = path.resolve(
  process.env.SDN_LOCAL_EMSDK_DIR ||
    (fs.existsSync(path.join(__dirname, "deps", "emsdk", "emsdk_env.sh"))
      ? path.join(__dirname, "deps", "emsdk")
      : path.join(REPO_ROOT, "licensing", "core", "deps", "emsdk")),
);
const EM_CACHE_DIR = path.join(__dirname, ".emcache");
const BUILD_DIR = path.join(__dirname, ".build");
const DIST_DIR = path.join(__dirname, "dist");
const ISOMORPHIC_DIST_DIR = path.join(DIST_DIR, "isomorphic");
const SRC_DIR = path.join(__dirname, "src");
const CONFIG_DIR = path.join(__dirname, "config");

const SDN_COMMON_DIR = path.join(REPO_ROOT, "common");
const SDM_HOST_CPP_DIR = path.join(REPO_ROOT, "node_modules", "space-data-module-sdk", "src", "host", "cpp");
// SDS OMM FlatBuffer bindings: -I the parent of sds/ so `#include "sds/OMM_generated.h"` resolves.
const SDS_GENERATED_DIR = path.join(REPO_ROOT, "licensing", "core", "src", "cpp", "generated");
const FLATBUFFERS_INCLUDE_DIR = path.resolve(
  process.env.SDN_FLATBUFFERS_INCLUDE_DIR ||
    path.join(MAIN_PACKAGES_ROOT, "flatbuffers", "include"),
);

const MODULE_SIGNING_KEYPAIR_PATH =
  process.env.SDN_MODULE_SIGNING_KEYPAIR ||
  path.resolve(REPO_ROOT, "../../ancillary-packages/space-data-module-sdk/test/support/dev-module-signing-keypair.json");

function run(cmd, opts = {}) {
  console.log(`  $ ${cmd}`);
  execSync(cmd, { stdio: "inherit", ...opts });
}
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function activateLocalEmsdk() {
  const envScript = path.join(EMSDK_DIR, "emsdk_env.sh");
  const sourcedEnv = execFileSync("bash", ["-lc", `source ${shellQuote(envScript)} >/dev/null 2>&1 && env -0`], {
    encoding: "buffer",
    env: { ...process.env, EM_CACHE: process.env.EM_CACHE || EM_CACHE_DIR },
  });
  for (const entry of sourcedEnv.toString("utf8").split("\0")) {
    if (!entry) continue;
    const sep = entry.indexOf("=");
    if (sep <= 0) continue;
    process.env[entry.slice(0, sep)] = entry.slice(sep + 1);
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
    run("./emsdk install 6.0.1", { cwd: EMSDK_DIR });
    run("./emsdk activate 6.0.1", { cwd: EMSDK_DIR });
  }
  activateLocalEmsdk();
}

// Embed config/provider-gate-status.json as a compiled default. The _comment
// block is stripped (documentation only); the module reads providers /
// spacetrackSourceNames / defaultLevelForUnlistedProvider.
function writeGateEmbed() {
  const raw = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, "provider-gate-status.json"), "utf8"));
  delete raw._comment;
  const json = JSON.stringify(raw);
  const bytes = Array.from(Buffer.from(json, "utf8"));
  bytes.push(0); // NUL terminator
  const byteList = bytes.map((b) => "0x" + b.toString(16).padStart(2, "0")).join(",");
  const outPath = path.join(DIST_DIR, "gate-status-embed.cpp");
  fs.writeFileSync(
    outPath,
    `#include <stdint.h>
static const char g_gate_status[] = {${byteList}};
extern "C" __attribute__((visibility("default"))) const char* catalog_gate_status_default_json() { return g_gate_status; }
`,
  );
  console.log(`  Embedded gate status: ${json.length} bytes`);
  return outPath;
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
  console.log("SDN Plugin Build — catalog-synthesis");
  ensureLocalEmscripten();
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  fs.mkdirSync(DIST_DIR, { recursive: true });
  fs.mkdirSync(ISOMORPHIC_DIST_DIR, { recursive: true });

  // Embed the real manifest (methods + host caps + TIMERS) via the SDK $PLG encoder.
  const manifestBytes = encodePlgManifest(legacyManifestToPlg(createCatalogSynthesisPluginManifest()));
  const manifestIdentifier = new TextDecoder().decode(manifestBytes.slice(4, 8));
  if (manifestIdentifier !== "$PLG") {
    throw new Error(`Embedded manifest is not a $PLG buffer (identifier: ${JSON.stringify(manifestIdentifier)})`);
  }
  const byteList = Array.from(manifestBytes).map((b) => "0x" + b.toString(16).padStart(2, "0")).join(",");
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

  const gateEmbedPath = writeGateEmbed();

  // Preflight the include roots so a missing dep fails loud, not mid-compile.
  for (const [label, p] of [
    ["sdm_hostcall_wire.hpp", path.join(SDN_COMMON_DIR, "sdm_hostcall_wire.hpp")],
    ["provider_source.hpp", path.join(SDN_COMMON_DIR, "provider_source.hpp")],
    ["keyslotClient.hpp", path.join(SDM_HOST_CPP_DIR, "keyslotClient.hpp")],
    ["sds/OMM_generated.h", path.join(SDS_GENERATED_DIR, "sds", "OMM_generated.h")],
    ["flatbuffers/flatbuffers.h", path.join(FLATBUFFERS_INCLUDE_DIR, "flatbuffers", "flatbuffers.h")],
  ]) {
    if (!fs.existsSync(p)) throw new Error(`required header not found (${label}): ${p}`);
  }

  const srcPath = path.join(SRC_DIR, "catalog_synthesis.cpp");
  const outWasm = path.join(DIST_DIR, "catalog-synthesis.wasm");
  const emxx = path.join(EMSDK_DIR, "upstream", "emscripten", "em++");

  const includes = [
    `-I${shellQuote(SDN_COMMON_DIR)}`,
    `-I${shellQuote(SDM_HOST_CPP_DIR)}`,
    `-I${shellQuote(SDS_GENERATED_DIR)}`,
    `-I${shellQuote(FLATBUFFERS_INCLUDE_DIR)}`,
    `-I${shellQuote(SRC_DIR)}`,
  ];
  const sources = [srcPath, manifestExportsPath, gateEmbedPath].map(shellQuote).join(" ");

  // PURE_WASI standalone + host-import tolerance (like the adapters / fit-pipeline).
  run(
    `${shellQuote(emxx)} -O3 -std=c++17 -fwasm-exceptions -sWASM_LEGACY_EXCEPTIONS=0 ` +
      `-DSDN_WASI_PLUGIN=1 -DNDEBUG ` +
      `${includes.join(" ")} ${sources} ` +
      `-sWASM=1 -sSTANDALONE_WASM=1 -sPURE_WASI=1 -sINITIAL_MEMORY=67108864 -sALLOW_MEMORY_GROWTH=1 ` +
      `-sFILESYSTEM=0 -sERROR_ON_UNDEFINED_SYMBOLS=0 ` +
      `-sEXPORTED_FUNCTIONS="['_plugin_invoke_stream','_plugin_alloc','_plugin_free','_plugin_get_manifest_flatbuffer','_plugin_get_manifest_flatbuffer_size']" ` +
      `--no-entry -o ${shellQuote(outWasm)}`,
  );

  // dist/isomorphic/module.wasm is the loadable (unsigned) runtime artifact.
  // Refuse a declaration the emitted bytes contradict (see THREAD_MODEL above).
  assertArtifactThreadModel(outWasm, THREAD_MODEL, "analysis/catalog-synthesis");
  fs.copyFileSync(outWasm, path.join(ISOMORPHIC_DIST_DIR, "module.wasm"));
  await signBuiltModule(outWasm);
  console.log(`  Runtime artifact (loadable, unsigned): ${path.join(ISOMORPHIC_DIST_DIR, "module.wasm")}`);
  console.log(`\n✓ Build complete: ${outWasm}`);
}

main().catch((err) => {
  console.error("\nBuild failed:", err.message);
  process.exit(1);
});

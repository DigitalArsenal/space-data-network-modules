#!/usr/bin/env node
/**
 * Build the OD Fit Pipeline WASM module (App 2, A2.3) with a repo-local emsdk.
 *
 * It compiles the pipeline orchestration (src/fit_pipeline.cpp) together with the
 * EXISTING OD fit library sources — reused, not forked — so the fit is
 * byte-for-byte the same code the OD `fit` module runs:
 *   ../src/cpp/src/sgp4_fitter.cpp   (od::fit_sgp4_series, elements_to_json)
 *   ../src/cpp/src/meme_parser.cpp   (od::iso_to_jd, EphemerisPoint, jd<->iso)
 *   ../src/cpp/src/frame_transform.cpp (od::eci_j2000_to_teme)
 *   ../src/cpp/deps/vallado-sgp4/SGP4.cpp (Vallado SGP4 propagator)
 * plus the host-capability skeleton from common/provider_source.hpp
 * (storage.write / keyslot.sign / pubsub.publish) and the SDK keyslot client.
 *
 * Usage: node build.mjs
 * Output: dist/od-fit-pipeline.wasm (signed), dist/isomorphic/module.wasm (loadable)
 *
 * Environment:
 *   SDN_LOCAL_EMSDK_DIR         — repo-local emsdk root override
 *   SDN_EIGEN_INCLUDE_DIR       — Eigen headers dir override (has Eigen/Dense)
 *   SDN_MODULE_SIGNING_KEYPAIR  — dev module signing keypair path override
 */
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signModuleArtifact, verifyModuleArtifact } from "space-data-module-sdk/bundle";
import { encodePlgManifest, legacyManifestToPlg } from "space-data-module-sdk/manifest";
import createOdFitPipelinePluginManifest from "./manifest.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");           // space-data-network-modules
const OD_SRC = path.resolve(__dirname, "../src/cpp");            // analysis/od/src/cpp
const EMSDK_DIR = path.resolve(
  process.env.SDN_LOCAL_EMSDK_DIR ||
    (fs.existsSync(path.join(__dirname, "..", "deps", "emsdk", "emsdk_env.sh"))
      ? path.join(__dirname, "..", "deps", "emsdk")
      : path.join(REPO_ROOT, "licensing", "core", "deps", "emsdk")),
);
const EM_CACHE_DIR = path.join(__dirname, ".emcache");
const BUILD_DIR = path.join(__dirname, ".build");
const DIST_DIR = path.join(__dirname, "dist");
const ISOMORPHIC_DIST_DIR = path.join(DIST_DIR, "isomorphic");
const SRC_DIR = path.join(__dirname, "src");

const SDN_COMMON_DIR = path.join(REPO_ROOT, "common");
const SDM_HOST_CPP_DIR = path.join(REPO_ROOT, "node_modules", "space-data-module-sdk", "src", "host", "cpp");
const OD_INCLUDE_DIR = path.join(OD_SRC, "include");
const VALLADO_DIR = path.join(OD_SRC, "deps", "vallado-sgp4");

const MODULE_SIGNING_KEYPAIR_PATH =
  process.env.SDN_MODULE_SIGNING_KEYPAIR ||
  path.resolve(REPO_ROOT, "../../ancillary-packages/space-data-module-sdk/test/support/dev-module-signing-keypair.json");

// OD fit library sources reused verbatim (no orbit_determination.cpp / no
// oem_parser.cpp — the pipeline consumes JSON OEM records, not KVN, and does not
// use the IOD path, which keeps <iostream> out of the PURE_WASI link).
const OD_LIB_SOURCES = [
  path.join(OD_SRC, "src", "sgp4_fitter.cpp"),
  path.join(OD_SRC, "src", "meme_parser.cpp"),
  path.join(OD_SRC, "src", "frame_transform.cpp"),
  path.join(VALLADO_DIR, "SGP4.cpp"),
];

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

function resolveEigenInclude() {
  const candidates = [
    process.env.SDN_EIGEN_INCLUDE_DIR,
    "/opt/homebrew/include/eigen3",
    "/opt/homebrew/opt/eigen/include/eigen3",
    "/usr/local/include/eigen3",
    "/usr/local/opt/eigen/include/eigen3",
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "Eigen", "Dense"))) return dir;
  }
  throw new Error("Eigen headers not found. Set SDN_EIGEN_INCLUDE_DIR=/path/to/eigen3 (must contain Eigen/Dense).");
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
  console.log("SDN Plugin Build — od-fit-pipeline");
  ensureLocalEmscripten();
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  fs.mkdirSync(DIST_DIR, { recursive: true });
  fs.mkdirSync(ISOMORPHIC_DIST_DIR, { recursive: true });

  const eigenInclude = resolveEigenInclude();

  // Embed the real manifest (methods + host caps + TIMERS) via the SDK $PLG encoder.
  const manifestBytes = encodePlgManifest(legacyManifestToPlg(createOdFitPipelinePluginManifest()));
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

  if (!fs.existsSync(path.join(SDN_COMMON_DIR, "sdm_hostcall_wire.hpp"))) {
    throw new Error(`sdm_hostcall_wire.hpp not found under ${SDN_COMMON_DIR}`);
  }
  if (!fs.existsSync(path.join(SDM_HOST_CPP_DIR, "keyslotClient.hpp"))) {
    throw new Error(`keyslotClient.hpp not found under ${SDM_HOST_CPP_DIR} (expected the space-data-module-sdk node_modules symlink at the workspace root)`);
  }
  for (const src of OD_LIB_SOURCES) {
    if (!fs.existsSync(src)) throw new Error(`reused OD source missing: ${src}`);
  }

  const srcPath = path.join(SRC_DIR, "fit_pipeline.cpp");
  const outWasm = path.join(DIST_DIR, "od-fit-pipeline.wasm");
  const emxx = path.join(EMSDK_DIR, "upstream", "emscripten", "em++");

  const includes = [
    `-I${shellQuote(OD_INCLUDE_DIR)}`,
    `-I${shellQuote(VALLADO_DIR)}`,
    `-I${shellQuote(eigenInclude)}`,
    `-I${shellQuote(SDN_COMMON_DIR)}`,
    `-I${shellQuote(SDM_HOST_CPP_DIR)}`,
    `-I${shellQuote(SRC_DIR)}`,
  ];

  const sources = [srcPath, ...OD_LIB_SOURCES, manifestExportsPath].map(shellQuote).join(" ");

  // Fit-fidelity flags match the OD library's CMake WASM build (-O3 -ffast-math
  // -DEIGEN_DONT_PARALLELIZE -DNDEBUG) so the fitted elements match the OD `fit`
  // module. PURE_WASI standalone + host-import tolerance (like the adapters).
  run(
    `${shellQuote(emxx)} -O3 -std=c++17 -fwasm-exceptions -sWASM_LEGACY_EXCEPTIONS=0 ` +
      `-DSDN_WASI_PLUGIN=1 -DEIGEN_DONT_PARALLELIZE -DNDEBUG -ffast-math ` +
      `${includes.join(" ")} ${sources} ` +
      `-sWASM=1 -sSTANDALONE_WASM=1 -sPURE_WASI=1 -sINITIAL_MEMORY=67108864 -sALLOW_MEMORY_GROWTH=1 ` +
      `-sFILESYSTEM=0 -sERROR_ON_UNDEFINED_SYMBOLS=0 ` +
      `-sEXPORTED_FUNCTIONS="['_plugin_invoke_stream','_plugin_alloc','_plugin_free','_plugin_get_manifest_flatbuffer','_plugin_get_manifest_flatbuffer_size']" ` +
      `--no-entry -o ${shellQuote(outWasm)}`,
  );

  // dist/isomorphic/module.wasm is the loadable (unsigned) runtime artifact.
  fs.copyFileSync(outWasm, path.join(ISOMORPHIC_DIST_DIR, "module.wasm"));
  await signBuiltModule(outWasm);
  console.log(`  Runtime artifact (loadable, unsigned): ${path.join(ISOMORPHIC_DIST_DIR, "module.wasm")}`);
  console.log(`\n✓ Build complete: ${outWasm}`);
}

main().catch((err) => {
  console.error("\nBuild failed:", err.message);
  process.exit(1);
});

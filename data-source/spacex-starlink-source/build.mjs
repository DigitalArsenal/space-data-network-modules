#!/usr/bin/env node
/**
 * Build the SpaceX Starlink data-source WASM module using a repo-local emsdk
 * toolchain. Adapted from licensing/client-decrypt/build.mjs (no Crypto++).
 *
 * Usage: node build.mjs
 * Output: dist/spacex-starlink-source.wasm, dist/isomorphic/module.wasm
 *
 * Environment:
 *   SDN_LOCAL_EMSDK_DIR      — repo-local emsdk root override
 *   FLATBUFFERS_INCLUDE_DIR  — path to flatbuffers C++ headers (optional override)
 *   SDN_MODULE_SIGNING_KEYPAIR — dev module signing keypair path override
 */

import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signModuleArtifact, verifyModuleArtifact } from "space-data-module-sdk/bundle";
import { encodePlgManifest, legacyManifestToPlg } from "space-data-module-sdk/manifest";
import createStarlinkSourcePluginManifest from "./manifest.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EMSDK_DIR = path.resolve(process.env.SDN_LOCAL_EMSDK_DIR || path.join(__dirname, "deps", "emsdk"));
const EM_CACHE_DIR = path.join(__dirname, ".emcache");
const BUILD_DIR = path.join(__dirname, ".build");
const DIST_DIR = path.join(__dirname, "dist");
const ISOMORPHIC_DIST_DIR = path.join(DIST_DIR, "isomorphic");
const SRC_DIR = path.join(__dirname, "src");
const CORE_SDS_GENERATED_DIR = path.resolve(__dirname, "../../licensing/core/src/cpp/generated/sds");
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
  console.log("SDN Plugin Build — spacex-starlink-source");
  ensureLocalEmscripten();
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  fs.mkdirSync(DIST_DIR, { recursive: true });
  fs.mkdirSync(ISOMORPHIC_DIST_DIR, { recursive: true });

  const flatbuffersInclude = resolveFlatbuffersInclude();

  // Embed the real manifest so the node sees the module's methods, host
  // capabilities, and TIMERS. Encoded via the SDK's $PLG encoder — the same
  // format every other compiled module uses and the Go node's PLG parser reads.
  const manifestBytes = encodePlgManifest(legacyManifestToPlg(createStarlinkSourcePluginManifest()));
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

  const srcPath = path.join(SRC_DIR, "spacex_starlink_source.cpp");
  const outWasm = path.join(DIST_DIR, "spacex-starlink-source.wasm");
  const emxx = path.join(EMSDK_DIR, "upstream", "emscripten", "em++");

  const includes = [`-I${shellQuote(flatbuffersInclude)}`];
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

  // dist/isomorphic/module.wasm is the loadable runtime artifact — unsigned, like
  // every other module — that the node instantiates directly in WasmEdge (which
  // rejects the non-standard signature section). The signed, publishable
  // distributable is dist/spacex-starlink-source.wasm.
  fs.copyFileSync(outWasm, path.join(ISOMORPHIC_DIST_DIR, "module.wasm"));
  await signBuiltModule(outWasm);
  console.log(`  Runtime artifact (loadable, unsigned): ${path.join(ISOMORPHIC_DIST_DIR, "module.wasm")}`);
  console.log(`\n✓ Build complete: ${outWasm}`);
}

main().catch((err) => {
  console.error("\nBuild failed:", err.message);
  process.exit(1);
});

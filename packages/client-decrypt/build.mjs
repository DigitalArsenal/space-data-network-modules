#!/usr/bin/env node
/**
 * Build the SDN client-decrypt WASM module using system emcc.
 *
 * Prerequisites:
 *   - emcc in PATH (Emscripten 3.x or 4.x)
 *   - Internet access to fetch Crypto++ 8.9.0 (or set CRYPTOPP_SOURCE_DIR)
 *   - npm install (for space-data-module-sdk + flatc-wasm)
 *
 * Usage:
 *   node build.mjs
 *
 * Output:
 *   dist/client-decrypt.wasm
 *
 * Environment:
 *   CRYPTOPP_SOURCE_DIR      — local Crypto++ source tree (skips git clone)
 *   FLATBUFFERS_INCLUDE_DIR  — path to flatbuffers C++ headers (optional override)
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = path.join(__dirname, ".build");
const DIST_DIR = path.join(__dirname, "dist");
const SRC_DIR = path.join(__dirname, "src");

// ── Helpers ────────────────────────────────────────────────────────────────────

function run(cmd, opts = {}) {
  console.log(`  $ ${cmd}`);
  execSync(cmd, { stdio: "inherit", ...opts });
}

function runSilent(cmd, opts = {}) {
  return execSync(cmd, { encoding: "utf8", ...opts });
}

// ── FlatBuffer C++ header generation ─────────────────────────────────────────

async function generateFlatbufferHeaders(outDir) {
  console.log("  Generating FlatBuffer C++ headers...");
  fs.mkdirSync(outDir, { recursive: true });

  const flatcWasmPath = path.join(__dirname, "node_modules", "flatc-wasm", "dist", "flatc-wasm.js");
  if (!fs.existsSync(flatcWasmPath)) {
    throw new Error(
      `flatc-wasm not found at ${flatcWasmPath}.\nRun: npm install`,
    );
  }

  const sdkSchemasDir = path.join(__dirname, "node_modules", "space-data-module-sdk", "schemas");
  if (!fs.existsSync(sdkSchemasDir)) {
    throw new Error(
      `space-data-module-sdk schemas not found.\nRun: npm install`,
    );
  }

  const { default: createFlatc } = await import(`file://${flatcWasmPath}`);
  const flatc = await createFlatc();

  const schemaFiles = [
    "PluginInvokeRequest.fbs",
    "PluginInvokeResponse.fbs",
    "TypedArenaBuffer.fbs",
  ];

  const ensureDir = (p) => { try { flatc.FS.mkdir(p); } catch {} };
  ensureDir("/schemas");
  ensureDir("/out_cpp");

  for (const sf of schemaFiles) {
    flatc.FS.writeFile(
      `/schemas/${sf}`,
      fs.readFileSync(path.join(sdkSchemasDir, sf), "utf8"),
    );
  }

  for (const sf of schemaFiles) {
    const rc = flatc.callMain([
      "--cpp", "--cpp-std", "c++17", "--gen-object-api",
      "-I", "/schemas", "-o", "/out_cpp", `/schemas/${sf}`,
    ]);
    if (rc !== 0) throw new Error(`flatc failed for ${sf}`);
    const hdr = `${path.basename(sf, ".fbs")}_generated.h`;
    fs.writeFileSync(
      path.join(outDir, hdr),
      flatc.FS.readFile(`/out_cpp/${hdr}`, { encoding: "utf8" }),
    );
  }
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
  for (const src of sources) {
    const obj = path.join(objDir, src.replace(".cpp", ".o"));
    if (!fs.existsSync(obj)) {
      run(
        `emcc -O2 -std=c++17 -fwasm-exceptions ` +
          `-DCRYPTOPP_DISABLE_ASM=1 -DCRYPTOPP_DISABLE_SSSE3=1 -DCRYPTOPP_DISABLE_AESNI=1 ` +
          `-I${parentDir} -I${srcDir} ` +
          `-c ${path.join(srcDir, src)} -o ${obj}`,
      );
    }
    objFiles.push(obj);
  }

  run(`emar rcs ${archivePath} ${objFiles.join(" ")}`);
  console.log(`  Crypto++ archive: ${archivePath}`);
}

// ── Resolve FlatBuffers C++ include path ──────────────────────────────────────

function resolveFlatbuffersInclude() {
  const explicit = process.env.FLATBUFFERS_INCLUDE_DIR;
  if (explicit && fs.existsSync(path.join(explicit, "flatbuffers", "base.h"))) {
    console.log(`  Using FlatBuffers headers: ${explicit}`);
    return explicit;
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

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("SDN Plugin Build — client-decrypt");
  console.log(`Build dir: ${BUILD_DIR}`);
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  fs.mkdirSync(DIST_DIR, { recursive: true });

  const flatbuffersInclude = resolveFlatbuffersInclude();

  // Generate invoke FlatBuffer headers
  const fbbHeadersDir = path.join(BUILD_DIR, "fbb-headers");
  if (!fs.existsSync(path.join(fbbHeadersDir, "PluginInvokeRequest_generated.h"))) {
    await generateFlatbufferHeaders(fbbHeadersDir);
  } else {
    console.log("  FlatBuffer headers already generated.");
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

  run(
    `em++ -O2 -std=c++17 -fwasm-exceptions ` +
      `-DCRYPTOPP_DISABLE_ASM=1 -DCRYPTOPP_DISABLE_SSSE3=1 -DCRYPTOPP_DISABLE_AESNI=1 ` +
      `-I${cryptoppParent} -I${cryptoppSrc} -I${fbbHeadersDir} -I${flatbuffersInclude} ` +
      `${srcPath} ${manifestExportsPath} ${cryptoppLib} ` +
      `-sWASM=1 -sSTANDALONE_WASM=1 -sPURE_WASI=1 ` +
      `-sINITIAL_MEMORY=16777216 -sALLOW_MEMORY_GROWTH=1 ` +
      `-sFILESYSTEM=0 ` +
      `-sERROR_ON_UNDEFINED_SYMBOLS=0 ` +
      `-sEXPORTED_FUNCTIONS="['_plugin_invoke_stream','_plugin_alloc','_plugin_free','_plugin_get_manifest_flatbuffer','_plugin_get_manifest_flatbuffer_size']" ` +
      `--no-entry -o ${outWasm}`,
  );

  console.log(`\n✓ Build complete: ${outWasm}`);
}

main().catch((err) => {
  console.error("\nBuild failed:", err.message);
  process.exit(1);
});

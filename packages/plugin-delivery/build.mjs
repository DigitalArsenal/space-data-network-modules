#!/usr/bin/env node
/**
 * Build the SDN plugin-delivery WASM module using a repo-local emsdk toolchain.
 *
 * Prerequisites:
 *   - Internet access to fetch Crypto++ 8.9.0 (or set CRYPTOPP_SOURCE_DIR)
 *   - npm install (for space-data-module-sdk + flatc-wasm)
 *
 * Usage:
 *   node build.mjs
 *
 * Output:
 *   dist/plugin-delivery.wasm
 *   dist/isomorphic/module.wasm
 *
 * Environment:
 *   CRYPTOPP_SOURCE_DIR          — local Crypto++ source tree (skips git clone)
 *   SDN_LOCAL_EMSDK_DIR          — repo-local emsdk root override
 *   SDN_SERVER_PRIVATE_KEY_HEX   — 64-char hex X25519 private key (generated if omitted)
 *   FLATBUFFERS_INCLUDE_DIR      — path to flatbuffers C++ headers (optional override)
 */

import { execFileSync, execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
    run("./emsdk install latest", { cwd: EMSDK_DIR });
    run("./emsdk activate latest", { cwd: EMSDK_DIR });
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

function toCByteArray(buf) {
  return Array.from(buf)
    .map((b) => `0x${b.toString(16).padStart(2, "0")}`)
    .join(", ");
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
  const moduleDeliverySchemasDir = path.resolve(
    __dirname,
    "../../../space-data-network/packages/plugin-sdk/schemas/space-data-network/module-delivery/v1",
  );
  if (!fs.existsSync(moduleDeliverySchemasDir)) {
    throw new Error(
      `module-delivery schemas not found at ${moduleDeliverySchemasDir}`,
    );
  }

  const { default: createFlatc } = await import(`file://${flatcWasmPath}`);
  const flatc = await createFlatc();

  const sdkSchemaFiles = [
    "PluginInvokeRequest.fbs",
    "PluginInvokeResponse.fbs",
    "TypedArenaBuffer.fbs",
  ];
  const moduleDeliverySchemaFiles = [
    "BundleDescriptor.fbs",
    "WrappedContentKey.fbs",
    "GrantResponse.fbs",
  ];

  const ensureDir = (p) => { try { flatc.FS.mkdir(p); } catch {} };
  ensureDir("/schemas");
  ensureDir("/schemas/sdk");
  ensureDir("/schemas/module_delivery");
  ensureDir("/out_cpp");

  for (const sf of sdkSchemaFiles) {
    flatc.FS.writeFile(
      `/schemas/sdk/${sf}`,
      fs.readFileSync(path.join(sdkSchemasDir, sf), "utf8"),
    );
  }
  for (const sf of moduleDeliverySchemaFiles) {
    flatc.FS.writeFile(
      `/schemas/module_delivery/${sf}`,
      fs.readFileSync(path.join(moduleDeliverySchemasDir, sf), "utf8"),
    );
  }

  for (const sf of sdkSchemaFiles) {
    const rc = flatc.callMain([
      "--cpp", "--cpp-std", "c++17", "--gen-object-api",
      "-I", "/schemas/sdk", "-o", "/out_cpp", `/schemas/sdk/${sf}`,
    ]);
    if (rc !== 0) throw new Error(`flatc failed for ${sf}`);
    const hdr = `${path.basename(sf, ".fbs")}_generated.h`;
    fs.writeFileSync(
      path.join(outDir, hdr),
      flatc.FS.readFile(`/out_cpp/${hdr}`, { encoding: "utf8" }),
    );
  }

  for (const sf of moduleDeliverySchemaFiles) {
    const rc = flatc.callMain([
      "--cpp", "--cpp-std", "c++17", "--gen-object-api",
      "-I", "/schemas/module_delivery", "-o", "/out_cpp", `/schemas/module_delivery/${sf}`,
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
  const emcc = path.join(EMSDK_DIR, "upstream", "emscripten", "emcc");
  const emar = path.join(EMSDK_DIR, "upstream", "emscripten", "emar");
  for (const src of sources) {
    const obj = path.join(objDir, src.replace(".cpp", ".o"));
    if (!fs.existsSync(obj)) {
      run(
        `${shellQuote(emcc)} -O2 -std=c++17 -fignore-exceptions ` +
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
  // 1. Explicit env override
  const explicit = process.env.FLATBUFFERS_INCLUDE_DIR;
  if (explicit && fs.existsSync(path.join(explicit, "flatbuffers", "base.h"))) {
    console.log(`  Using FlatBuffers headers: ${explicit}`);
    return explicit;
  }
  // 2. brew
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
  console.log("SDN Plugin Build — plugin-delivery");
  console.log(`Build dir: ${BUILD_DIR}`);
  ensureLocalEmscripten();
  syncToolchainStamp();
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  fs.mkdirSync(DIST_DIR, { recursive: true });
  fs.mkdirSync(ISOMORPHIC_DIST_DIR, { recursive: true });

  const flatbuffersInclude = resolveFlatbuffersInclude();

  // Generate invoke FlatBuffer headers
  const fbbHeadersDir = path.join(BUILD_DIR, "fbb-headers");
  if (
    !fs.existsSync(path.join(fbbHeadersDir, "PluginInvokeRequest_generated.h")) ||
    !fs.existsSync(path.join(fbbHeadersDir, "GrantResponse_generated.h"))
  ) {
    await generateFlatbufferHeaders(fbbHeadersDir);
  } else {
    console.log("  FlatBuffer headers already generated.");
  }

  // Ensure Crypto++ sources
  const { srcDir: cryptoppSrc, parentDir: cryptoppParent } =
    await ensureCryptoppSources(path.join(BUILD_DIR, "cryptopp-src"));

  // Compile Crypto++
  const cryptoppObjDir = path.join(BUILD_DIR, "cryptopp-obj");
  const cryptoppLib = path.join(BUILD_DIR, "libcryptopp.a");
  compileCryptoppLib(cryptoppSrc, cryptoppParent, cryptoppObjDir, cryptoppLib);

  // Bake server private key
  let privKeyHex = (process.env.SDN_SERVER_PRIVATE_KEY_HEX || "").trim();
  if (privKeyHex.length !== 64) {
    console.log("  Generating random server X25519 private key...");
    privKeyHex = crypto.randomBytes(32).toString("hex");
    const secretsPath = path.join(__dirname, ".server-key.hex");
    fs.writeFileSync(secretsPath, privKeyHex, "utf8");
    console.log(`  Saved to ${secretsPath} (gitignored)`);
  }
  const privKeyBytes = Buffer.from(privKeyHex, "hex");
  const bakedKeyLiteral = toCByteArray(privKeyBytes);

  // Apply template
  const objDir = path.join(BUILD_DIR, "obj");
  fs.mkdirSync(objDir, { recursive: true });
  const srcTemplate = fs.readFileSync(path.join(SRC_DIR, "plugin_delivery.cpp"), "utf8");
  const srcFinal = srcTemplate.replaceAll("SDN_BAKED_SERVER_PRIVATE_KEY", bakedKeyLiteral);
  const buildCppPath = path.join(objDir, "plugin_delivery_build.cpp");
  fs.writeFileSync(buildCppPath, srcFinal, "utf8");

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

  const outWasm = path.join(DIST_DIR, "plugin-delivery.wasm");
  const emxx = path.join(EMSDK_DIR, "upstream", "emscripten", "em++");

  run(
    `${shellQuote(emxx)} -O2 -std=c++17 -fignore-exceptions ` +
      `-DSDN_WASI_PLUGIN=1 ` +
      `-DCRYPTOPP_DISABLE_ASM=1 -DCRYPTOPP_DISABLE_SSSE3=1 -DCRYPTOPP_DISABLE_AESNI=1 ` +
      `-I${shellQuote(cryptoppParent)} -I${shellQuote(cryptoppSrc)} -I${shellQuote(fbbHeadersDir)} -I${shellQuote(flatbuffersInclude)} ` +
      `${shellQuote(buildCppPath)} ${shellQuote(manifestExportsPath)} ${shellQuote(cryptoppLib)} ` +
      `-sWASM=1 -sSTANDALONE_WASM=1 -sPURE_WASI=1 ` +
      `-sINITIAL_MEMORY=33554432 -sALLOW_MEMORY_GROWTH=1 ` +
      `-sDISABLE_EXCEPTION_CATCHING=1 ` +
      `-sERROR_ON_UNDEFINED_SYMBOLS=0 ` +
      `-sEXPORTED_FUNCTIONS="['_plugin_invoke_stream','_plugin_alloc','_plugin_free','_plugin_get_manifest_flatbuffer','_plugin_get_manifest_flatbuffer_size']" ` +
      `--no-entry -o ${shellQuote(outWasm)}`,
  );

  fs.copyFileSync(outWasm, path.join(ISOMORPHIC_DIST_DIR, "module.wasm"));

  console.log(`\n✓ Build complete: ${outWasm}`);
}

main().catch((err) => {
  console.error("\nBuild failed:", err.message);
  process.exit(1);
});

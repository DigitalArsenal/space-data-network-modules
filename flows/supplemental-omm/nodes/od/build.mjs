#!/usr/bin/env node
/**
 * Build the Supplemental OMM OD node (typed contracts 1.0) through the SDK compiler, unsigned.
 *
 * The SDK compiler (space-data-module-sdk/compiler) compiles a stub of the node's methods for the manifest: it stages
 * the invoke bridge, the runtime types the ports carry (FlowNotice, IngestRequest, IngestResult, HttpRequest), the
 * typed hostcall (typedHostcall.hpp) and the FlatBuffers runtime, and builds the bridge and manifest objects. The node
 * itself is three objects, linked with the SDK's wasi-threads toolchain against that bridge:
 *
 *   src/node.cpp          the node, against analysis/od's SDS headers (licensing/core/src/cpp/generated/sds, the ones
 *                         the frozen fit core and analysis/od compile against; the OMM/OBD object API the SGP4-XP
 *                         records are written with)
 *   xp_engine.cpp         propagator/sgp4-xp's fit engine (ERFA, foundation/frames, the engine headers): no SDS record
 *   vendor/od-fit-core.o  the frozen threaded complete-arc OD core (vendor/NOTICE.md)
 *
 * and the US Space Force Sgp4Prop build is joined to the linked node by wasm-merge (propagator/sgp4-xp/join-ussf.mjs):
 * the node's memory stays memory 0, the library's becomes memory 1. The manifest and the Agreement notice go in as
 * custom sections and the result is checked by the SDK's validator against the standards
 * (SPACE_DATA_STANDARDS_ROOT, else the spacedatastandards.org package the SDK resolves).
 *
 * Output: dist/isomorphic/module.wasm (browser and WasmEdge, portable, UNSIGNED) and dist/plugin-manifest.json. The
 * WasmEdge universal-AOT section and the release signature are added by the flow's release step
 * (scripts/release.mjs), never here.
 *
 * Needs: a wasi-threads toolchain whose libc++ keeps std::vector's pointer layout, as the frozen fit core does (it
 * passes its results in std::vector and std::string): wasi-sdk 30 (libc++ 21). WASI_SDK_PATH names it, and the SDK's
 * toolchain variables (SDN_WASI_CLANG / _CLANGXX / _SYSROOT / _RESOURCE_DIR) are set from it unless given; node.cpp
 * refuses to compile against a libc++ that lays vectors out by size (Homebrew's wasi-runtimes 23). Also wasm-merge
 * and wat2wasm (binaryen, wabt).
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { encodePluginManifest } from "space-data-module-sdk";
import {
  assertPthreadArtifact,
  cleanupCompilation,
  compileModuleFromSource,
  PTHREAD_FINAL_LINK_FLAGS,
  resolveWasiThreadsToolchain,
} from "space-data-module-sdk/compiler";
import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { appendWasmCustomSection, SDS_MANIFEST_SECTION_NAME } from "space-data-module-sdk/bundle";

// The SGP4-XP fit engine and the Space Force library join of propagator/sgp4-xp (see its README).
import { composeEngineSource } from "../../../../propagator/sgp4-xp/engine-source.mjs";
import { joinUssf, ussfNotice } from "../../../../propagator/sgp4-xp/join-ussf.mjs";
import { exportNames } from "../../../../propagator/sgp4-xp/wasm-sections.mjs";

const execFileAsync = promisify(execFile);
const nodeRoot = path.dirname(fileURLToPath(import.meta.url));
const modulesRoot = path.resolve(nodeRoot, "../../../..");
const buildRoot = path.join(nodeRoot, ".build");
const distRoot = path.join(nodeRoot, "dist");
const manifestPath = path.join(nodeRoot, "plugin-manifest.json");
const sourcePath = path.join(nodeRoot, "src/node.cpp");
const fitCoreObject = path.join(nodeRoot, "vendor/od-fit-core.o");
const fitCoreObjectSha256 = "7ebc7409148e085759c976ae07f01c378b2f4f5a3662bd21a7c9b6ed6608782e";
const sdsHeaders = path.join(modulesRoot, "licensing/core/src/cpp/generated/sds");
// The standards the manifests are validated against: SPACE_DATA_STANDARDS_ROOT, else the spacedatastandards.org package
// this flow pins (package.json devDependencies).
process.env.SPACE_DATA_STANDARDS_ROOT ??= path.dirname(createRequire(import.meta.url).resolve("spacedatastandards.org/package.json"));

async function run(command, args) {
  try {
    await execFileAsync(command, args, { cwd: nodeRoot, maxBuffer: 32 * 1024 * 1024 });
  } catch (error) {
    throw new Error(`${command} failed: ${String(error?.stderr || error?.stdout || error?.message || error)}`);
  }
}

// The toolchain: wasi-sdk (WASI_SDK_PATH) unless the SDK's variables name one.
if (process.env.WASI_SDK_PATH) {
  const sdk = path.resolve(process.env.WASI_SDK_PATH);
  const clangVersion = (await readdir(path.join(sdk, "lib/clang"))).sort().at(-1);
  process.env.SDN_WASI_CLANG ??= path.join(sdk, "bin/clang");
  process.env.SDN_WASI_CLANGXX ??= path.join(sdk, "bin/clang++");
  process.env.SDN_WASI_SYSROOT ??= path.join(sdk, "share/wasi-sysroot");
  process.env.SDN_WASI_RESOURCE_DIR ??= path.join(sdk, "lib/clang", clangVersion);
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
if (sha256(await readFile(fitCoreObject)) !== fitCoreObjectSha256) {
  throw new Error(`vendored OD fit core does not match ${fitCoreObjectSha256}`);
}

await rm(buildRoot, { recursive: true, force: true });
await rm(distRoot, { recursive: true, force: true });
await mkdir(buildRoot, { recursive: true });
await mkdir(path.join(distRoot, "isomorphic"), { recursive: true });

// The stub: one empty body per method, threaded as the node is, so the SDK builds the bridge for this manifest.
const compilation = await compileModuleFromSource({
  manifest,
  sourceCode: `
#include <thread>
extern "C" int fit(void) {
  std::thread worker([] {});
  worker.join();
  return 0;
}
extern "C" int publish_request(void) { return 0; }`,
  language: "c++",
  threadModel: "emscripten-pthreads",
  allowUndefinedImports: true,
  outputPath: path.join(buildRoot, "stub.wasm"),
  // The link below reuses the stub's bridge and manifest objects and staged headers from the compile's temp dir.
  keepTempDir: true,
});

try {
  const toolchain = resolveWasiThreadsToolchain();
  const compileFlags = [
    ...toolchain.toolchainArgs,
    "-std=c++17",
    "-O3",
    "-DNDEBUG",
    "-DEIGEN_DONT_PARALLELIZE",
    "-matomics",
    "-mbulk-memory",
    "-fno-exceptions",
    "-pthread",
  ];
  const includeArgs = [
    compilation.tempDir,
    path.join(compilation.tempDir, "flatbuffers-runtime"),
    sdsHeaders,
    path.join(modulesRoot, "common"),
    path.join(nodeRoot, "vendor"),
    path.join(modulesRoot, "propagator/sgp4-xp/src"),
  ].map((directory) => `-I${directory}`);
  const nodeObject = path.join(buildRoot, "node.o");
  await run(toolchain.clangxx, [...compileFlags, ...includeArgs, "-c", sourcePath, "-o", nodeObject]);

  // The SGP4-XP fit engine: one translation unit with no SDS record in it, compiled with the node's flags.
  const engine = await composeEngineSource();
  const engineSource = path.join(buildRoot, "xp_engine.cpp");
  const engineObject = path.join(buildRoot, "xp_engine.o");
  await writeFile(engineSource, engine.source);
  await run(toolchain.clangxx, [...compileFlags, "-c", engineSource, "-o", engineObject]);

  const exportedSymbols = [
    "plugin_get_manifest_flatbuffer",
    "plugin_get_manifest_flatbuffer_size",
    "plugin_invoke_stream",
    "plugin_alloc",
    "plugin_free",
    "fit",
    "publish_request",
  ];
  // The memory is exported only for the join, which resolves the engine's imports of the Space Force library against
  // it; the join removes the export again.
  const linkedPath = path.join(buildRoot, "module.linked.wasm");
  await run(toolchain.clangxx, [
    ...toolchain.toolchainArgs,
    nodeObject,
    engineObject,
    fitCoreObject,
    path.join(compilation.tempDir, "plugin-manifest-exports.o"),
    path.join(compilation.tempDir, "plugin-invoke-bridge.o"),
    "-O3",
    "-mexec-model=reactor",
    ...PTHREAD_FINAL_LINK_FLAGS,
    "-Wl,--export-memory",
    // wasi-sdk's libraries carry DWARF; the node ships none.
    "-Wl,--strip-debug",
    "-Wl,--allow-undefined",
    ...exportedSymbols.map((symbol) => `-Wl,--export=${symbol}`),
    "-o",
    linkedPath,
  ]);

  const linkedExports = exportNames(new Uint8Array(await readFile(linkedPath)));
  const joined = await joinUssf({
    adapterPath: linkedPath,
    workDir: buildRoot,
    keepExports: new Set(linkedExports.map((e) => e.name).filter((name) => name !== "memory")),
  });
  let wasmBytes = appendWasmCustomSection(joined.bytes, "ussf-sgp4-notice", new TextEncoder().encode(await ussfNotice()));
  wasmBytes = appendWasmCustomSection(wasmBytes, SDS_MANIFEST_SECTION_NAME, encodePluginManifest(manifest));
  assertPthreadArtifact(wasmBytes, { source: linkedPath });
  const artifactPath = path.join(distRoot, "isomorphic/module.wasm");
  await writeFile(artifactPath, wasmBytes);
  const report = await validateArtifactWithStandards({ manifest, wasmPath: artifactPath });
  if (!report.ok) throw new Error(`OD artifact failed SDK validation:\n${JSON.stringify(report.issues, null, 2)}`);
  await copyFile(manifestPath, path.join(distRoot, "plugin-manifest.json"));
  process.stdout.write(`Built ${manifest.pluginId} ${manifest.version} ${sha256(wasmBytes)} (${wasmBytes.byteLength} bytes, unsigned)\n`);
} finally {
  await cleanupCompilation(compilation);
  await rm(buildRoot, { recursive: true, force: true });
}

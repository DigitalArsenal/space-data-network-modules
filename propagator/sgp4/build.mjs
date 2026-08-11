#!/usr/bin/env node
// Build the one SGP4 artifact shared by browser and WasmEdge.
//
// SGP4 is not in the raw Emscripten lane. It is inherently sequential inside
// one invocation; hosts shard independent entity work. The binary therefore
// uses the SDK's sanctioned clang wasm32-wasip1-threads target with the
// wasi-sequential link shape. This script never downloads a compiler or source.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const moduleRoot = path.resolve(packageRoot, "../..");
const sourceRoot = path.join(packageRoot, "src", "cpp");
const buildRoot = path.join(sourceRoot, "build-wasi-sequential");
const distRoot = path.join(packageRoot, "dist");
const artifactPath = path.join(distRoot, "isomorphic", "module.wasm");
const target = "wasm32-wasip1-threads";
const threadModel = "wasi-sequential";

const sqliteFiles = Object.freeze({
  "sqlite3.c": "6eef1d024738af82aced260657a030e43bd38777fddf9cb70e59cf5444f80bef",
  "sqlite3.h": "7dc8a389408a2385ec239270cfd77a23cf67e206b5a13c8de59923ac3ccfa2da",
  "sqlite3ext.h": "b184dd1586d935133d37ad76fa353faf0a1021ff2fdedeedcc3498fff74bbb94",
});

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function requireVendoredSqlite() {
  const root = path.join(sourceRoot, "deps", "sqlite3");
  for (const [name, expected] of Object.entries(sqliteFiles)) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) {
      throw new Error(`Pinned SQLite 3.45.2 source is missing: ${file}. This build will not fetch it.`);
    }
    const actual = sha256(file);
    if (actual !== expected) {
      throw new Error(`Pinned SQLite source changed: ${name} sha256=${actual}, expected ${expected}. Update its pin deliberately.`);
    }
  }
  return root;
}

function sdkRoot() {
  const configured = process.env.SDN_MODULE_SDK_ROOT;
  if (configured) return path.resolve(configured);
  const fromStack = path.resolve(moduleRoot, "../../ancillary-packages/space-data-module-sdk");
  if (fs.existsSync(path.join(fromStack, "src", "compiler", "wasiThreadsToolchain.js"))) return fromStack;
  throw new Error(
    "Set SDN_MODULE_SDK_ROOT to the stack-local space-data-module-sdk checkout. " +
    "SGP4 uses its sanctioned WASI toolchain resolver and artifact guard.",
  );
}

function flatbuffersInclude() {
  const root = process.env.SDN_FLATBUFFERS_ROOT ?? process.env.FLATBUFFERS_ROOT;
  const include = process.env.FLATBUFFERS_INCLUDE_DIR ?? (root ? path.join(root, "include") : null);
  if (!include || !fs.existsSync(path.join(include, "flatbuffers", "flatbuffers.h"))) {
    throw new Error(
      "Set SDN_FLATBUFFERS_ROOT or FLATBUFFERS_INCLUDE_DIR to the pinned stack FlatBuffers checkout. " +
      "This build does not use a package-manager header path.",
    );
  }
  return path.resolve(include);
}

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      cwd: options.cwd ?? packageRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(options.env ?? {}) },
    });
  } catch (error) {
    const detail = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `:\n${detail}` : ""}`);
  }
}

function remove(pathname) {
  fs.rmSync(pathname, { recursive: true, force: true });
}

const sdk = sdkRoot();
const { resolveWasiThreadsToolchain } = await import(
  pathToFileURL(path.join(sdk, "src", "compiler", "wasiThreadsToolchain.js")).href,
);
const { assertSequentialArtifact } = await import(
  pathToFileURL(path.join(sdk, "src", "compiler", "pthreadArtifactGuard.js")).href,
);
const { appendWasmCustomSection } = await import(
  pathToFileURL(path.join(sdk, "src", "bundle", "wasm.js")).href,
);
const { encodePlgManifest, legacyManifestToPlg } = await import(
  pathToFileURL(path.join(sdk, "src", "manifest", "index.js")).href,
);

const sqliteRoot = requireVendoredSqlite();
const toolchain = resolveWasiThreadsToolchain({ force: true });
if (toolchain.target !== target) {
  throw new Error(`SGP4 requires ${target}; resolver returned ${toolchain.target}.`);
}
const flatbuffers = flatbuffersInclude();

run(process.execPath, ["generate-sds-headers.mjs"]);
run(process.execPath, ["generate-manifest-header.mjs"]);
run(process.execPath, ["generate-test-bindings.mjs"]);

remove(buildRoot);
remove(distRoot);
fs.mkdirSync(path.dirname(artifactPath), { recursive: true });

const compilerTargetFlags = toolchain.toolchainArgs.join(" ");
run("cmake", [
  "-S", sourceRoot,
  "-B", buildRoot,
  "-DCMAKE_BUILD_TYPE=Release",
  "-DCMAKE_SYSTEM_NAME=WASI",
  "-DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY",
  `-DCMAKE_C_COMPILER=${toolchain.clang}`,
  `-DCMAKE_CXX_COMPILER=${toolchain.clangxx}`,
  `-DCMAKE_C_FLAGS=${compilerTargetFlags}`,
  `-DCMAKE_CXX_FLAGS=${compilerTargetFlags}`,
  `-DCMAKE_EXE_LINKER_FLAGS=${compilerTargetFlags}`,
  `-DFLATBUFFERS_INCLUDE_DIR=${flatbuffers}`,
  `-DSGP4_SQLITE_AMALGAMATION_DIR=${sqliteRoot}`,
  "-DSGP4_WASI_SEQUENTIAL=ON",
]);
run("cmake", ["--build", buildRoot, "--target", "sgp4_wasi", "--parallel"]);

const builtArtifact = path.join(buildRoot, "sgp4_wasi.wasm");
if (!fs.existsSync(builtArtifact)) {
  throw new Error(`CMake did not produce ${builtArtifact}.`);
}
fs.copyFileSync(builtArtifact, artifactPath);
const authoredManifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "plugin-manifest.json"), "utf8"));
const artifact = appendWasmCustomSection(
  fs.readFileSync(artifactPath),
  "sds.manifest",
  encodePlgManifest(legacyManifestToPlg(authoredManifest)),
);
fs.writeFileSync(artifactPath, artifact);

// The guard reads the emitted bytes. A declaration or link line alone proves
// nothing: a browser-only env import makes the claimed artifact unusable in
// WasmEdge even when CMake reports success.
assertSequentialArtifact(artifact, { source: artifactPath, target });
const module = new WebAssembly.Module(artifact);
const imports = WebAssembly.Module.imports(module);
const nonWasi = imports.filter((entry) => entry.module !== "wasi_snapshot_preview1");
if (nonWasi.length) {
  throw new Error(
    `SGP4 artifact imports a non-portable host module: ${nonWasi.map((entry) => `${entry.module}.${entry.name}`).join(", ")}.`,
  );
}

const compilerVersion = run(toolchain.clangxx, ["--version"]).split("\n")[0];
const proof = {
  compiler: toolchain.clangxx,
  compilerVersion,
  target,
  toolchainArgs: toolchain.toolchainArgs,
  threadModel,
  sqlite: { version: "3.45.2", files: sqliteFiles },
  artifact: "dist/isomorphic/module.wasm",
  imports: imports.map((entry) => ({ module: entry.module, name: entry.name, kind: entry.kind })),
};
fs.writeFileSync(path.join(distRoot, "build-toolchain.json"), `${JSON.stringify(proof, null, 2)}\n`);

console.log(JSON.stringify({ artifact: artifactPath, bytes: artifact.length, ...proof }, null, 2));

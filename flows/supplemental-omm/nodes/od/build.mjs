import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  encodePluginManifest,
  signModuleArtifact,
} from "space-data-module-sdk";
import {
  assertPthreadArtifact,
  cleanupCompilation,
  compileModuleFromSource,
  PTHREAD_FINAL_LINK_FLAGS,
  resolveWasiThreadsToolchain,
} from "space-data-module-sdk/compiler";
import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import {
  appendWasmCustomSection,
  SDS_MANIFEST_SECTION_NAME,
} from "space-data-module-sdk/bundle";

import { manifest } from "./manifest.mjs";
import { resolveSupplementalSigning } from "../signing.mjs";
import { compileUniversalAot } from "../universal-aot.mjs";
// The SGP4-XP fit engine and the Space Force library join of propagator/sgp4-xp (see its README).
import { composeEngineSource } from "../../../../propagator/sgp4-xp/engine-source.mjs";
import { joinUssf, ussfNotice } from "../../../../propagator/sgp4-xp/join-ussf.mjs";
import { exportNames } from "../../../../propagator/sgp4-xp/wasm-sections.mjs";

const execFileAsync = promisify(execFile);
const nodeRoot = path.dirname(fileURLToPath(import.meta.url));
const modulesRoot = path.resolve(nodeRoot, "../../../..");
const mainPackagesRoot = path.dirname(modulesRoot);
const standardsRoot = path.join(mainPackagesRoot, "spacedatastandards.org");
const flatbuffersRoot = path.join(mainPackagesRoot, "flatbuffers");
// The flatc that matches the flatbuffers checkout (repos/main-packages/flatbuffers/build/flatc), or SUPPLEMENTAL_OD_FLATC.
const flatcPath = process.env.SUPPLEMENTAL_OD_FLATC ?? path.join(flatbuffersRoot, "build/flatc");
const buildRoot = path.join(nodeRoot, ".build");
const unsignedRoot = path.join(nodeRoot, "dist/.unsigned");
// SUPPLEMENTAL_OD_VERIFY_OUT names a directory for a verification build: the signed node is written there and nothing
// in this directory (publisher.json, plugin-manifest.json, dist/) changes. Tests build the node this way.
const verificationRoot = process.env.SUPPLEMENTAL_OD_VERIFY_OUT
  ? path.resolve(process.env.SUPPLEMENTAL_OD_VERIFY_OUT)
  : null;
const distRoot = verificationRoot ?? path.join(nodeRoot, "dist/isomorphic");
const generatedFsbRoot = path.join(buildRoot, "FSB");
const generatedFsoRoot = path.join(buildRoot, "FSO");
const resultSchemaHeader = path.join(buildRoot, "result_schema_idl.h");
const manifestPath = path.join(nodeRoot, "plugin-manifest.json");
const sourcePath = path.join(nodeRoot, "src/node.cpp");
const fitCoreObject = path.join(nodeRoot, "vendor/od-fit-core.o");
const fitCoreObjectSha256 =
  "7ebc7409148e085759c976ae07f01c378b2f4f5a3662bd21a7c9b6ed6608782e";
const developmentSigningSeed = "55".repeat(32);
const { signingSeed, signingKeyId, developmentOnly, productionMode } =
  resolveSupplementalSigning({
    environment: process.env,
    environmentPrefix: "SUPPLEMENTAL_OD",
    developmentSigningSeed,
    defaultSigningKeyId: "supplemental-omm-od-development",
  });

async function run(command, args, options = {}) {
  try {
    await execFileAsync(command, args, {
      cwd: options.cwd ?? nodeRoot,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    const detail = String(error?.stderr || error?.stdout || error?.message || error);
    throw new Error(`${command} failed: ${detail}`);
  }
}

async function catalogEntry(schemaCode) {
  const idl = await readFile(
    path.join(standardsRoot, `schema/${schemaCode}/main.fbs`),
    "utf8",
  );
  return {
    schemaCode,
    schemaName: `${schemaCode}.fbs`,
    fileIdentifier: idl.match(/file_identifier\s+"([^"]+)"/)?.[1],
    rootTypeName: idl.match(/root_type\s+([A-Za-z0-9_]+)/)?.[1],
    version: idl.match(/\/\/ Version:\s*([^\n]+)/)?.[1]?.trim(),
    hash: idl.match(/\/\/ Hash:\s*([a-f0-9]+)/)?.[1],
    idl,
    files: [],
  };
}

async function flattenResultSchemaIdl() {
  const visited = new Set();
  const flattened = [];

  async function visit(schemaPath) {
    const resolved = path.resolve(schemaPath);
    if (visited.has(resolved)) return;
    visited.add(resolved);
    const source = await readFile(resolved, "utf8");
    const includePattern = /^\s*include\s+"([^"]+)"\s*;\s*$/gm;
    for (const match of source.matchAll(includePattern)) {
      await visit(path.resolve(path.dirname(resolved), match[1]));
    }
    const withoutFileDirectives = source
      .replace(includePattern, "")
      .replace(/^\s*root_type\s+[^;]+;\s*$/gm, "")
      .replace(/^\s*file_identifier\s+"[^"]+"\s*;[^\n]*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    flattened.push(withoutFileDirectives.trim());
  }

  for (const schemaCode of ["OMM", "OCM", "OBD"]) {
    await visit(path.join(standardsRoot, `schema/${schemaCode}/main.fbs`));
  }
  return `${flattened.join("\n\n")}\n`;
}

function resultSchemaHeaderSource(schemaIdl) {
  const delimiter = "SDSIDL";
  if (schemaIdl.includes(`)${delimiter}\"`)) {
    throw new Error("result schema contains the reserved C++ raw-string delimiter");
  }
  return `#pragma once\n\nconstexpr const char kResultSchemaIdl[] = R\"${delimiter}(\n${schemaIdl})${delimiter}\";\n`;
}

await rm(buildRoot, { recursive: true, force: true });
await rm(unsignedRoot, { recursive: true, force: true });
await mkdir(generatedFsbRoot, { recursive: true });
await mkdir(generatedFsoRoot, { recursive: true });
await mkdir(unsignedRoot, { recursive: true });
await mkdir(distRoot, { recursive: true });
const actualFitCoreObjectSha256 = createHash("sha256")
  .update(await readFile(fitCoreObject))
  .digest("hex");
if (actualFitCoreObjectSha256 !== fitCoreObjectSha256) {
  throw new Error(
    `vendored OD fit core hash ${actualFitCoreObjectSha256} does not match ${fitCoreObjectSha256}`,
  );
}
if (!verificationRoot) {
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
await writeFile(
  resultSchemaHeader,
  resultSchemaHeaderSource(await flattenResultSchemaIdl()),
);

await run(flatcPath, [
  "--no-warnings",
  "--cpp",
  "--aligned",
  "-o",
  generatedFsbRoot,
  path.join(standardsRoot, "schema/FSB/main.fbs"),
]);
await run(flatcPath, [
  "--no-warnings",
  "--cpp",
  "-o",
  generatedFsbRoot,
  path.join(standardsRoot, "schema/FSB/main.fbs"),
]);
await run(flatcPath, [
  "--no-warnings",
  "--cpp",
  "--filename-suffix",
  "_FSO",
  "-o",
  generatedFsoRoot,
  path.join(standardsRoot, "schema/FSO/main.fbs"),
]);
const generatedFsoHeader = path.join(generatedFsoRoot, "main_FSO.h");
await writeFile(
  generatedFsoHeader,
  (await readFile(generatedFsoHeader, "utf8")).replaceAll(
    "FLATBUFFERS_GENERATED_MAIN_H_",
    "FLATBUFFERS_GENERATED_FSO_H_",
  ),
);

process.env.SPACE_DATA_STANDARDS_ROOT ??= standardsRoot;
const stubOutput = path.join(unsignedRoot, "stub.wasm");
const compilation = await compileModuleFromSource({
  manifest,
  catalog: [await catalogEntry("FSB"), await catalogEntry("FSO")],
  sourceCode: `
#include <thread>
extern "C" int fit(void) {
  std::thread worker([] {});
  worker.join();
  return 0;
}`,
  language: "c++",
  threadModel: "emscripten-pthreads",
  allowUndefinedImports: true,
  outputPath: stubOutput,
  // The final link below reuses the stub's bridge and manifest objects from
  // the compile's temp dir, so keep it; cleanupCompilation frees it.
  keepTempDir: true,
});

try {
  const toolchain = resolveWasiThreadsToolchain();
  const objectPath = path.join(unsignedRoot, "node.o");
  const linkedPath = path.join(unsignedRoot, "module.linked.wasm");
  const includeArgs = [
    buildRoot,
    compilation.tempDir,
    path.join(flatbuffersRoot, "include"),
    path.join(modulesRoot, "licensing/core/src/cpp/generated/sds"),
    path.join(modulesRoot, "common"),
    path.join(nodeRoot, "vendor"),
    path.join(modulesRoot, "propagator/sgp4-xp/src"),
  ].map((directory) => `-I${directory}`);
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
  await run(toolchain.clangxx, [
    ...compileFlags,
    ...includeArgs,
    "-c",
    sourcePath,
    "-o",
    objectPath,
  ]);

  // The SGP4-XP fit engine: ERFA, foundation/frames and propagator/sgp4-xp's engine headers as one translation unit with
  // no SDS record in it (this node's SDS pin is not that module's), compiled with the node's flags.
  const engine = await composeEngineSource();
  const engineSourcePath = path.join(buildRoot, "xp_engine.cpp");
  const engineObjectPath = path.join(unsignedRoot, "xp_engine.o");
  await writeFile(engineSourcePath, engine.source);
  await run(toolchain.clangxx, [
    ...compileFlags,
    "-c",
    engineSourcePath,
    "-o",
    engineObjectPath,
  ]);

  const exportedSymbols = [
    "plugin_get_manifest_flatbuffer",
    "plugin_get_manifest_flatbuffer_size",
    "plugin_invoke_stream",
    "plugin_alloc",
    "plugin_free",
    "fit",
  ];
  // The memory is exported only for the join below, which resolves the engine's imports of the Space Force library
  // against it; the join removes the export again.
  await run(toolchain.clangxx, [
    ...toolchain.toolchainArgs,
    objectPath,
    engineObjectPath,
    fitCoreObject,
    path.join(compilation.tempDir, "plugin-manifest-exports.o"),
    path.join(compilation.tempDir, "plugin-invoke-bridge.o"),
    "-O3",
    "-mexec-model=reactor",
    ...PTHREAD_FINAL_LINK_FLAGS,
    "-Wl,--export-memory",
    "-Wl,--allow-undefined",
    ...exportedSymbols.map((symbol) => `-Wl,--export=${symbol}`),
    "-o",
    linkedPath,
  ]);

  // The Space Force Sgp4Prop build joins the node here: its code is merged into the module, its memory becomes
  // the second, and what is left imports what the node imported (WASI, the thread spawn, the shared memory).
  const linkedExports = exportNames(new Uint8Array(await readFile(linkedPath)));
  const joined = await joinUssf({
    adapterPath: linkedPath,
    workDir: unsignedRoot,
    keepExports: new Set(linkedExports.map((e) => e.name).filter((name) => name !== "memory")),
  });
  let wasmBytes = appendWasmCustomSection(
    joined.bytes,
    "ussf-sgp4-notice",
    new TextEncoder().encode(await ussfNotice()),
  );
  wasmBytes = appendWasmCustomSection(
    wasmBytes,
    SDS_MANIFEST_SECTION_NAME,
    encodePluginManifest(manifest),
  );
  assertPthreadArtifact(wasmBytes, { source: linkedPath });
  const unsignedPath = path.join(unsignedRoot, "module.wasm");
  await writeFile(unsignedPath, wasmBytes);
  const report = await validateArtifactWithStandards({
    manifest,
    wasmPath: unsignedPath,
    catalog: [await catalogEntry("FSB"), await catalogEntry("FSO")],
    standardsRoot,
  });
  if (!report.ok) {
    throw new Error(
      `OD artifact failed SDK validation:\n${JSON.stringify(report.issues, null, 2)}`,
    );
  }

  const executableBytes = await compileUniversalAot({
    wasmBytes,
    stagingDirectory: unsignedRoot,
    mode: "child",
    productionMode: productionMode || !developmentOnly,
  });
  assertPthreadArtifact(executableBytes, { source: "WasmEdge universal-AOT OD" });
  const signed = await signModuleArtifact(executableBytes, {
    privateKeySeedHex: signingSeed,
    keyId: signingKeyId,
    signatureScope: "bundle",
  });
  const artifactPath = path.join(distRoot, "module.wasm");
  await writeFile(artifactPath, signed.wasmBytes);
  const sha256 = createHash("sha256").update(signed.wasmBytes).digest("hex");
  await writeFile(
    path.join(distRoot, "artifact.json"),
    `${JSON.stringify(
      {
        sha256,
        canonicalModuleHash: signed.canonicalModuleHashHex,
        signedHash: signed.signedHashHex,
        signatureScope: "bundle",
        keyId: signingKeyId,
      },
      null,
      2,
    )}\n`,
  );
  if (!verificationRoot) {
    await writeFile(
      path.join(nodeRoot, "publisher.json"),
      `${JSON.stringify(
        {
          algorithm: "ed25519",
          keyId: signingKeyId,
          publicKeyHex: signed.signature.publicKeyHex,
          developmentOnly,
        },
        null,
        2,
      )}\n`,
    );
  }
  process.stdout.write(
    `Built signed ${manifest.pluginId} ${sha256} (${signed.wasmBytes.byteLength} bytes)\n`,
  );
} finally {
  await cleanupCompilation(compilation);
  await rm(unsignedRoot, { recursive: true, force: true });
}

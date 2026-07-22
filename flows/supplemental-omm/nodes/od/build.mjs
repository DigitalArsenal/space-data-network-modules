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
  cleanupCompilation,
  compileModuleFromSource,
} from "space-data-module-sdk/compiler";
import { validateArtifactWithStandards } from "../../../../node_modules/space-data-module-sdk/src/compliance/index.js";
import { SDS_MANIFEST_SECTION_NAME } from "../../../../node_modules/space-data-module-sdk/src/bundle/constants.js";
import { appendWasmCustomSection } from "../../../../node_modules/space-data-module-sdk/src/bundle/wasm.js";
import {
  assertPthreadArtifact,
  PTHREAD_FINAL_LINK_FLAGS,
} from "../../../../node_modules/space-data-module-sdk/src/compiler/pthreadArtifactGuard.js";
import { resolveWasiThreadsToolchain } from "../../../../node_modules/space-data-module-sdk/src/compiler/wasiThreadsToolchain.js";

import { manifest } from "./manifest.mjs";
import { resolveSupplementalSigning } from "../signing.mjs";

const execFileAsync = promisify(execFile);
const nodeRoot = path.dirname(fileURLToPath(import.meta.url));
const modulesRoot = path.resolve(nodeRoot, "../../../..");
const mainPackagesRoot = path.dirname(modulesRoot);
const standardsRoot = path.join(mainPackagesRoot, "spacedatastandards.org");
const flatbuffersRoot = path.join(mainPackagesRoot, "flatbuffers");
const sdkRoot = path.join(mainPackagesRoot, "..", "ancillary-packages", "space-data-module-sdk");
const buildRoot = path.join(nodeRoot, ".build");
const unsignedRoot = path.join(nodeRoot, "dist/.unsigned");
const distRoot = path.join(nodeRoot, "dist/isomorphic");
const generatedFsbRoot = path.join(buildRoot, "FSB");
const generatedFsoRoot = path.join(buildRoot, "FSO");
const resultSchemaHeader = path.join(buildRoot, "result_schema_idl.h");
const manifestPath = path.join(nodeRoot, "plugin-manifest.json");
const sourcePath = path.join(nodeRoot, "src/node.cpp");
const fitCoreObject = path.join(nodeRoot, "vendor/od-fit-core.o");
const fitCoreObjectSha256 =
  "7ebc7409148e085759c976ae07f01c378b2f4f5a3662bd21a7c9b6ed6608782e";
const developmentSigningSeed = "55".repeat(32);
const { signingSeed, signingKeyId, developmentOnly } =
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
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(
  resultSchemaHeader,
  resultSchemaHeaderSource(await flattenResultSchemaIdl()),
);

await run(path.join(flatbuffersRoot, "build/flatc"), [
  "--no-warnings",
  "--cpp",
  "--aligned",
  "-o",
  generatedFsbRoot,
  path.join(standardsRoot, "schema/FSB/main.fbs"),
]);
await run(path.join(flatbuffersRoot, "build/flatc"), [
  "--no-warnings",
  "--cpp",
  "-o",
  generatedFsbRoot,
  path.join(standardsRoot, "schema/FSB/main.fbs"),
]);
await run(path.join(flatbuffersRoot, "build/flatc"), [
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

  const exportedSymbols = [
    "plugin_get_manifest_flatbuffer",
    "plugin_get_manifest_flatbuffer_size",
    "plugin_invoke_stream",
    "plugin_alloc",
    "plugin_free",
    "fit",
  ];
  await run(toolchain.clangxx, [
    ...toolchain.toolchainArgs,
    objectPath,
    fitCoreObject,
    path.join(compilation.tempDir, "plugin-manifest-exports.o"),
    path.join(compilation.tempDir, "plugin-invoke-bridge.o"),
    "-O3",
    "-mexec-model=reactor",
    ...PTHREAD_FINAL_LINK_FLAGS,
    "-Wl,--allow-undefined",
    ...exportedSymbols.map((symbol) => `-Wl,--export=${symbol}`),
    "-o",
    linkedPath,
  ]);

  let wasmBytes = new Uint8Array(await readFile(linkedPath));
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

  const signed = await signModuleArtifact(wasmBytes, {
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
  process.stdout.write(
    `Built signed ${manifest.pluginId} ${sha256} (${signed.wasmBytes.byteLength} bytes)\n`,
  );
} finally {
  await cleanupCompilation(compilation);
  await rm(unsignedRoot, { recursive: true, force: true });
}

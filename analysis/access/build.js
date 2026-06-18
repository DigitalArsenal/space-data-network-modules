#!/usr/bin/env node

import fs from "fs";
import path from "path";
import process from "node:process";
import crypto from "crypto";
import os from "node:os";
import { fileURLToPath } from "url";
import {
  getInvokeCppSchemaHeaders,
  protectModuleArtifact,
} from "space-data-module-sdk/compiler";
import { writeEmbeddedManifestArtifacts } from "space-data-module-sdk/manifest";

import { shouldRebuild, writeBuildHash } from "../../../OrbPro/packages/orbpro-integration/build-cache.js";
import { requireFlatbuffersCppInclude } from "../../../OrbPro/packages/orbpro-integration/flatbuffers-include.js";
import {
  compileSourceObjects,
  createEmscriptenSetting,
  describePreferredEmscriptenBackend,
  formatEmscriptenBareList,
  linkEmscriptenArtifact,
  readEmceptionFile,
  withEmceptionWorkspace,
} from "../../../OrbPro/scripts/sdn-emception-build.js";
import { normalizeNodeEsmLoader } from "../../../OrbPro/packages/orbpro-integration/protected-loader-hardening.js";
import {
  ACCESS_MANIFEST_BYTES_SYMBOL,
  ACCESS_MANIFEST_SIZE_SYMBOL,
  createAccessPluginManifest,
  createLegacyBuildManifest,
} from "./manifest.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ORBPRO_ROOT = path.resolve(__dirname, "../../../OrbPro");
const DIST_DIR = path.join(__dirname, "dist");
const BROWSER_DIST_DIR = path.join(DIST_DIR, "browser");
const ISOMORPHIC_DIST_DIR = path.join(DIST_DIR, "isomorphic");
const MANIFEST_JSON_PATH = path.join(__dirname, "manifest.json");
const DIST_MANIFEST_JSON_PATH = path.join(DIST_DIR, "manifest.json");
const PLUGIN_SDK_INCLUDE = path.join(
  ORBPRO_ROOT,
  "packages/orbpro-integration/sdk/include",
);
const STACK_FLATBUFFERS_INCLUDE = path.resolve(
  __dirname,
  "../../../flatbuffers/include",
);
const SDS_ACW_CPP_HEADER = path.resolve(
  __dirname,
  "../../../spacedatastandards.org/lib/cpp/ACW/main_generated.h",
);

async function writeInvokeSchemaHeaders(outputDir) {
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });
  const generatedHeaders = await getInvokeCppSchemaHeaders();
  for (const [relativePath, content] of Object.entries(generatedHeaders)) {
    const targetPath = path.join(outputDir, relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, content, "utf8");
  }
  fs.copyFileSync(SDS_ACW_CPP_HEADER, path.join(outputDir, "ACW_generated.h"));
}

function stripTrailingWhitespace(source) {
  return source.replace(/[ \t]+$/gm, "");
}

async function build() {
  const force = process.argv.includes("--force");

  if (!shouldRebuild(__dirname, { noEncrypt: true, force })) {
    console.log(
      `[${path.basename(__dirname)}] Sources unchanged — skipping build.`,
    );
    return;
  }

  fs.mkdirSync(DIST_DIR, { recursive: true });
  fs.mkdirSync(BROWSER_DIST_DIR, { recursive: true });
  fs.mkdirSync(ISOMORPHIC_DIST_DIR, { recursive: true });

  const pluginManifest = createAccessPluginManifest();
  const embeddedManifestArtifacts = writeEmbeddedManifestArtifacts({
    manifest: pluginManifest,
    outputDir: DIST_DIR,
    bytesSymbol: ACCESS_MANIFEST_BYTES_SYMBOL,
    sizeSymbol: ACCESS_MANIFEST_SIZE_SYMBOL,
  });
  const generatedInvokeHeaderDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "access-invoke-headers-"),
  );
  await writeInvokeSchemaHeaders(generatedInvokeHeaderDir);

  const exportedFunctions = [
    "_plugin_init",
    "_plugin_destroy",
    "_access_reset_ground_stations",
    "_access_add_ground_station",
    "_access_set_ground_station_blackouts",
    "_access_get_ground_station_count",
    "_access_get_ground_station_record",
    "_access_get_ground_station_blackout_count",
    "_access_get_ground_station_blackout_record",
    "_access_compute_access_windows",
    "_access_compute_access_windows_with_elevation_mask",
    "_access_compute_access_windows_with_effects",
    "_access_schedule_contacts",
    "_plugin_alloc",
    "_plugin_free",
    "_plugin_get_manifest_flatbuffer",
    "_plugin_get_manifest_flatbuffer_size",
    "_plugin_invoke_stream",
    `_${ACCESS_MANIFEST_BYTES_SYMBOL}`,
    `_${ACCESS_MANIFEST_SIZE_SYMBOL}`,
    "_malloc",
    "_free",
  ];

  const srcDir = path.join(__dirname, "src");
  const flatbuffersCppInclude = requireFlatbuffersCppInclude(process.env, [
    STACK_FLATBUFFERS_INCLUDE,
  ]);
  const wasmPath = path.join(DIST_DIR, "access.wasm");
  const loaderPath = path.join(DIST_DIR, "access.mjs");
  const bytesModulePath = path.join(DIST_DIR, "access-binary.js");
  const publicationRecordsPath = path.join(
    DIST_DIR,
    "access.publication-records.fb",
  );

  console.log(
    `Compiling Access plugin with ${describePreferredEmscriptenBackend()}...`,
  );

  try {
    await withEmceptionWorkspace(
      "space-data-network-modules/analysis/access",
      async (workspace) => {
    const { session, workDir, stageHostDirectory, stageHostFile } = workspace;
    const stagedSrcDir = path.posix.join(workDir, "src");
    const stagedGeneratedDir = path.posix.join(workDir, "generated");
    const stagedIncludeDir = path.posix.join(workDir, "include");
    const stagedIntegrationSdkInclude = path.posix.join(
      stagedIncludeDir,
      "integration-sdk",
    );
    const stagedFlatbuffersInclude = path.posix.join(
      stagedIncludeDir,
      "flatbuffers",
    );
    const stagedManifestSource = path.posix.join(
      stagedGeneratedDir,
      path.basename(embeddedManifestArtifacts.sourcePath),
    );
    const stagedOutputDir = path.posix.join(workDir, "out");

    await stageHostDirectory(srcDir, stagedSrcDir);
    await stageHostDirectory(PLUGIN_SDK_INCLUDE, stagedIntegrationSdkInclude);
    await stageHostDirectory(flatbuffersCppInclude, stagedFlatbuffersInclude);
    await stageHostDirectory(generatedInvokeHeaderDir, stagedGeneratedDir);
    await stageHostFile(
      embeddedManifestArtifacts.sourcePath,
      stagedManifestSource,
    );
    await session.mkdirTree(stagedOutputDir);

    const objectPaths = await compileSourceObjects({
      session,
      workDir,
      workspace,
      stagedSources: [
        {
          path: path.posix.join(stagedSrcDir, "access_plugin.cpp"),
          compiler: "em++",
        },
        {
          path: stagedManifestSource,
          compiler: "em++",
        },
      ],
      includeDirs: [
        stagedFlatbuffersInclude,
        stagedIntegrationSdkInclude,
        stagedGeneratedDir,
        stagedSrcDir,
      ],
      compileFlags: ["-O3", "-std=c++17", "-Wno-dangling-else", "-Wno-format"],
    });

    await linkEmscriptenArtifact({
      session,
      linker: "em++",
      objectPaths,
      linkFlags: [
        ...createEmscriptenSetting("WASM", 1),
        ...createEmscriptenSetting("MODULARIZE", 1),
        ...createEmscriptenSetting("EXPORT_ES6", 1),
        ...createEmscriptenSetting("ENVIRONMENT", "web,worker,node"),
        ...createEmscriptenSetting("ALLOW_MEMORY_GROWTH", 1),
        ...createEmscriptenSetting("INITIAL_MEMORY", 16777216),
        ...createEmscriptenSetting("MAXIMUM_MEMORY", 268435456),
        ...createEmscriptenSetting("NO_EXIT_RUNTIME", 1),
        ...createEmscriptenSetting("FILESYSTEM", 0),
        ...createEmscriptenSetting(
          "EXPORTED_FUNCTIONS",
          formatEmscriptenBareList(exportedFunctions),
        ),
        "--no-entry",
      ],
      outputPath: path.posix.join(stagedOutputDir, "access.mjs"),
    });

    let loaderSource = await readEmceptionFile(
      session,
      path.posix.join(stagedOutputDir, "access.mjs"),
      { encoding: "utf8" },
    );
    loaderSource = stripTrailingWhitespace(normalizeNodeEsmLoader(loaderSource));
    fs.writeFileSync(loaderPath, loaderSource, "utf8");
    fs.writeFileSync(
      wasmPath,
      Buffer.from(
        await readEmceptionFile(
          session,
          path.posix.join(stagedOutputDir, "access.wasm"),
        ),
      ),
    );
    },
    );
  } finally {
    fs.rmSync(generatedInvokeHeaderDir, { recursive: true, force: true });
  }

  const wasmBinary = fs.readFileSync(wasmPath);
  const publication = await protectModuleArtifact({
    wasmBytes: new Uint8Array(wasmBinary),
    manifest: pluginManifest,
    artifactId: "access-runtime",
  });
  fs.writeFileSync(
    publicationRecordsPath,
    Buffer.from(publication.publicationRecordsBytes),
  );
  fs.copyFileSync(wasmPath, path.join(ISOMORPHIC_DIST_DIR, "module.wasm"));
  fs.copyFileSync(wasmPath, path.join(BROWSER_DIST_DIR, "module.wasm"));
  fs.copyFileSync(loaderPath, path.join(BROWSER_DIST_DIR, "module.js"));
  const wasmBase64 = Buffer.from(wasmBinary).toString("base64");
  fs.writeFileSync(
    bytesModulePath,
    `export const wasmBase64 = "${wasmBase64}";\n`,
    "utf8",
  );

  const wasmHash = crypto.createHash("sha256").update(wasmBinary).digest("hex");
  const legacyBuildManifest = createLegacyBuildManifest({
    manifest: pluginManifest,
    encrypted: false,
    requiresProtection: false,
    wasmHash,
    exportedFunctions,
    bytesSymbol: ACCESS_MANIFEST_BYTES_SYMBOL,
    sizeSymbol: ACCESS_MANIFEST_SIZE_SYMBOL,
  });
  legacyBuildManifest.publication = {
    envelope: "sds-rec",
    payloadFile: "access.wasm",
    recordCollectionFile: "access.publication-records.fb",
    recordTypes: ["PNM"],
    payloadEncrypted: false,
  };
  const json = `${JSON.stringify(legacyBuildManifest, null, 2)}\n`;
  fs.writeFileSync(MANIFEST_JSON_PATH, json, "utf8");
  fs.writeFileSync(DIST_MANIFEST_JSON_PATH, json, "utf8");

  writeBuildHash(__dirname, { noEncrypt: true });

  console.log("Build complete.");
  console.log(`  WASM: ${wasmPath} (${wasmBinary.length} bytes)`);
  console.log(`  Hash: ${wasmHash}`);
  console.log(`  Manifest: ${DIST_MANIFEST_JSON_PATH}`);
}

build().catch((error) => {
  console.error("Access build failed:", error);
  process.exit(1);
});

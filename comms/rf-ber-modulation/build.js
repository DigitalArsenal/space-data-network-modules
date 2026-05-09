#!/usr/bin/env node
//
// rf-ber-modulation build pipeline. Mirrors comms/rf-fspl/build.js with renamed
// symbols and an expanded export list (one C entry per model).

import fs from "fs";
import path from "path";
import process from "node:process";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { protectModuleArtifact } from "space-data-module-sdk/compiler";
import { writeEmbeddedManifestArtifacts } from "space-data-module-sdk/manifest";

import { shouldRebuild, writeBuildHash } from "../../../orbpro-integration/build-cache.js";
import { requireFlatbuffersCppInclude } from "../../../orbpro-integration/flatbuffers-include.js";
import {
  compileSourceObjects,
  createEmscriptenSetting,
  describePreferredEmscriptenBackend,
  formatEmscriptenBareList,
  linkEmscriptenArtifact,
  readEmceptionFile,
  withEmceptionWorkspace,
} from "../../../../scripts/sdn-emception-build.js";
import { normalizeNodeEsmLoader } from "../../../orbpro-integration/protected-loader-hardening.js";
import {
  RF_BER_MANIFEST_BYTES_SYMBOL,
  RF_BER_MANIFEST_SIZE_SYMBOL,
  createRfBerModulationPluginManifest,
  createLegacyBuildManifest,
} from "./manifest.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const DIST_DIR = path.join(__dirname, "dist");
const BROWSER_DIST_DIR = path.join(DIST_DIR, "browser");
const ISOMORPHIC_DIST_DIR = path.join(DIST_DIR, "isomorphic");
const MANIFEST_JSON_PATH = path.join(__dirname, "manifest.json");
const DIST_MANIFEST_JSON_PATH = path.join(DIST_DIR, "manifest.json");
const PLUGIN_SDK_INCLUDE = path.join(
  REPO_ROOT,
  "packages/orbpro-integration/sdk/include",
);

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

  const pluginManifest = createRfBerModulationPluginManifest();
  const embeddedManifestArtifacts = writeEmbeddedManifestArtifacts({
    manifest: pluginManifest,
    outputDir: DIST_DIR,
    bytesSymbol: RF_BER_MANIFEST_BYTES_SYMBOL,
    sizeSymbol: RF_BER_MANIFEST_SIZE_SYMBOL,
  });

  const exportedFunctions = [
    "_plugin_init",
    "_plugin_destroy",
    "_rf_erfc",
    "_rf_ber_from_ebno",
    `_${RF_BER_MANIFEST_BYTES_SYMBOL}`,
    `_${RF_BER_MANIFEST_SIZE_SYMBOL}`,
    "_malloc",
    "_free",
  ];

  const srcDir = path.join(__dirname, "src");
  const flatbuffersCppInclude = requireFlatbuffersCppInclude();
  const wasmPath = path.join(DIST_DIR, "rf-ber-modulation.wasm");
  const loaderPath = path.join(DIST_DIR, "rf-ber-modulation.mjs");
  const bytesModulePath = path.join(DIST_DIR, "rf-ber-modulation-binary.js");
  const publicationRecordsPath = path.join(
    DIST_DIR,
    "rf-ber-modulation.publication-records.fb",
  );

  console.log(
    `Compiling rf-ber-modulation plugin with ${describePreferredEmscriptenBackend()}...`,
  );

  await withEmceptionWorkspace(
    "space-data-network-modules/comms/rf-ber-modulation",
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
            path: path.posix.join(stagedSrcDir, "rf_ber_modulation_plugin.cpp"),
            compiler: "em++",
          },
          { path: stagedManifestSource, compiler: "em++" },
        ],
        includeDirs: [
          stagedFlatbuffersInclude,
          stagedIntegrationSdkInclude,
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
          ...createEmscriptenSetting("INITIAL_MEMORY", 1048576),
          ...createEmscriptenSetting("MAXIMUM_MEMORY", 16777216),
          ...createEmscriptenSetting("NO_EXIT_RUNTIME", 1),
          ...createEmscriptenSetting("FILESYSTEM", 0),
          ...createEmscriptenSetting(
            "EXPORTED_FUNCTIONS",
            formatEmscriptenBareList(exportedFunctions),
          ),
          "--no-entry",
        ],
        outputPath: path.posix.join(stagedOutputDir, "rf-ber-modulation.mjs"),
      });

      let loaderSource = await readEmceptionFile(
        session,
        path.posix.join(stagedOutputDir, "rf-ber-modulation.mjs"),
        { encoding: "utf8" },
      );
      loaderSource = normalizeNodeEsmLoader(loaderSource);
      fs.writeFileSync(loaderPath, loaderSource, "utf8");
      fs.writeFileSync(
        wasmPath,
        Buffer.from(
          await readEmceptionFile(
            session,
            path.posix.join(stagedOutputDir, "rf-ber-modulation.wasm"),
          ),
        ),
      );
    },
  );

  const wasmBinary = fs.readFileSync(wasmPath);
  const publication = await protectModuleArtifact({
    wasmBytes: new Uint8Array(wasmBinary),
    manifest: pluginManifest,
    artifactId: "rf-ber-modulation-runtime",
  });
  fs.writeFileSync(
    publicationRecordsPath,
    Buffer.from(publication.publicationRecordsBytes),
  );
  fs.writeFileSync(wasmPath, Buffer.from(publication.protectedArtifactBytes));
  fs.copyFileSync(wasmPath, path.join(ISOMORPHIC_DIST_DIR, "module.wasm"));
  fs.copyFileSync(wasmPath, path.join(BROWSER_DIST_DIR, "module.wasm"));
  fs.copyFileSync(loaderPath, path.join(BROWSER_DIST_DIR, "module.js"));
  const wasmBase64 = Buffer.from(publication.protectedArtifactBytes).toString(
    "base64",
  );
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
    bytesSymbol: RF_BER_MANIFEST_BYTES_SYMBOL,
    sizeSymbol: RF_BER_MANIFEST_SIZE_SYMBOL,
  });
  legacyBuildManifest.publication = {
    envelope: "sds-rec",
    payloadFile: "rf-ber-modulation.wasm",
    recordCollectionFile: "rf-ber-modulation.publication-records.fb",
    recordTypes: ["PNM"],
    payloadEncrypted: false,
  };
  const json = `${JSON.stringify(legacyBuildManifest, null, 2)}\n`;
  fs.writeFileSync(MANIFEST_JSON_PATH, json, "utf8");
  fs.writeFileSync(DIST_MANIFEST_JSON_PATH, json, "utf8");

  writeBuildHash(__dirname, { noEncrypt: true });

  console.log("rf-ber-modulation build complete.");
  console.log(`  WASM: ${wasmPath} (${wasmBinary.length} bytes)`);
  console.log(`  Hash: ${wasmHash}`);
  console.log(`  Manifest: ${DIST_MANIFEST_JSON_PATH}`);
}

build().catch((error) => {
  console.error("rf-ber-modulation build failed:", error);
  process.exit(1);
});

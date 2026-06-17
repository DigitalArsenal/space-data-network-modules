#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  appendWasmCustomSection,
  SDS_MANIFEST_SECTION_NAME,
  stripWasmCustomSections,
} from "space-data-module-sdk/bundle";
import { encodePlgManifest, legacyManifestToPlg } from "space-data-module-sdk/manifest";

const __dirname = dirname(fileURLToPath(import.meta.url));

const wasmFiles = process.argv.slice(2);
if (wasmFiles.length === 0) {
  throw new Error("Usage: embed-manifest-section.mjs <wasm-file> [...wasm-file]");
}

const manifestJson = JSON.parse(
  await readFile(resolve(__dirname, "plugin-manifest.json"), "utf8"),
);
const manifestBytes = encodePlgManifest(legacyManifestToPlg(manifestJson));

for (const wasmFile of wasmFiles) {
  const wasmPath = resolve(__dirname, wasmFile);
  const wasmBytes = new Uint8Array(await readFile(wasmPath));
  const withoutExistingManifest = stripWasmCustomSections(
    wasmBytes,
    (section) => section.name === SDS_MANIFEST_SECTION_NAME,
  );
  const embeddedBytes = appendWasmCustomSection(
    withoutExistingManifest,
    SDS_MANIFEST_SECTION_NAME,
    manifestBytes,
  );
  await writeFile(wasmPath, embeddedBytes);
  console.log(`Embedded ${SDS_MANIFEST_SECTION_NAME} in ${wasmFile}`);
}

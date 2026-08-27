import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const sourcePath = path.join(packageRoot, "src", "vcard_projection_module.cpp");
const distRoot = path.join(packageRoot, "dist");
const outputPath = path.join(distRoot, "isomorphic", "module.wasm");
const standardsRoot = process.env.SPACE_DATA_STANDARDS_ROOT
  ?? "/Users/tj/software/spacedatanetwork-stack/repos/main-packages/spacedatastandards.org";

process.env.SPACE_DATA_STANDARDS_ROOT ??= standardsRoot;

// flatc emits every SDS header with the same include guard
// (FLATBUFFERS_GENERATED_MAIN_H_) and a self-named `#include
// "main_generated.h"`; inlining several standards into one translation unit
// requires stripping both (same pattern as data-source/celestrak-parser).
function inlineGeneratedHeader(source) {
  return source
    .replace(/#ifndef FLATBUFFERS_GENERATED_MAIN_H_\s*\n#define FLATBUFFERS_GENERATED_MAIN_H_\s*\n/, "")
    .replace(/#include "main_generated\.h"\s*\n/g, "")
    .replace(/#endif\s*\/\/ FLATBUFFERS_GENERATED_MAIN_H_\s*$/, "");
}

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
// The vCard projection inlines only $EPM — the record whose fields it
// projects to vCard 3.0 text. No other SDS standard is needed.
const inlineStandards = ["EPM"];
const headers = await Promise.all(
  inlineStandards.map((standard) =>
    fs.readFile(path.join(standardsRoot, "lib", "cpp", standard, "main_generated.h"), "utf8"),
  ),
);
const implementationSource = await fs.readFile(sourcePath, "utf8");
const sourceCode = [...headers.map(inlineGeneratedHeader), implementationSource].join("\n\n");

await fs.rm(distRoot, { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });

const result = await compileModuleFromSource({
  manifest,
  sourceCode,
  language: "c++",
  outputPath,
  threadModel: "wasi-sequential",
});

console.log(`vcard-projection compiled: ${result.wasmPath} (${result.wasmSize} bytes)`);

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const sourcePath = path.join(packageRoot, "src", "nwp_grib2_parser_module.cpp");
const distRoot = path.join(packageRoot, "dist");
const outputPath = path.join(distRoot, "isomorphic", "module.wasm");

// The sibling spacedatastandards.org checkout (the canonical tree that minted $WXF 1.238.0 and its quantized encodings). SPACE_DATA_STANDARDS_ROOT wins when set.
const defaultStandardsRoot = fileURLToPath(new URL("../../../spacedatastandards.org/", import.meta.url));
const standardsRoot = process.env.SPACE_DATA_STANDARDS_ROOT
  ? path.resolve(process.env.SPACE_DATA_STANDARDS_ROOT)
  : defaultStandardsRoot;
process.env.SPACE_DATA_STANDARDS_ROOT = standardsRoot;

function inlineGeneratedHeader(source) {
  return source
    .replace(/#ifndef FLATBUFFERS_GENERATED_MAIN_H_\s*\n#define FLATBUFFERS_GENERATED_MAIN_H_\s*\n/, "")
    .replace(/#include "main_generated\.h"\s*\n/g, "")
    .replace(/#endif\s*\/\/ FLATBUFFERS_GENERATED_MAIN_H_\s*$/, "");
}

// The vendored GRIB2 reader is header-only: inlined, its include guard goes (one translation unit).
function inlineLocalHeader(source) {
  return source.replace(/^#pragma once\s*$/m, "").replace(/^#include "[a-z0-9_]+\.hpp"\s*$/gm, "");
}

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const wxf = await fs.readFile(path.join(standardsRoot, "lib", "cpp", "WXF", "main_generated.h"), "utf8");
if (!/add_CHUNK_CODECS|add_QUANTIZED_U8/.test(wxf)) {
  throw new Error(`${standardsRoot} predates SDS 1.238.0 ($WXF imager fields): set SPACE_DATA_STANDARDS_ROOT`);
}
const localHeaders = await Promise.all(
  ["grib2mini.hpp"].map((name) => fs.readFile(path.join(packageRoot, "src", name), "utf8")),
);
const implementationSource = await fs.readFile(sourcePath, "utf8");
// The generated $WXF header, the reader and the module.
const sourceCode = [
  inlineGeneratedHeader(wxf),
  ...localHeaders.map(inlineLocalHeader),
  implementationSource,
].join("\n\n");

await fs.rm(distRoot, { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });

const compilation = await compileModuleFromSource({
  manifest,
  sourceCode,
  language: "c++",
  outputPath,
  // THREAD MODEL — declared explicitly, never inferred. parse is a single-pass transform over the frames the flow
  // hands it (manifest sequentialJustification) and never spawns a thread: the single-thread STANDALONE_WASM lane
  // with growable memory, like every other parser node here.
  threadModel: "single-thread",
});

// Persist the prefixed guest-link object + metadata for the flow compiler.
const guestLinkDir = path.join(distRoot, "guest-link");
await fs.mkdir(guestLinkDir, { recursive: true });
await fs.writeFile(path.join(guestLinkDir, "module-link.o"), compilation.guestLink.objectBytes);
await fs.writeFile(
  path.join(guestLinkDir, "metadata.json"),
  `${JSON.stringify(
    {
      version: 1,
      format: compilation.guestLink.format,
      language: compilation.guestLink.language,
      threadModel: compilation.guestLink.threadModel,
      symbolPrefix: compilation.guestLink.symbolPrefix,
      methodSymbols: compilation.guestLink.methodSymbols,
    },
    null,
    2,
  )}\n`,
);

await fs.copyFile(manifestPath, path.join(distRoot, "plugin-manifest.json"));

if (!compilation.report?.ok) {
  const issues = JSON.stringify(compilation.report?.issues ?? [], null, 2);
  throw new Error(`Compiled artifact failed SDK validation:\n${issues}`);
}

console.log(`nwp-grib2-parser compiled -> ${outputPath}`);

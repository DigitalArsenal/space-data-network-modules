import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const sourcePath = path.join(packageRoot, "src", "weathernext_parser_module.cpp");
const distRoot = path.join(packageRoot, "dist");
const outputPath = path.join(distRoot, "isomorphic", "module.wasm");

// The sibling spacedatastandards.org checkout (the canonical tree that minted
// WXF + TCT). SPACE_DATA_STANDARDS_ROOT wins when set.
const defaultStandardsRoot = fileURLToPath(new URL("../../../spacedatastandards.org/", import.meta.url));
const standardsRoot = process.env.SPACE_DATA_STANDARDS_ROOT
  ? path.resolve(process.env.SPACE_DATA_STANDARDS_ROOT)
  : defaultStandardsRoot;
process.env.SPACE_DATA_STANDARDS_ROOT = standardsRoot;

// flatc emits every SDS header with the same include guard
// (FLATBUFFERS_GENERATED_MAIN_H_) and a self-named `#include
// "main_generated.h"` for its include graph (TCT includes WXF); inlining
// several standards into one translation unit requires stripping both (same
// pattern as data-source/celestrak-parser).
function inlineGeneratedHeader(source) {
  return source
    .replace(/#ifndef FLATBUFFERS_GENERATED_MAIN_H_\s*\n#define FLATBUFFERS_GENERATED_MAIN_H_\s*\n/, "")
    .replace(/#include "main_generated\.h"\s*\n/g, "")
    .replace(/#endif\s*\/\/ FLATBUFFERS_GENERATED_MAIN_H_\s*$/, "");
}

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
// Topological order over the flatc include graph: WXF feeds TCT (shared
// model/member/licence enums).
const inlineStandards = ["WXF", "TCT"];
const headers = await Promise.all(
  inlineStandards.map((standard) =>
    fs.readFile(path.join(standardsRoot, "lib", "cpp", standard, "main_generated.h"), "utf8"),
  ),
);
const implementationSource = await fs.readFile(sourcePath, "utf8");
const sourceCode = [...headers.map(inlineGeneratedHeader), implementationSource].join("\n\n");

await fs.rm(distRoot, { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });

const compilation = await compileModuleFromSource({
  manifest,
  sourceCode,
  language: "c++",
  outputPath,
  // THREAD MODEL — declared explicitly, never inferred. This guest is a pure
  // single-pass transform over the frames it is handed (manifest
  // sequentialJustification records why) and provably never spawns a thread,
  // so it compiles on the single-thread STANDALONE_WASM lane like every other
  // flow node (celestrak-parser, satnogs-source, hostcap/*).
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

console.log(`weathernext-parser compiled -> ${outputPath}`);

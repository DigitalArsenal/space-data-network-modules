import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";
import { generateSdsHeader } from "../../scripts/lib/sds-cpp-headers.mjs";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const sourcePath = path.join(packageRoot, "src", "celestrak_reference_module.cpp");
const distRoot = path.join(packageRoot, "dist");
const outputPath = path.join(distRoot, "isomorphic", "module.wasm");
// The SDS checkout that supplies the generated C++ headers: the sibling of
// this repository by default, or SPACE_DATA_STANDARDS_ROOT when the package is
// built from a worktree that has no sibling checkout (as data-source/celestrak-parser).
const standardsRoot =
  process.env.SPACE_DATA_STANDARDS_ROOT ??
  fileURLToPath(new URL("../../../spacedatastandards.org/", import.meta.url));

process.env.SPACE_DATA_STANDARDS_ROOT = standardsRoot;

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
// Topological order over the flatc include graph: RFM/TIM/MET/PVN/CVR feed OMM,
// IDM feeds PLD and SIT, PLD + LCC feed CAT, EGP is standalone, ICN (the job carried in
// HttpRequest.CONTEXT) is standalone. The module-sdk runtime headers (HttpRequest, HttpResponse,
// IngestRequest, FlowNotice, typedHostcall.hpp) are staged by the SDK compiler.
const inlineStandards = ["RFM", "TIM", "MET", "PVN", "CVR", "IDM", "PLD", "LCC", "OMM", "CAT", "EGP", "SIT", "ICN"];
const headers = await Promise.all(
  inlineStandards.map((standard) =>
    generateSdsHeader(standard, import.meta.url),
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
  // THREAD MODEL: wasi-sequential, declared, never inferred (scripts/lib/thread-model.mjs). The guest never spawns a
  // thread (manifest sequentialJustification); clang wasm32-wasip1-threads is the repo's one guest object format, so
  // every flow links its modules' guest-link objects together (graph/checks/flow-link-models.mjs).
  threadModel: "wasi-sequential",
  // Imports the sync space_data_module_host hostcall bridge for the builtin
  // plugin.getConfig (an SDS $PIV hostcall through typedHostcall.hpp); the symbols resolve at instantiation (same lane as
  // celestrak-request and weathernext-source).
  allowUndefinedImports: true,
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

console.log(`celestrak-reference compiled -> ${outputPath}`);

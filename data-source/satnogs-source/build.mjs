import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const sourcePath = path.join(packageRoot, "src", "satnogs_source_module.cpp");
const distRoot = path.join(packageRoot, "dist");
const outputPath = path.join(distRoot, "isomorphic", "module.wasm");

// The sibling spacedatastandards.org checkout. SPACE_DATA_STANDARDS_ROOT wins
// so this builds from a git worktree (where ../../../ is the worktrees dir,
// not repos/main-packages) without editing the file.
const defaultStandardsRoot = fileURLToPath(new URL("../../../spacedatastandards.org/", import.meta.url));
const standardsRoot = process.env.SPACE_DATA_STANDARDS_ROOT
  ? path.resolve(process.env.SPACE_DATA_STANDARDS_ROOT)
  : defaultStandardsRoot;
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
// Topological order over the flatc include graph: LKS (linkCategory) feeds RFB.
const inlineStandards = ["LKS", "RFB"];
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
  // THREAD MODEL — declared explicitly, never inferred.
  //
  // This guest is a pure single-pass transform and provably never spawns a
  // thread (manifest.sequentialJustification records why), so it carries no
  // pthreads contract. It compiles on the SAME single-thread STANDALONE_WASM
  // lane as every other flow node this producer runs (data-source/celestrak-
  // request, data-source/celestrak-parser, hostcap/*): no `-pthread`, no shared
  // memory, growable linear memory, isomorphic across the browser harness and
  // the node's WasmEdge.
  //
  // NOT "wasi-sequential", despite that being the model this guest describes.
  // SDK 0.8.5's wasi-sequential lane emits a SHARED, NON-GROWABLE 2-page
  // (128 KB) memory — it passes no `-Wl,--max-memory`, and on the
  // wasm32-wasip1-threads triple wasm-ld then pins max == initial. Measured:
  // the artifact traps `unreachable` on the 6th emitted record and
  // `memory.grow(1)` throws "Maximum memory size exceeded". The SatNOGS table
  // is ~3.5 MB, so that lane cannot hold one cycle's payload. Filed as an SDK
  // defect for Janus; revisit this line when the sequential lane sizes its
  // memory.
  threadModel: "single-thread",
  // Imports the sync space_data_module_host hostcall bridge for the builtin
  // plugin.getConfig; symbols resolve at instantiation.
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

console.log(`satnogs-source compiled -> ${outputPath}`);

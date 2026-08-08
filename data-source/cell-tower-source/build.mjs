import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const sourcePath = path.join(packageRoot, "src", "cell_tower_source_module.cpp");
const distRoot = path.join(packageRoot, "dist");
const outputPath = path.join(distRoot, "isomorphic", "module.wasm");

// The sibling spacedatastandards.org checkout. SPACE_DATA_STANDARDS_ROOT wins
// so this builds from a git worktree (where ../../../ is the worktrees dir,
// not repos/main-packages) without editing the file.
const defaultStandardsRoot = fileURLToPath(
  new URL("../../../spacedatastandards.org/", import.meta.url),
);
const standardsRoot = process.env.SPACE_DATA_STANDARDS_ROOT
  ? path.resolve(process.env.SPACE_DATA_STANDARDS_ROOT)
  : defaultStandardsRoot;
process.env.SPACE_DATA_STANDARDS_ROOT = standardsRoot;

// flatc emits every SDS header with the same include guard
// (FLATBUFFERS_GENERATED_MAIN_H_) and a self-named `#include
// "main_generated.h"`; inlining a standard into the translation unit requires
// stripping both (same pattern as data-source/satnogs-source).
function inlineGeneratedHeader(source) {
  return source
    .replace(
      /#ifndef FLATBUFFERS_GENERATED_MAIN_H_\s*\n#define FLATBUFFERS_GENERATED_MAIN_H_\s*\n/,
      "",
    )
    .replace(/#include "main_generated\.h"\s*\n/g, "")
    .replace(/#endif\s*\/\/ FLATBUFFERS_GENERATED_MAIN_H_\s*$/, "");
}

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));

// $TBS is self-contained: its two nested tables and both enums live in the same
// schema, so unlike the RFB build there is no include graph to topologically
// order here.
const inlineStandards = ["TBS"];
const headers = await Promise.all(
  inlineStandards.map((standard) =>
    fs.readFile(
      path.join(standardsRoot, "lib", "cpp", standard, "main_generated.h"),
      "utf8",
    ),
  ),
);
const implementationSource = await fs.readFile(sourcePath, "utf8");
const sourceCode = [
  ...headers.map(inlineGeneratedHeader),
  implementationSource,
].join("\n\n");

await fs.rm(distRoot, { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });

const compilation = await compileModuleFromSource({
  manifest,
  sourceCode,
  language: "c++",
  outputPath,
  // THREAD MODEL — declared explicitly, never inferred.
  //
  // All three methods are pure single-pass transforms and this guest provably
  // never spawns a thread (manifest.sequentialJustification records why), so it
  // carries no pthreads contract. Same single-thread STANDALONE_WASM lane every
  // other flow node in this producer uses (data-source/satnogs-source,
  // data-source/celestrak-*, hostcap/*): no `-pthread`, no shared memory,
  // growable linear memory, isomorphic across the browser harness and WasmEdge.
  //
  // NOT "wasi-sequential", for the reason satnogs-source recorded: that lane
  // emits a SHARED, NON-GROWABLE 2-page (128 KB) memory, which cannot hold a
  // provider table. This module aggregates SEVERAL provider bodies at once, so
  // it needs growable memory even more than satnogs does. Revisit when the SDK
  // sequential lane sizes its memory (Janus).
  threadModel: "single-thread",
  // Imports the sync space_data_module_host hostcall bridge; symbols resolve at
  // instantiation.
  allowUndefinedImports: true,
});

// The compiler writes `outputPath` itself; it does not hand back bytes.
await fs.copyFile(manifestPath, path.join(distRoot, "plugin-manifest.json"));

if (!compilation.report?.ok) {
  const issues = JSON.stringify(compilation.report?.issues ?? [], null, 2);
  throw new Error(`Compiled artifact failed SDK validation:\n${issues}`);
}

console.log(`cell-tower-source compiled -> ${outputPath}`);

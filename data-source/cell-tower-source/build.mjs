import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";

import { minizSourceFragments } from "./miniz-source.mjs";

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

// ZIP INFLATE for the national bulk archives (ACMA/ISED/ANFR ship one ZIP
// each). Vendored miniz 3.1.2, SHA-256 pinned per file and re-verified on every
// build by miniz-source.mjs — the same sanctioned pattern
// flows/supplemental-omm/nodes/providers/starlink uses, deliberately reused
// rather than hand-rolling a second inflate in this repo.
//
// The fragments are PREPENDED to the translation unit (miniz.h then miniz.c),
// exactly as build-provider.mjs orders them, because the module's decoders call
// tinfl_* at namespace scope below.
//
// They define MINIZ_NO_ARCHIVE_APIS, so mz_zip_* does NOT exist here and the
// module walks the central directory itself (zip_find_member). That is not a
// workaround: mz_zip_reader_extract_to_heap materialises a whole member, and
// ISED's single member inflates to 428 MB against a 128 MB ceiling that already
// holds a 64 MB compressed body. tinfl_* survives the define (it is gated by
// MINIZ_NO_INFLATE_APIS, which is not set) and is what the 32 KiB streaming
// window uses.
const minizFragments = await minizSourceFragments();

const sourceCode = [
  ...headers.map(inlineGeneratedHeader),
  ...minizFragments,
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

// Persist the prefixed guest-link object + metadata for the flow compiler.
// Without this the flow bake refuses the module: a linked-direct node is
// STATICALLY LINKED into the composed runtime, so the compiler needs the
// relocatable object, not just the standalone wasm.
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
await fs.copyFile(manifestPath, path.join(guestLinkDir, "plugin-manifest.json"));

// The compiler writes `outputPath` itself; it does not hand back bytes.
await fs.copyFile(manifestPath, path.join(distRoot, "plugin-manifest.json"));

if (!compilation.report?.ok) {
  const issues = JSON.stringify(compilation.report?.issues ?? [], null, 2);
  throw new Error(`Compiled artifact failed SDK validation:\n${issues}`);
}

console.log(`cell-tower-source compiled -> ${outputPath}`);

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const sourcePath = path.join(packageRoot, "src", "cell_tower_ingest_module.cpp");
const distRoot = path.join(packageRoot, "dist");
const outputPath = path.join(distRoot, "isomorphic", "module.wasm");
// THE STANDARDS ROOT IS ONE DECISION, NOT TWO.
//
// The compiler already honours SPACE_DATA_STANDARDS_ROOT; the $IRM header read
// below did not, and resolved a fixed sibling path instead. In a per-task
// worktree that sibling is ANOTHER LANE'S checkout — this build silently
// inlined $IRM from a tree at an unrelated revision, mid-regeneration, and
// then failed outright when that lane deleted its generated headers. A build
// that compiles against whatever happens to be next door on disk is not
// reproducible, and its artifact cannot be attributed to any pin.
const standardsRoot =
  process.env.SPACE_DATA_STANDARDS_ROOT ??
  fileURLToPath(new URL("../../../spacedatastandards.org/", import.meta.url));

process.env.SPACE_DATA_STANDARDS_ROOT = standardsRoot;

// $IRM (Ingest Resume Mark) is INLINED INTO THE TRANSLATION UNIT.
//
// The durable resume mark is a schema-typed SDS record now that Themis has
// minted and ratified $IRM (spacedatastandards.org 1.196.0), so this plugin
// both WRITES one (publish_request) and READS one back (ingest_plan,
// cache_freshness, the tile lane). Hand-decoding two doubles out of a $TBS row
// is one thing; hand-BUILDING a record with three nested tables, two ubyte
// vectors and a string vector is another, and getting a vtable wrong there
// produces a mark that stores cleanly and resumes into nonsense.
//
// flatc emits every SDS header with the same include guard
// (FLATBUFFERS_GENERATED_MAIN_H_) and a self-named `#include
// "main_generated.h"`; inlining a standard requires stripping both. Same
// pattern as data-source/cell-tower-source and data-source/satnogs-source.
//
// $IRM is self-contained: its three nested tables and three enums all live in
// the same schema, so there is no include graph to topologically order.
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
const irmHeader = inlineGeneratedHeader(
  await fs.readFile(path.join(standardsRoot, "lib", "cpp", "IRM", "main_generated.h"), "utf8"),
);
const implementationSource = await fs.readFile(sourcePath, "utf8");
const sourceCode = `${irmHeader}\n${implementationSource}`;

await fs.rm(distRoot, { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });

const compilation = await compileModuleFromSource({
  manifest,
  sourceCode,
  language: "c++",
  outputPath,
  // THREAD MODEL — declared explicitly, never inferred.
  //
  // This node is single-threaded: it spawns nothing, shares nothing, and holds
  // only the frames of the invocation it is serving. The artifact this repo has
  // been shipping already carries `threadModel: single-thread`
  // (dist/guest-link/metadata.json) — it was simply never DECLARED, so it rode
  // the SDK's inference. That inference has since moved to EMSCRIPTEN_PTHREADS
  // for runtimeTargets [browser, wasmedge], at which point the build starts
  // claiming a pthreads contract the emitted wasm does not have and the SDK's
  // isomorphic-pthreads artifact guard correctly REFUSES it ("does not import
  // the wasi thread-spawn host function ... must not ship"). Declaring the truth
  // builds against reality instead of against whatever the SDK last guessed.
  // Same fix, same reasoning as hostcap/http-request (7fefaf4), where the long
  // form of this note lives.
  threadModel: "single-thread",
  // Imports the sync space_data_module_host hostcall bridge for the builtin
  // plugin.getConfig; symbols resolve at instantiation.
  allowUndefinedImports: true,
});

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

console.log(`cell-tower-ingest compiled -> ${outputPath}`);

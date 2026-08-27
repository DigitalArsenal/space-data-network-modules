import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";

import { publishedStandardsRoot, readSdsHeader } from "../terrain-source/sds-headers.mjs";

// The manifest validator and the inlined headers read the SAME package; see
// sds-headers.mjs (publishedStandardsRoot) for why this has to be said out loud.
process.env.SPACE_DATA_STANDARDS_ROOT ??= publishedStandardsRoot(import.meta.url);

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const sourcePath = path.join(packageRoot, "src", "terrain_ingest_module.cpp");
const distRoot = path.join(packageRoot, "dist");
const outputPath = path.join(distRoot, "isomorphic", "module.wasm");

// SDS headers come from the PUBLISHED spacedatastandards.org package this
// module pins; see ../terrain-source/sds-headers.mjs for why, and for what the
// sibling-checkout resolution it replaced got wrong.

// THE DURABLE RESUME MARK IS AN $IRM RECORD, so the $IRM generated header is
// inlined here — the same pattern data-source/cell-tower-ingest uses, and for
// the same reason: the mark travels through the schema-typed storage lane, not
// as ad-hoc JSON on egress, so the module has to author the record.
//
// flatc emits every SDS header with the same include guard
// (FLATBUFFERS_GENERATED_MAIN_H_) and a self-named `#include
// "main_generated.h"`; inlining a standard requires stripping both. $IRM is
// self-contained — its nested tables and enums all live in the one schema — so
// there is no include graph to order.
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
  await readSdsHeader("IRM", import.meta.url),
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

console.log(`terrain-ingest compiled -> ${outputPath}`);

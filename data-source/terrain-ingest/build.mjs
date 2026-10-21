import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { minizSourceFragments } from "../terrain-source/miniz-source.mjs";

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
// Typed contracts 1.0: the job and the durable mark are $IRM, the plan is $DTT header records, the mark is read as
// FlatSQL $FSB chunks and asked for with an $FSO - so all four generated SDS headers are inlined ahead of the module
// (each self-contained; the SDK runtime types - TimerTick, HttpRequest/Response, IngestRequest/Result, FlowNotice,
// ModuleConfig - are staged by the SDK compiler).
// $PNM is the Moon lane's publication record (announce_files).
const headers = await Promise.all(["IRM", "DTT", "FSO", "FSB", "PNM"].map((code) => readSdsHeader(code, import.meta.url)));

// The module's own headers (src/body_plan.hpp) and terrain-source's polar projection (polar_stereo.hpp, so the
// planner and the decoder share one definition of where a tile lies in a polar product) are inlined where the
// implementation includes them.
const includeRoots = [path.join(packageRoot, "src"), path.join(packageRoot, "..", "terrain-source", "src")];
async function inlineLocalIncludes(source) {
  const pattern = /^#include "([a-z_]+\.hpp)"\s*$/m;
  let out = source;
  for (let match = out.match(pattern); match; match = out.match(pattern)) {
    let body = null;
    for (const root of includeRoots) {
      body = await fs.readFile(path.join(root, match[1]), "utf8").catch(() => null);
      if (body !== null) break;
    }
    if (body === null) throw new Error(`no ${match[1]} under ${includeRoots.join(" or ")}`);
    out = out.replace(match[0], () => `// ---- ${match[1]} ----\n${body}\n// ---- end ${match[1]} ----`);
  }
  return out;
}
const implementationSource = await inlineLocalIncludes(await fs.readFile(sourcePath, "utf8"));
const sourceCode = `${headers.map(inlineGeneratedHeader).join("\n")}\n${(await minizSourceFragments()).join("\n")}\n${implementationSource}`;

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

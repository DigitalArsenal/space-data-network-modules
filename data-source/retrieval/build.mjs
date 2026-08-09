import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const sourcePath = path.join(packageRoot, "src", "retrieval_module.cpp");
const distRoot = path.join(packageRoot, "dist");
const outputPath = path.join(distRoot, "isomorphic", "module.wasm");
const standardsRoot = fileURLToPath(new URL("../../../spacedatastandards.org/", import.meta.url));

process.env.SPACE_DATA_STANDARDS_ROOT ??= standardsRoot;

// flatc emits every SDS header with the same include guard
// (FLATBUFFERS_GENERATED_MAIN_H_) and schema includes as a self-named
// `#include "main_generated.h"`. Inlining more than one generated header into
// a single translation unit therefore requires stripping the guard and the
// schema-include line (the flatbuffers runtime include and version
// static_assert are idempotent and stay).
function inlineGeneratedHeader(source) {
  return source
    .replace(/#ifndef FLATBUFFERS_GENERATED_MAIN_H_\s*\n#define FLATBUFFERS_GENERATED_MAIN_H_\s*\n/, "")
    .replace(/#include "main_generated\.h"\s*\n/g, "")
    .replace(/#endif\s*\/\/ FLATBUFFERS_GENERATED_MAIN_H_\s*$/, "");
}

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const [etmHeader, caqHeader, implementationSource] = await Promise.all([
  fs.readFile(path.join(standardsRoot, "lib", "cpp", "ETM", "main_generated.h"), "utf8"),
  fs.readFile(path.join(standardsRoot, "lib", "cpp", "CAQ", "main_generated.h"), "utf8"),
  fs.readFile(sourcePath, "utf8"),
]);
// CAQ includes ETM (CAQResult rows), so ETM types must precede the CAQ header.
const sourceCode = [
  inlineGeneratedHeader(etmHeader),
  inlineGeneratedHeader(caqHeader),
  implementationSource,
].join("\n\n");

await fs.rm(distRoot, { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });

const compilation = await compileModuleFromSource({
  manifest,
  sourceCode,
  language: "c++",
  outputPath,
  // THREAD MODEL — declared, never inferred (scripts/lib/thread-model.mjs
  // holds the full rationale; graph task modules-undeclared-threadmodel-artifacts).
  //
  // Truth of the SHIPPED artifact 56395f977af8… (131571 B, landed 2026-07-03 at
  // SDK pin 2cc72ffc): unshared linear memory, no `wasi.thread-spawn` import, no
  // `wasi_thread_start` export. It carries no wasi-threads contract and never did.
  // dist/guest-link/metadata.json of those bytes says "single-thread", which agrees.
  // Those bytes were produced by INFERENCE: at that era pin the resolver matched
  // `browser` FIRST and returned single-thread. Today `wasmedge` wins and returns
  // emscripten-pthreads, so this build stopped producing bytes at all — the SDK's
  // artifact guard correctly refuses a guest with no thread-spawn import. Declaring
  // the truth makes the lane a property of THIS SOURCE instead of the SDK version.
  threadModel: "single-thread",
  // The module imports the sync space_data_module_host hostcall bridge; those
  // symbols resolve at instantiation (SDK harness bridge / Go node bridge).
  allowUndefinedImports: true,
});

// Persist the prefixed guest-link object + metadata for the flow compiler
// (space-data-module flow compile links these into monolithic linked-direct
// flow artifacts; see SDK src/flow/flowCompiler.js).
async function persistGuestLink(dirName, guestLink) {
  const guestLinkDir = path.join(distRoot, dirName);
  await fs.mkdir(guestLinkDir, { recursive: true });
  await fs.writeFile(path.join(guestLinkDir, "module-link.o"), guestLink.objectBytes);
  await fs.writeFile(
    path.join(guestLinkDir, "metadata.json"),
    `${JSON.stringify(
      {
        version: 1,
        format: guestLink.format,
        language: guestLink.language,
        threadModel: guestLink.threadModel,
        symbolPrefix: guestLink.symbolPrefix,
        methodSymbols: guestLink.methodSymbols,
      },
      null,
      2,
    )}\n`,
  );
}
await persistGuestLink("guest-link", compilation.guestLink);

// Engine-linked variant (loop C.7): the same source compiled
// -DSDN_FLATSQL_LINKED=1 — query submission goes through the flow runtime's
// direct engine-linkage helpers (resolved at flow link time) instead of the
// storage.flatsql_* hostcall bridge. Only its guest-link object ships; the
// standalone module.wasm stays the bridge build (loadable everywhere).
await fs.mkdir(path.join(distRoot, "linked-build"), { recursive: true });
const linkedCompilation = await compileModuleFromSource({
  manifest,
  sourceCode,
  language: "c++",
  outputPath: path.join(distRoot, "linked-build", "module.wasm"),
  // Same declared lane as the primary artifact above — see scripts/lib/thread-model.mjs.
  threadModel: "single-thread",
  allowUndefinedImports: true,
  defines: ["SDN_FLATSQL_LINKED=1"],
});
await persistGuestLink("guest-link-linked", linkedCompilation.guestLink);
await fs.rm(path.join(distRoot, "linked-build"), { recursive: true, force: true });

await fs.copyFile(manifestPath, path.join(distRoot, "plugin-manifest.json"));

if (!compilation.report?.ok) {
  const issues = JSON.stringify(compilation.report?.issues ?? [], null, 2);
  throw new Error(`Compiled artifact failed SDK validation:\n${issues}`);
}

console.log(`Built ${path.relative(packageRoot, outputPath)}`);

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

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
// The "request" / "query" / "decision" / "page" ports carry the SDS standard QRP ($QRP). The SDK compiler stages only its
// runtime headers, so the standard's own generated C++ header (spacedatastandards.org lib/cpp/QRP/main_generated.h) is
// inlined in place of `#include "QRP_generated.h"`: its include guard is renamed (the SDK's sds/PIV header is also
// "main_generated.h") and its flatc version static_assert relaxed, as the SDK does for its runtime headers.
const qrpHeader = (await fs.readFile(path.join(process.env.SPACE_DATA_STANDARDS_ROOT, "lib", "cpp", "QRP", "main_generated.h"), "utf8"))
  .replaceAll("FLATBUFFERS_GENERATED_MAIN_H_", "FLATBUFFERS_GENERATED_SDS_QRP_MAIN_H_")
  .replace(/static_assert\(FLATBUFFERS_VERSION_MAJOR[\s\S]*?\);\n/, "");
const sourceCode = (await fs.readFile(sourcePath, "utf8")).replace(/^#include "QRP_generated\.h".*$/m, () => qrpHeader);

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

await fs.copyFile(manifestPath, path.join(distRoot, "plugin-manifest.json"));

if (!compilation.report?.ok) {
  const issues = JSON.stringify(compilation.report?.issues ?? [], null, 2);
  throw new Error(`Compiled artifact failed SDK validation:\n${issues}`);
}

console.log(`Built ${path.relative(packageRoot, outputPath)}`);
